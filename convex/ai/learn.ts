"use node";

// ─────────────────────────────────────────────────────────────────────────────
// learn.ts — port of routes/ai/learn.ts.
//
// Public action `recordEdit({ originalText, editedText, contactEmail?, threadId? })`
// uses Claude Sonnet to categorise the diff and persists a `styleCorrections`
// row. Auto-upserts a `contactStyles` row when the user changes their greeting
// or sign-off.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireUser } from "../lib/auth";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-sonnet-4-6";

const CATEGORIZE_PROMPT = `You are analyzing how a user edited an AI-generated email draft. Compare the original and edited versions, then categorize the changes.

Respond with a JSON object:
{
  "category": one of "greeting", "signoff", "tone", "length", "phrasing", "structure",
  "summary": a single sentence describing the pattern (e.g., "Changed greeting from 'Hi' to 'Hey'"),
  "greeting_changed": the new greeting if changed (e.g., "Hey Rachel"), or null,
  "signoff_changed": the new sign-off if changed (e.g., "Cheers"), or null
}

Pick the most significant category. Focus on what the user consistently prefers.`;

interface EditAnalysis {
  category: string;
  summary: string;
  greeting_changed?: string | null;
  signoff_changed?: string | null;
}

// Backing mutation lives in convex/ai/learnData.ts.

// ── Public action ───────────────────────────────────────────────────────────

export const recordEdit = action({
  args: {
    originalText: v.string(),
    editedText: v.string(),
    contactEmail: v.optional(v.string()),
    threadId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { originalText, editedText, contactEmail, threadId },
  ) => {
    const userId = await requireUser(ctx);
    if (!originalText || !editedText) {
      throw new Error("Both originalText and editedText are required");
    }
    if (originalText.trim() === editedText.trim()) {
      return { skipped: true, reason: "No changes detected" } as const;
    }

    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        system: CATEGORIZE_PROMPT,
        messages: [
          {
            role: "user",
            content: `Original draft:\n${originalText.slice(0, 2000)}\n\nEdited version (what user actually sent):\n${editedText.slice(0, 2000)}`,
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return { skipped: true, reason: "No analysis returned" } as const;
      }

      let analysis: EditAnalysis;
      try {
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        analysis = JSON.parse(jsonMatch?.[0] || textBlock.text) as EditAnalysis;
      } catch {
        return { skipped: true, reason: "Could not parse analysis" } as const;
      }

      await ctx.runMutation(internal.ai.learnData._persistCorrection, {
        userId: userId as Id<"users">,
        contactEmail: contactEmail || undefined,
        category: analysis.category,
        originalText,
        editedText,
        summary: analysis.summary,
        threadId: threadId || undefined,
        greetingChanged: analysis.greeting_changed || undefined,
        signoffChanged: analysis.signoff_changed || undefined,
      });

      return {
        learned: true,
        category: analysis.category,
        summary: analysis.summary,
      } as const;
    } catch (err) {
      console.error("Failed to process style learning", err);
      return { skipped: true, reason: "Processing error" } as const;
    }
  },
});
