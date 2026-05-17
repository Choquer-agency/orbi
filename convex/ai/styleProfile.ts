"use node";

// ─────────────────────────────────────────────────────────────────────────────
// styleProfile.ts — learns the user's real writing voice from their actual
// sent emails across every connected account, distills it through Haiku
// into a tight prompt-ready profile, and persists it for use by AI draft
// + chat (via lib/styleContext.ts).
//
// Idea
// ────
// "Writing Preferences" in Settings is opt-in and shallow. Most users won't
// fill it out. But every user already has thousands of authored emails that
// perfectly describe how they actually write. We:
//   1. Sample the most recent ~25 sent emails per connected account
//      (multi-account: combines Gmail + Microsoft personas in one profile).
//   2. Strip quoted history / signatures / boilerplate to plain text.
//   3. Send a single Haiku prompt that returns:
//       - 1\u20132 paragraph summary of voice
//       - short bullet rules ready to paste into a system prompt
//       - top 3 greetings & sign-offs
//       - average length in words
//       - inferred tone (1\u20135) and verbosity (1\u20135)
//   4. Cache in `styleProfiles`, re-build on demand or weekly.
//
// Cost
// ────
// Haiku 4.5 \u00d7 ~200 input tokens/sample \u00d7 125 samples \u2248 25K tokens \u2248 ~$0.025
// per rebuild. Run weekly per user.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireUser } from "../lib/auth";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;
const MAX_SAMPLES_TOTAL = 125;

// Cheap HTML \u2192 text fallback for when we only have inline HTML.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Strip well-known quoted-reply markers so we only feed the user's own words
// to the model, not the prior message they replied above.
function stripQuotes(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) {
      out.push("");
      continue;
    }
    if (l.startsWith(">")) break;
    if (/^On\s.{5,120}\swrote:$/i.test(l)) break;
    if (/^-{2,}\s*(Original|Forwarded)\s+message\s*-{2,}$/i.test(l)) break;
    if (/^From:\s+.+/i.test(l) && out.some((p) => p.length > 0)) break;
    out.push(raw);
  }
  return out.join("\n").trim();
}

interface ModelResult {
  summary: string;
  bulletRules: string[];
  commonGreetings: string[];
  commonSignOffs: string[];
  avgWords: number;
  inferredTone: number;
  inferredVerbosity: number;
}

const PROMPT = `You analyse a user's real authored emails to capture how THEY write.
Return strict JSON only \u2014 no prose, no markdown fences.

{
  "summary": "1\u20132 paragraph natural-language portrait of this user's voice (warmth, formality, pacing, structure, recurring tics, what they avoid). Speak about the user in the third person.",
  "bulletRules": [ "short imperative rule the AI should follow when drafting on this user's behalf", ... up to 10 ],
  "commonGreetings": [ top 3 greetings actually used (e.g. "Hey", "Hi {name}") ],
  "commonSignOffs": [ top 3 sign-offs actually used (e.g. "Thanks", "\u2014John") ],
  "avgWords": integer (average words per email),
  "inferredTone": integer 1\u20135 (1=very casual, 5=very formal),
  "inferredVerbosity": integer 1\u20135 (1=very terse, 5=very thorough)
}

Bullet rules must be concrete and actionable. Bad: "be friendly". Good:
"Open replies with 'Hey {first_name}' when the recipient has used your first name before." Capture quirks: punctuation habits,
sentence length, em-dashes vs. dashes, emoji use, sign-off variation by recipient.`;

export const refresh = action({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force: _force }) => {
    const userId = await requireUser(ctx);
    return await runRefresh(ctx, userId);
  },
});

// Background entry point so we can fan this out from sync/cron later.
export const refreshFor = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => runRefresh(ctx, userId),
});

