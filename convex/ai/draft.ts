"use node";

// ─────────────────────────────────────────────────────────────────────────────
// draft.ts — port of services/ai/draft-assistant.ts.
//
// Single public action: `generateDraft`. Builds thread + style context and
// calls Claude Sonnet to produce an HTML draft body.
//
// The supporting internal query lives in convex/ai/draftData.ts (V8 runtime).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireUser } from "../lib/auth";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-sonnet-4-6";
const DRAFT_MAX_TOKENS = 1536;

const SYSTEM_PROMPT = `You are an email assistant for a professional agency.
Draft an email based on the user's instructions.

Rules:
- Write only the email body. No subject line in the body.
- Do not include a signature — that is added separately.
- Match the formality and tone of the existing thread (if replying).
- If replying, address the specific points from the previous email.
- Keep it concise unless the user asks for detail.
- Use proper email formatting (greeting, body, sign-off).
- Return HTML formatted for email. Use separate <p> tags for each paragraph — every paragraph must be its own <p>...</p> block. Do NOT use <br> between paragraphs. This ensures proper spacing.
- If you don't have enough context, write the best draft you can and note what might need adjustment.
- Follow the user's writing style preferences provided below.`;

export const generateDraft = action({
  args: {
    instruction: v.string(),
    threadId: v.optional(v.id("threads")),
    accountId: v.optional(v.id("mailAccounts")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (!args.instruction.trim()) {
      throw new Error("Instruction is required");
    }

    const built: {
      threadContext: string;
      styleContext: string;
      correctionsApplied: number;
    } = await ctx.runQuery(internal.ai.draftData._buildDraftContext, {
      threadId: args.threadId,
      userId,
    });

    const systemParts = [SYSTEM_PROMPT];
    if (built.styleContext) {
      systemParts.push(`\n\n${built.styleContext}`);
    }

    const userMessage = built.threadContext
      ? `Thread context:\n${built.threadContext}\n\nUser's instruction:\n${args.instruction}\n\nDraft the email reply.`
      : `User's instruction:\n${args.instruction}\n\nDraft the email.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: DRAFT_MAX_TOKENS,
      system: systemParts.join(""),
      messages: [{ role: "user", content: userMessage }],
    });

    try {
      await ctx.runMutation(internal.ai.usageData._record, {
        userId,
        feature: "draft",
        model: MODEL,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        providerCallCount: 1,
      });
    } catch {
      // Usage logging should not break draft generation.
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const draftHtml = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const draftText = draftHtml.replace(/<[^>]+>/g, "").trim();

    const suggestedSubject = args.threadId ? null : extractSubject(draftText);

    return {
      draftHtml,
      draftText,
      suggestedSubject,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      correctionsApplied: built.correctionsApplied,
    };
  },
});

function extractSubject(text: string): string | null {
  const firstLine = text.split("\n")[0];
  if (firstLine && firstLine.length < 100) return firstLine;
  return null;
}

// Silence unused-id warning at type level
export type _UserId = Id<"users">;
