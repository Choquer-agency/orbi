"use node";

// ─────────────────────────────────────────────────────────────────────────────
// ai/commitments.ts — the commitment detector (Team Hub).
//
// One Haiku call per qualifying email, and a long list of gates BEFORE any
// call is made (lessons from the 2026-07-08 follow-up token-burn incident):
//
//   1. OPT-IN: the thread's mailbox must have commitmentTrackingEnabled=true.
//      No account is ever tracked by default.
//   2. ENTITLEMENT: the mailbox owner's workspace must hold "team_hub".
//   3. SPEND CAP: workspace-configurable daily USD ceiling (default $2/day).
//      Checked against aiUsageLogs BEFORE each call; over cap = silent skip.
//   4. RECENCY: emails older than 7 days are never processed — historical
//      sync/backfill can NEVER trigger AI calls.
//   5. JUNK: spam / promotions / social / forum threads skipped.
//   6. IDEMPOTENT: an email that already produced commitments is skipped.
//
// What it extracts:
//   - INBOUND email  → discrete client requests ("client asked us to X").
//   - OUTBOUND email → promises we made ("I'll send Y tomorrow") AND, given
//     the thread's currently-open commitments, which of them this email
//     actually delivers on (marked COMPLETED with the email as evidence).
//
// Every call is logged to aiUsageLogs under feature "commitments".
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-haiku-4-5-20251001";
const FEATURE_KEY = "commitments";
const DEFAULT_DAILY_CAP_USD = 2;
const MAX_EMAIL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are a commitment tracker for a client-services agency's email system. You read ONE email and output structured JSON. Be precise and conservative — only log real, actionable commitments.

Definitions:
- INBOUND request: the counterparty (client/partner) explicitly asks the agency to do something concrete ("please update the homepage copy", "can you send the invoice", "here's the list of changes: ..."). A list of changes = ONE commitment per distinct deliverable, but merge micro-items into sensible units (a list of 12 copy tweaks on one page = one commitment "apply the 12 copy changes to the About page", not 12 rows).
- OUTBOUND promise: the agency author commits to a concrete future deliverable ("I'll send the agreement tomorrow", "we'll have staging ready by Friday"). Vague pleasantries ("we'll be in touch", "talk soon") are NOT promises.
- Completion: the email explicitly states that a previously-open item is DONE/delivered ("all the changes are live", "attached is the agreement I promised"). Merely mentioning the topic again, giving a status update ("still working on it"), or discussing other things does NOT complete it.

Output ONLY valid JSON, no markdown:
{
  "newCommitments": [
    {"description": "max 200 chars, imperative, specific", "dueBy": "YYYY-MM-DD or null"}
  ],
  "completions": [
    {"index": <number from the OPEN COMMITMENTS list>, "note": "max 120 chars quoting the evidence"}
  ]
}

Rules:
- If nothing qualifies, return {"newCommitments": [], "completions": []}.
- You may receive an ALREADY TRACKED list — commitments previously logged on this thread. NEVER re-log anything that is the same as, overlaps with, or is a rewording of an already-tracked item. Only log asks that are genuinely NEW in this specific email.
- The body you receive has quoted history removed; judge only the fresh text. If the fresh text is just a follow-up, nudge, or restatement ("just checking in on the changes"), that is NOT a new commitment.
- Never invent completions for items not clearly addressed as finished.
- Automated emails (receipts, notifications, newsletters) → empty arrays.
- dueBy only when an explicit or strongly implied date exists ("by Friday", "tomorrow", "end of month"). Resolve relative dates using the email date you're given.`;

interface ParsedExtraction {
  newCommitments: Array<{ description: string; dueBy: string | null }>;
  completions: Array<{ index: number; note: string }>;
}

