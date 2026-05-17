// ─────────────────────────────────────────────────────────────────────────────
// vacationReplyData.ts — V8 helper for the vacationReply Node action.
// (Node-runtime files can't define queries/mutations.)
// ─────────────────────────────────────────────────────────────────────────────

import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const _me = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    return { name: u?.name ?? null };
  },
});
