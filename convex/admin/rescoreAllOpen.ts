// One-shot: re-score every open needsResponseSignal with the latest scorer
// (which now understands thread context + skips acknowledgments). Existing
// false positives — like the "Thanks Bryce." flag — will drop off as the
// smarter pass either lowers their score below the persistence threshold
// or skips persisting entirely.

import {
  action,
  internalAction,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const BATCH = 20;
const SPACING_MS = 1500;

export const _listOpen = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("needsResponseSignals").take(500);
    return all
      .filter((s) => s.dismissedAt === undefined)
      .map((s) => ({ emailId: s.emailId, userId: s.userId }));
  },
});

export const _runChunk = internalAction({
  args: {},
  handler: async (ctx, _args): Promise<{ scheduled: number; more: boolean }> => {
    const all = (await ctx.runQuery(
      internal.admin.rescoreAllOpen._listOpen,
      {},
    )) as Array<{ emailId: Id<"emails">; userId: Id<"users"> }>;
    if (all.length === 0) return { scheduled: 0, more: false };
    const slice = all.slice(0, BATCH);
    for (let i = 0; i < slice.length; i++) {
      await ctx.scheduler.runAfter(
        i * SPACING_MS,
        internal.ai.needsResponse.rescoreEmail,
        slice[i],
      );
    }
    if (all.length > BATCH) {
      await ctx.scheduler.runAfter(
        slice.length * SPACING_MS + 5_000,
        internal.admin.rescoreAllOpen._runChunk,
        {},
      );
    }
    return { scheduled: slice.length, more: all.length > BATCH };
  },
});

export const start = action({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    await ctx.scheduler.runAfter(
      0,
      internal.admin.rescoreAllOpen._runChunk,
      {},
    );
    return { ok: true };
  },
});
