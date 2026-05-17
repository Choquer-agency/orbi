"use node";

// ─────────────────────────────────────────────────────────────────────────────
// vacationReply.ts — AI helper for the Vacation Responder settings page.
//
// Takes a few structured inputs (return date, optional contact, tone, notes)
// and returns a polished `{ subject, body }` the user can review and save as
// their out-of-office auto-reply.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { requireUser } from "../lib/auth";
import { internal } from "../_generated/api";

const MODEL = "claude-sonnet-4-6";

const TONES = ["warm", "formal", "casual"] as const;
type Tone = (typeof TONES)[number];

const SYSTEM_PROMPT = `You write professional out-of-office auto-replies.

Rules:
- Output JSON only, matching exactly: {"subject": "...", "body": "..."}
- Subject: short, clear. Include the return date in a friendly form (e.g. "Out of Office — back Jun 12").
- Body: 2–4 short paragraphs, separated by blank lines. Plain text, no HTML, no Markdown.
- Lead with a brief thank-you for the email.
- State that you're out of office and when you return (use the provided return date).
- If a fallback contact is provided, include them once with a single way to reach them.
- Close with a short sign-off. Do NOT include a signature block — the system appends that.
- Never invent details the user didn't provide. Don't fabricate phone numbers, alternate emails, or projects.
- Adapt the warmth to the requested tone:
  - warm: friendly, first-name energy, light enthusiasm
  - formal: courteous, "Dear sender" style, no contractions
  - casual: relaxed, conversational, contractions OK`;

export const generate = action({
  args: {
    returnDate: v.string(), // ISO date (YYYY-MM-DD)
    contactWhileAway: v.optional(v.string()), // free text: "Sarah at sarah@…"
    tone: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    if (!TONES.includes(args.tone as Tone)) {
      throw new Error(`tone must be one of: ${TONES.join(", ")}`);
    }
    if (!args.returnDate.trim()) {
      throw new Error("returnDate is required");
    }

    const me: { name: string | null } = await ctx.runQuery(
      internal.ai.vacationReplyData._me,
      { userId },
    );

    const returnDateHuman = formatHumanDate(args.returnDate);

    const userMessage = [
      `Generate an out-of-office auto-reply.`,
      `User's first name (for tone reference, do NOT sign with it — signature is appended separately): ${me.name ?? "(unknown)"}`,
      `Return date: ${returnDateHuman}`,
      args.contactWhileAway
        ? `Fallback contact while away: ${args.contactWhileAway}`
        : `No fallback contact — do not mention one.`,
      `Tone: ${args.tone}`,
      args.notes ? `Additional context from user:\n${args.notes}` : null,
      ``,
      `Return ONLY the JSON object — no prose, no code fences.`,
    ]
      .filter(Boolean)
      .join("\n");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw =
      textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    const parsed = parseJsonReply(raw);

    return {
      subject: parsed.subject,
      body: parsed.body,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    };
  },
});

function parseJsonReply(raw: string): { subject: string; body: string } {
  // Strip ``` fences if the model added them despite the instruction.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (
      obj &&
      typeof obj.subject === "string" &&
      typeof obj.body === "string"
    ) {
      return { subject: obj.subject, body: obj.body };
    }
  } catch {
    /* fall through */
  }
  throw new Error("AI returned an unexpected response. Please try again.");
}

function formatHumanDate(iso: string): string {
  // iso is YYYY-MM-DD — parse as local date, format as "Month D, YYYY".
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