function parseExtraction(text: string): ParsedExtraction | null {
  try {
    const stripped = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(stripped) as ParsedExtraction;
    if (!Array.isArray(parsed.newCommitments) || !Array.isArray(parsed.completions)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function dueByEpoch(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

export const extractFromEmail = internalAction({
  args: {
    emailId: v.id("emails"),
    // Backfill overrides (internal callers only — commitments.backfillCommitments):
    // widen the recency window, and account spend against a separate feature
    // key with its own one-off budget so a backfill can't eat the live
    // detector's daily cap (or vice versa).
    maxAgeMs: v.optional(v.number()),
    featureKey: v.optional(v.string()),
    capUsd: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { emailId, maxAgeMs, featureKey, capUsd },
  ): Promise<{ ran: boolean; inserted?: number; completed?: number; reason?: string }> => {
    const data = await ctx.runQuery(internal.commitments._loadForExtraction, {
      emailId,
    });
    if (!data) return { ran: false, reason: "email gone" };

    // Gates 1-2: opt-in + entitlement. Tracking without the feature key is
    // impossible, and neither is ever on by default.
    if (!data.teamHubEnabled || !data.workspaceId) {
      return { ran: false, reason: "no team_hub entitlement" };
    }
    if (!data.trackingEnabled) return { ran: false, reason: "tracking off" };
    if (data.alreadyExtracted) return { ran: false, reason: "already extracted" };
    if (data.isJunk) return { ran: false, reason: "junk thread" };

    // Gate 4: recency — backfill and historical sync must never burn tokens.
    if (Date.now() - data.email.receivedAt > (maxAgeMs ?? MAX_EMAIL_AGE_MS)) {
      return { ran: false, reason: "too old" };
    }

    const body = (data.bodyText || "").trim();
    if (body.length < 40) return { ran: false, reason: "body too short" };

    // Nothing to do on an outbound email when the thread has no open
    // commitments AND the body is unlikely to contain a promise? We still
    // run outbound extraction for promises — but only when tracking is on
    // (checked above), so the volume is the tracked mailbox's own sends.

    // Gate 3: daily spend cap (workspace-wide, default $2/day) — or, for a
    // backfill, its own budget under its own feature key.
    const effectiveFeature = featureKey ?? FEATURE_KEY;
    const cap = capUsd ?? data.commitmentsDailyCapUsd ?? DEFAULT_DAILY_CAP_USD;
    const window = (await ctx.runQuery(internal.ai.usageData._featureWindow, {
      hours: 24,
      feature: effectiveFeature,
    })) as { total: { estimatedCostUsd: number } };
    if (window.total.estimatedCostUsd >= cap) {
      console.warn(
        `[commitments] cap $${cap} reached for ${effectiveFeature} — skipping extraction`,
      );
      return { ran: false, reason: "daily cap reached" };
    }

    // Build the prompt.
    const emailDate = new Date(data.email.receivedAt).toISOString().slice(0, 10);
    const direction = data.isOutbound ? "OUTBOUND" : "INBOUND";
    const openList =
      data.isOutbound && data.openCommitments.length > 0
        ? `OPEN COMMITMENTS on this thread (index: description):\n${data.openCommitments
            .map(
              (c: { direction: string; description: string }, i: number) =>
                `${i}: [${c.direction}] ${c.description}`,
            )
            .join("\n")}\n\n`
        : "";
    const task = data.isOutbound
      ? "This email was SENT BY the agency. Extract any new OUTBOUND promises, and check the OPEN COMMITMENTS list for items this email clearly delivers/completes."
      : "This email was RECEIVED FROM the counterparty. Extract any new INBOUND requests. Do not report completions.";

    const tracked = (data.alreadyTrackedDescriptions ?? []) as string[];
    const trackedBlock =
      tracked.length > 0
        ? `ALREADY TRACKED on this thread (do NOT re-log these or variations of them):\n${tracked
            .slice(0, 25)
            .map((d: string) => `- ${d}`)
            .join("\n")}\n\n`
        : "";

    const userMsg = `${task}\n\n${trackedBlock}${openList}Email direction: ${direction}\nEmail date: ${emailDate}\nSubject: ${data.email.subject}\nFrom: ${data.email.fromName ?? ""} <${data.email.fromAddress}>\n\nBody:\n${body.slice(0, 5000)}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    await ctx.runMutation(internal.ai.usageData._record, {
      userId: data.mailboxOwnerUserId as Id<"users">,
      feature: effectiveFeature,
      model: MODEL,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      providerCallCount: 1,
      requestId: response.id,
      metadata: { emailId: String(emailId), direction },
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseExtraction(text);
    if (!parsed) return { ran: true, inserted: 0, completed: 0, reason: "unparseable" };

    // Counterparty: inbound = the sender; outbound = first external recipient.
    let counterpartyEmail = data.email.fromAddress.toLowerCase();
    let counterpartyName: string | undefined = data.email.fromName ?? undefined;
    if (data.isOutbound) {
      const to = Array.isArray(data.email.toAddresses)
        ? (data.email.toAddresses as Array<{ email?: string; name?: string }>)
        : [];
      counterpartyEmail = (to[0]?.email ?? "unknown").toLowerCase();
      counterpartyName = to[0]?.name;
    }

    const completions = parsed.completions
      .filter(
        (c) =>
          Number.isInteger(c.index) &&
          c.index >= 0 &&
          c.index < data.openCommitments.length,
      )
      .map((c) => ({
        commitmentId: data.openCommitments[c.index].id as Id<"commitments">,
        note: c.note || "Delivered per outbound email",
        completedAt: data.email.sentAt ?? data.email.receivedAt,
      }));

    const result = await ctx.runMutation(internal.commitments._persistExtraction, {
      workspaceId: data.workspaceId as Id<"workspaces">,
      accountId: data.accountId as Id<"mailAccounts">,
      userId: data.mailboxOwnerUserId as Id<"users">,
      threadId: data.email.threadId as Id<"threads">,
      sourceEmailId: emailId,
      requestedAt: data.email.receivedAt,
      newCommitments: parsed.newCommitments.slice(0, 5).map((c) => ({
        direction: (data.isOutbound ? "OUTBOUND" : "INBOUND") as
          | "INBOUND"
          | "OUTBOUND",
        description: c.description,
        counterpartyEmail,
        counterpartyName,
        dueAtHint: dueByEpoch(c.dueBy),
      })),
      completions,
    });

    return { ran: true, ...result };
  },
});
