"use node";

// AI scorer for the "Needs Response" folder. For each inbound email, asks
// Haiku to produce a 0-100 score for whether the user owes a reply, a brief
// reason, and (if present) an extracted deadline. Persists the result to
// `needsResponseSignals`.
//
// Skip rules:
//   - Outbound (from address is one of the user's accounts) — never scored.
//   - Categories `marketing` / `spam` / `notification` — never scored.
//   - Email body too short to judge (< 30 chars) — never scored.
//   - Existing OPEN signal (dismissedAt undefined) — kept, this call is a
//     no-op. Use _rescore to overwrite an open signal explicitly.

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-haiku-4-5-20251001";

// Categories where it's almost never worth asking the model "does this need
// a reply" — saves API tokens and keeps the table tight.
const SKIP_CATEGORIES = new Set([
  "marketing",
  "spam",
  "notification",
]);

const SCORING_PROMPT = `You are a triage assistant for a busy agency owner. Read the LATEST email and decide whether the user owes the sender a reply.

Output ONLY valid JSON with this exact shape:
{"score": 0-100, "reason": "max 80 chars why", "dueBy": "YYYY-MM-DD or null"}

You will receive thread context: the prior 0-3 messages in chronological order, each tagged USER (sent by the user) or THEM (sent by someone else). Use it to detect conversation state.

Scoring rubric (for the LATEST email):
- 90-100: explicit ask, blocked work, or urgent deadline ("can you confirm by Friday", "we're stuck waiting on you", "approve this asap")
- 70-89: clear question or request without explicit urgency ("what do you think?", "let me know if changes")
- 50-69: ambiguous — could go either way; soft FYI that may benefit from acknowledgement
- 20-49: informational, courtesy, or chain of replies where the user already said the last meaningful thing
- 0-19: pure noise, automated, broadcast, or a CLOSURE message ("Thanks!", "Got it", sign-off after the user already handled the ask)

CLOSURE rule (very important):
- If the USER already replied in this thread AND the latest email from THEM is a short acknowledgment / thanks / sign-off / closing courtesy ("Thanks Bryce", "Great, appreciate it", "Sounds good", "Got it"), score AT MOST 15. The conversation is wrapping up — no reply needed.
- A message like that is ONLY higher-scoring if it ALSO contains a new question, ask, or topic change.

Addressee rule:
- You will see a flag "User addressing: DIRECT" or "User addressing: CC-ONLY". If CC-ONLY, the user is just copied — the ask is usually directed at someone else. Score AT MOST 40 UNLESS the body explicitly addresses the user by name (e.g. "Bryce, can you ...") or asks a question that only the user can answer.

Team-internal rule:
- You will see "Sender: INTERNAL teammate" when the sender's domain matches one of the user's mailbox domains. Internal teammates often loop the user in for awareness, not action. Score AT MOST 60 UNLESS the body explicitly names or @mentions the user OR asks a direct question only the user can answer.

Thread-state decay rule:
- If the user has already replied 2+ times in this thread AND the latest email from THEM is just continuation / clarification / context (no NEW question, NEW topic, or NEW deadline), score AT MOST 60. Active back-and-forth should not camp at the top of the list.
- If the latest message simply continues an ongoing exchange (more detail on something already being discussed), it is NOT a new ask — score AT MOST 50.

Calibration from past behavior:
- You may receive up to 5 past dismissals from this sender, each tagged with kind (manual-done = user clicked Done without replying; replied = user handled it; archived = user archived). Multiple recent "manual-done" entries are strong evidence this sender's emails rarely warrant escalation — bias the score DOWN by 10-25 points. Do NOT override an explicit urgent ask.

Other bias rules:
- If the sender is a client/vendor/partner asking a direct question → AT LEAST 70 (subject to the addressee / team-internal ceilings above).
- If the email is automated (build alerts, weekly digests, system notifications) → AT MOST 15.
- If a deadline is mentioned in the future, extract YYYY-MM-DD; otherwise null.

Respond with JSON only. No markdown.`;

// Short acknowledgment-only emails never need a reply. We catch them before
// the AI call to save tokens AND avoid the failure mode where the model
// over-weights the subject/sender and ignores the trivial body.
const ACKNOWLEDGMENT_PATTERNS = [
  /^thanks?(\s+you)?\.?$/i,
  /^thx\.?$/i,
  /^thank you,?\s*\S+\.?$/i, // "Thank you Bryce."
  /^thanks?,?\s*\S+\.?$/i,   // "Thanks Bryce."
  /^thanks?\s+so\s+much\.?$/i,
  /^appreciate\s+(it|you|that)\.?$/i,
  /^got\s+it\.?$/i,
  /^received\.?$/i,
  /^ok(ay)?\.?$/i,
  /^sounds\s+good\.?$/i,
  /^sounds?\s+great\.?$/i,
  /^great,?\s+thanks?\.?$/i,
  /^perfect\.?$/i,
  /^cool\.?$/i,
  /^will\s+do\.?$/i,
  /^noted\.?$/i,
  /^cheers\.?$/i,
  /^awesome\.?$/i,
  /^👍$/,
  /^👌$/,
];