async function runRefresh(ctx: any, userId: Id<"users">) {
  const accounts = (await ctx.runQuery(
    internal.ai.styleProfileData._listUserAccounts,
    { userId },
  )) as Array<{ id: Id<"mailAccounts">; email: string }>;

  if (accounts.length === 0) {
    return { skipped: true, reason: "no accounts" } as const;
  }

  // Sample sent emails from every account.
  const samples: Array<{ text: string; account: string }> = [];
  for (const acct of accounts) {
    const metas = (await ctx.runQuery(
      internal.ai.styleProfileData._sampleSentMetadata,
      { accountId: acct.id, accountEmail: acct.email },
    )) as Array<{
      id: Id<"emails">;
      inlineBodyText: string;
      inlineBodyHtml: string;
    }>;

    for (const m of metas) {
      if (samples.length >= MAX_SAMPLES_TOTAL) break;
      // Prefer inline copy when present; otherwise fetch from sibling table.
      let text = m.inlineBodyText;
      if (!text && m.inlineBodyHtml) text = htmlToText(m.inlineBodyHtml);
      if (!text) {
        const body = (await ctx.runQuery(
          internal.ai.styleProfileData._getBody,
          { emailId: m.id },
        )) as { bodyText: string; bodyHtml: string; bodyHtmlTrimmed: string } | null;
        if (body) {
          text = body.bodyText || htmlToText(body.bodyHtmlTrimmed || body.bodyHtml || "");
        }
      }
      if (!text) continue;
      const cleaned = stripQuotes(text).slice(0, 2000);
      if (cleaned.length < 25) continue; // skip one-liners ("ok", "thanks")
      samples.push({ text: cleaned, account: acct.email });
    }
    if (samples.length >= MAX_SAMPLES_TOTAL) break;
  }

  if (samples.length < 5) {
    return { skipped: true, reason: "not enough sent emails to learn from" } as const;
  }

  // Single Haiku call summarising everything.
  const userContent = samples
    .map(
      (s, i) =>
        `--- Email ${i + 1} (from ${s.account}) ---\n${s.text}`,
    )
    .join("\n\n");

  let parsed: ModelResult | null = null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Here are ${samples.length} real emails this user has sent across their connected accounts. Build the profile.\n\n${userContent}`,
        },
      ],
      metadata: { user_id: String(userId) },
    });

    try {
      await ctx.runMutation(internal.ai.usageData._record, {
        userId,
        feature: "styleProfile",
        model: MODEL,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? undefined,
        providerCallCount: 1,
        requestId: response.id,
        metadata: {
          stopReason: response.stop_reason,
          truncated: response.stop_reason === "max_tokens",
        },
      });
    } catch {
      // usage logging is best-effort
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { skipped: true, reason: "model returned no text" } as const;
    }
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    if (!m) {
      return { skipped: true, reason: "could not parse JSON" } as const;
    }
    parsed = JSON.parse(m[0]) as ModelResult;
  } catch (err) {
    console.error("styleProfile: model call failed", err);
    return { skipped: true, reason: "model error" } as const;
  }

  await ctx.runMutation(internal.ai.styleProfileData._upsertProfile, {
    userId,
    summary: parsed.summary ?? "",
    bulletRules: Array.isArray(parsed.bulletRules) ? parsed.bulletRules : [],
    sampleSize: samples.length,
    accountsAnalysed: accounts.map((a) => a.email),
    commonGreetings: Array.isArray(parsed.commonGreetings)
      ? parsed.commonGreetings.slice(0, 5)
      : [],
    commonSignOffs: Array.isArray(parsed.commonSignOffs)
      ? parsed.commonSignOffs.slice(0, 5)
      : [],
    avgWords:
      typeof parsed.avgWords === "number" && Number.isFinite(parsed.avgWords)
        ? Math.round(parsed.avgWords)
        : undefined,
    inferredTone:
      typeof parsed.inferredTone === "number" ? parsed.inferredTone : undefined,
    inferredVerbosity:
      typeof parsed.inferredVerbosity === "number"
        ? parsed.inferredVerbosity
        : undefined,
  });

  return {
    built: true,
    sampleSize: samples.length,
    accountsAnalysed: accounts.length,
  } as const;
}
