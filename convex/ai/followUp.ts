"use node";

// ─────────────────────────────────────────────────────────────────────────────
// followUp.ts — port of services/ai/follow-up-agent.ts.
//
// `checkWatch` is an internal action invoked by the hourly follow-up scheduler.
// It checks whether a contact has replied since the watch was created; if not,
// it drafts a follow-up using Claude Sonnet (tone escalates by step) and
// records a `followUpEvents` row.
//
// Backing queries/mutations live in convex/ai/followUpData.ts (V8 runtime —
// internalQuery / internalMutation cannot live in a node-runtime file).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const MODEL = "claude-sonnet-4-6";
const FOLLOW_UP_MAX_TOKENS = 350;

const TONE_LABELS: Record<number, { label: string; instruction: string }> = {
  0: {
    label: "casual",
    instruction:
      "Write a casual, light follow-up. Keep it friendly and low-pressure. Something like checking in.",
  },
  1: {
    label: "direct",
    instruction:
      "Write a slightly more direct follow-up. Be polite but clear that you need a response.",
  },
  2: {
    label: "final",
    instruction:
      "Write a final check-in. Be professional but make it clear this is the last follow-up. Suggest next steps if no reply.",
  },
};

async function recordAiUsage(
  ctx: { runMutation: (...args: unknown[]) => Promise<unknown> },
  userId: Id<"users">,
  inputTokens?: number,
  outputTokens?: number,
) {
  try {
    await ctx.runMutation(internal.ai.usageData._record, {
      userId,
      feature: "follow_up_draft",
      model: MODEL,
      inputTokens,
      outputTokens,
      providerCallCount: 1,
    });
  } catch {
    // Usage logging must not interrupt follow-up processing.
  }
}

// ── Public-internal action: check a single watch ────────────────────────────

export const checkWatch = internalAction({
  args: { watchId: v.id("followUpWatches") },
  handler: async (
    ctx,
    { watchId },
  ): Promise<
    | null
    | { status: "replied" }
    | { status: "expired" }
    | { status: "drafted"; draft: string; tone?: string }
  > => {
    const watch = (await ctx.runQuery(internal.ai.followUpData._getWatch, {
      watchId,
    })) as {
      _id: Id<"followUpWatches">;
      _creationTime: number;
      threadId: Id<"threads">;
      contactEmail: string;
      intervals: number[];
      currentStep: number;
      status: string;
      userId: Id<"users">;
    } | null;
    if (!watch || watch.status !== "WATCHING") return null;

    const replied = (await ctx.runQuery(
      internal.ai.followUpData._hasReplyAfter,
      {
        threadId: watch.threadId,
        contactEmail: watch.contactEmail,
        afterMs: watch._creationTime,
      },
    )) as boolean;
    if (replied) {
      await ctx.runMutation(internal.ai.followUpData._markWatchReplied, {
        watchId,
      });
      return { status: "replied" };
    }

    if (watch.currentStep >= watch.intervals.length) {
      await ctx.runMutation(internal.ai.followUpData._markWatchExpired, {
        watchId,
      });
      return { status: "expired" };
    }

    // Draft the follow-up
    const step = Math.min(watch.currentStep, 2);
    const tone = TONE_LABELS[step];
    const threadContext = (await ctx.runQuery(
      internal.ai.followUpData._buildThreadContextForWatch,
      { threadId: watch.threadId },
    )) as string;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: FOLLOW_UP_MAX_TOKENS,
      system: `You are drafting a follow-up email for a professional agency.
${tone.instruction}

Context: The original email was sent ${watch.intervals[step] || 3} days ago with no reply from ${watch.contactEmail}.
This is follow-up #${step + 1}.

Return only the email body text, no subject line or signature.`,
      messages: [
        {
          role: "user",
          content: `Here is the email thread context:\n\n${threadContext}\n\nDraft a follow-up email.`,
        },
      ],
    });
    await recordAiUsage(ctx, watch.userId, response.usage?.input_tokens, response.usage?.output_tokens);

    const draft = response.content
      .filter((c: Anthropic.ContentBlock): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");

    const nextStep = watch.currentStep + 1;
    const nextInterval = watch.intervals[nextStep];
    const nextCheckAt = nextInterval
      ? Date.now() + nextInterval * 24 * 60 * 60 * 1000
      : Date.now();
    const expired = nextStep >= watch.intervals.length;

    await ctx.runMutation(internal.ai.followUpData._advanceWatch, {
      watchId,
      nextStep,
      nextCheckAt,
      expired,
      draftBody: draft,
      draftTone: TONE_LABELS[watch.currentStep]?.label || "casual",
    });

    return {
      status: "drafted",
      draft,
      tone: TONE_LABELS[watch.currentStep]?.label,
    };
  },
});