function looksLikeAcknowledgmentOnly(rawBody: string): boolean {
  // Strip signature blocks, links, and surrounding whitespace, then check
  // if the remainder is essentially a 1-line "thanks" message.
  const lines = rawBody
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Walk from the top, stop at the first sign of a signature / quoted
  // content / disclaimer / URL.
  const stopMarkers = [
    /^--\s*$/,
    /^on .{1,50}wrote:?$/i,
    /^from:\s/i,
    /^sent from /i,
    /^get outlook /i,
    /^http/i,
    /\boffice:\s/i,
    /\bmobile:\s/i,
    /\|\s*[a-z0-9]/i, // "| LinkedIn | Twitter"
  ];
  const meaningful: string[] = [];
  for (const line of lines) {
    if (stopMarkers.some((re) => re.test(line))) break;
    meaningful.push(line);
  }
  const collapsed = meaningful.join(" ").replace(/\s+/g, " ").trim();
  if (collapsed.length > 50) return false;
  if (collapsed.length === 0) return false;
  return ACKNOWLEDGMENT_PATTERNS.some((re) => re.test(collapsed));
}

interface ScoredOutput {
  score: number;
  reason: string;
  dueBy: string | null;
}

function parseScore(text: string): ScoredOutput | null {
  try {
    const stripped = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(stripped) as ScoredOutput;
    if (typeof parsed.score !== "number") return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(parsed.score))),
      reason: (parsed.reason ?? "").slice(0, 120),
      dueBy: parsed.dueBy ?? null,
    };
  } catch {
    return null;
  }
}

function dueByEpoch(s: string | null): number | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.getTime();
}

type LoadForScoringResult = {
  email: {
    _id: Id<"emails">;
    threadId: Id<"threads">;
    fromAddress: string;
    fromName?: string;
    subject: string;
    bodyText?: string;
    snippet?: string;
    receivedAt: number;
  };
  category: string | null;
  hasOpenSignal: boolean;
  isUserOutbound: boolean;
  priorMessages: Array<{ fromUser: boolean; snippet: string; receivedAt: number }>;
  userAlreadyRepliedInThread: boolean;
  userIsDirectAddressee: boolean;
  userIsCcd: boolean;
  senderIsTeamInternal: boolean;
  threadActivity: {
    userReplyCount: number;
    lastUserReplyAt: number | null;
    themMessagesAfterUserReply: number;
  };
  recentFeedback: Array<{
    kind: "replied" | "archived" | "manual-done" | "auto-other-acc";
    scoreAtDismissal: number;
    daysAgo: number;
  }>;
  retentionDays: number;
  confidenceFloor: number;
} | null;

