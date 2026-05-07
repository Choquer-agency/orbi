// ─────────────────────────────────────────────────────────────────────────────
// draftData.ts — V8-runtime queries supporting draft.ts.
// Split out because draft.ts uses "use node" for the Anthropic SDK.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { buildThreadContext } from "../lib/threadContext";
import { buildStyleContext } from "../lib/styleContext";

// Internal query: build the prompt context (thread context + style context).
export const _buildDraftContext = internalQuery({
  args: {
    threadId: v.optional(v.id("threads")),
    userId: v.id("users"),
  },
  handler: async (ctx, { threadId, userId }) => {
    let threadContext = "";
    let contactEmail: string | undefined;
    if (threadId) {
      const result = await buildThreadContext(ctx, threadId);
      threadContext = result.contextText;
      contactEmail = result.thread?.participantEmails.find(
        (e) => !e.endsWith("@orbi.agency"),
      );
    }
    const styleResult = await buildStyleContext(ctx, userId, contactEmail);
    return {
      threadContext,
      styleContext: styleResult.contextText,
      correctionsApplied: styleResult.correctionCount,
    };
  },
});