export const scoreEmail = internalAction({
  args: { emailId: v.id("emails"), userId: v.id("users") },
  handler: async (ctx, { emailId, userId }): Promise<{ scored: boolean; score?: number }> => {
    const ctxData = (await ctx.runQuery(
      internal.ai.needsResponseData._loadForScoring,
      { emailId, userId },
    )) as LoadForScoringResult;
    if (!ctxData || !ctxData.email) return { scored: false };
    if (ctxData.isUserOutbound) return { scored: false };
    if (ctxData.hasOpenSignal) return { scored: false };
    if (ctxData.category && SKIP_CATEGORIES.has(ctxData.category)) return { scored: false };

    // Retention window: never persist a signal for an email older than the
    // user's configured retention (default 45 days). Saves API calls AND
    // ensures the folder stays focused on the last N days even if older
    // emails appear via threads.
    const ageDays = (Date.now() - ctxData.email.receivedAt) / 86_400_000;
    if (ageDays > ctxData.retentionDays) return { scored: false };

    const body = (ctxData.email.bodyText || ctxData.email.snippet || "").trim();
    if (body.length < 30) return { scored: false };

    // Fast-path: short pure-acknowledgment emails ("Thanks Bryce.") never
    // need a reply. Skip the AI entirely and don't even persist a row —
    // the absence of a signal is the same as "not flagged".
    if (looksLikeAcknowledgmentOnly(body)) {
      return { scored: false };
    }

    // Build the user message including thread context so the model can
    // detect "this is a closure follow-up to a thread the user already
    // resolved" vs "this is a fresh ask".
    const contextLines: string[] = [];
    for (const m of ctxData.priorMessages) {
      const tag = m.fromUser ? "USER" : "THEM";
      contextLines.push(`${tag}: ${m.snippet.slice(0, 200)}`);
    }
    const contextBlock = contextLines.length > 0
      ? `Thread context (chronological, oldest first):\n${contextLines.join("\n")}\n\n`
      : "";
    const stateLine = ctxData.userAlreadyRepliedInThread
      ? `User has already replied in this thread (${ctxData.threadActivity.userReplyCount} reply/replies, ${ctxData.threadActivity.themMessagesAfterUserReply} response(s) from THEM after the last user reply).\n`
      : "User has NOT yet replied in this thread.\n";
    const addresseeLine = `User addressing: ${ctxData.userIsCcd ? "CC-ONLY" : "DIRECT"}\n`;
    const senderLine = ctxData.senderIsTeamInternal
      ? "Sender: INTERNAL teammate (same domain as user's mailbox)\n"
      : "Sender: EXTERNAL\n";
    const feedbackBlock =
      ctxData.recentFeedback.length > 0
        ? `Past dismissals from this sender (most relevant first):\n${ctxData.recentFeedback
            .map(
              (f, i) =>
                `${i + 1}. kind=${f.kind} score=${f.scoreAtDismissal} ${f.daysAgo}d ago`,
            )
            .join("\n")}\n\n`
        : "";

    const userMsg = `${contextBlock}${stateLine}${addresseeLine}${senderLine}\n${feedbackBlock}LATEST email (from THEM):\nSubject: ${ctxData.email.subject}\nFrom: ${ctxData.email.fromName ?? ""} <${ctxData.email.fromAddress}>\nBody: ${body.slice(0, 1500)}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SCORING_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseScore(text);
    if (!parsed) return { scored: false };

    // v2 persistence gates — each one is a "skip everything we're not
    // confident enough to flag" rule. Stacked in order from cheapest /
    // strictest to most permissive:

    // 1. User-configurable confidence floor (default 50). Eliminates the
    //    long tail of marginal flags that erode trust.
    if (parsed.score < ctxData.confidenceFloor) {
      return { scored: false };
    }

    // 2. CC-only soft ceiling. The prompt already caps these at 40, but
    //    enforce the persistence cutoff here too in case the model drifts.
    if (ctxData.userIsCcd && !ctxData.userIsDirectAddressee && parsed.score < 60) {
      return { scored: false };
    }

    // 3. Team-internal soft ceiling. Teammates emailing about shared work
    //    should only flag at clearly-elevated scores.
    if (ctxData.senderIsTeamInternal && parsed.score < 70) {
      return { scored: false };
    }

    // 4. Active back-and-forth ceiling. If the user has already replied 2+
    //    times in this thread, only flag at clearly-elevated scores —
    //    otherwise the same thread camps at the top of the list every time
    //    the other party responds.
    if (ctxData.threadActivity.userReplyCount >= 2 && parsed.score < 70) {
      return { scored: false };
    }

    // 5. Final fallback: if the user has already replied at all and the
    //    score is low-confidence (≤49), don't persist. Kept from v1.
    if (ctxData.userAlreadyRepliedInThread && parsed.score < 50) {
      return { scored: false };
    }

    // Compute the display-rank score: raw score + deadline-urgency bonus
    // − active-thread penalty. `score` stays the raw judgment so the
    // tooltip / explainability can show the model's confidence; the
    // folder list orders by displayScore.
    const dueByMs = dueByEpoch(parsed.dueBy);
    let displayScore = parsed.score;
    if (dueByMs !== undefined) {
      const hoursToDue = (dueByMs - Date.now()) / 3_600_000;
      if (hoursToDue > 0 && hoursToDue < 48) displayScore += 30;
      else if (hoursToDue >= 48 && hoursToDue < 168) displayScore += 15;
    }
    if (ctxData.threadActivity.userReplyCount >= 1) {
      displayScore -= Math.min(ctxData.threadActivity.userReplyCount * 10, 25);
    }
    displayScore = Math.max(0, Math.min(100, displayScore));

    await ctx.runMutation(internal.ai.needsResponseData._persistSignal, {
      userId,
      emailId,
      threadId: ctxData.email.threadId,
      score: parsed.score,
      reason: parsed.reason || undefined,
      dueByHint: dueByMs,
      displayScore,
      userIsDirectAddressee: ctxData.userIsDirectAddressee,
      userIsCcd: ctxData.userIsCcd,
      senderIsTeamInternal: ctxData.senderIsTeamInternal,
    });
    return { scored: true, score: parsed.score };
  },
});

// Re-score: overwrites the existing open signal (or creates one if missing).
// Used by the daily cron to refresh stale items.
export const rescoreEmail = internalAction({
  args: { emailId: v.id("emails"), userId: v.id("users") },
  handler: async (
    ctx,
    { emailId, userId },
  ): Promise<{ scored: boolean; score?: number }> => {
    await ctx.runMutation(internal.ai.needsResponseData._clearOpenSignalForEmail, {
      emailId,
    });
    return (await ctx.runAction(internal.ai.needsResponse.scoreEmail, {
      emailId,
      userId,
    })) as { scored: boolean; score?: number };
  },
});
