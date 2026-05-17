// Per-user retention policy + the daily purger that enforces it.
//
//   - Settings live in `retentionSettings`. Defaults: spam 30d, trash 30d,
//     blocked senders deleted immediately on arrival.
//   - `_purgeAllExpired` is the cron entry point. It walks every user with
//     non-zero retention, finds threads past their TTL in the relevant
//     bucket, and hard-deletes them in small batches.
//   - Hard deletion cascades through emails, attachments, tracking rows,
//     classifications, comments, mentions, reactions, and the thread row.
//     Mirrors the per-account cascade used during user cleanup.

import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

const DEFAULTS = {
  spamRetentionDays: 30,
  trashRetentionDays: 30,
  blockedSenderImmediate: true,
} as const;

const PURGE_THREADS_PER_BATCH = 25;
const PURGE_USERS_PER_RUN = 50;

// ─── settings: read + write ────────────────────────────────────────────────

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db
      .query("retentionSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      spamRetentionDays: row?.spamRetentionDays ?? DEFAULTS.spamRetentionDays,
      trashRetentionDays: row?.trashRetentionDays ?? DEFAULTS.trashRetentionDays,
      blockedSenderImmediate:
        row?.blockedSenderImmediate ?? DEFAULTS.blockedSenderImmediate,
    };
  },
});

export const updateSettings = mutation({
  args: {
    spamRetentionDays: v.optional(v.number()),
    trashRetentionDays: v.optional(v.number()),
    blockedSenderImmediate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const clamp = (n: number | undefined): number | undefined =>
      n === undefined ? undefined : Math.max(0, Math.min(365, Math.floor(n)));
    const existing = await ctx.db
      .query("retentionSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const patch: Record<string, unknown> = {};
    if (args.spamRetentionDays !== undefined) {
      patch.spamRetentionDays = clamp(args.spamRetentionDays);
    }
    if (args.trashRetentionDays !== undefined) {
      patch.trashRetentionDays = clamp(args.trashRetentionDays);
    }
    if (args.blockedSenderImmediate !== undefined) {
      patch.blockedSenderImmediate = args.blockedSenderImmediate;
    }
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("retentionSettings", {
        userId,
        spamRetentionDays:
          (patch.spamRetentionDays as number | undefined) ??
          DEFAULTS.spamRetentionDays,
        trashRetentionDays:
          (patch.trashRetentionDays as number | undefined) ??
          DEFAULTS.trashRetentionDays,
        blockedSenderImmediate:
          (patch.blockedSenderImmediate as boolean | undefined) ??
          DEFAULTS.blockedSenderImmediate,
      });
    }
    return { ok: true };
  },
});

// Internal: read the effective retention policy for one user. Used by the
// cron + by the blocked-sender sync path to decide between trash vs delete.
export const _getEffectiveSettings = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("retentionSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      spamRetentionDays: row?.spamRetentionDays ?? DEFAULTS.spamRetentionDays,
      trashRetentionDays: row?.trashRetentionDays ?? DEFAULTS.trashRetentionDays,
      blockedSenderImmediate:
        row?.blockedSenderImmediate ?? DEFAULTS.blockedSenderImmediate,
    };
  },
});

// ─── cron entry: scan every user, schedule per-user purge ──────────────────

export const _purgeAllExpired = internalAction({
  args: {},
  handler: async (ctx) => {
    const userIds = (await ctx.runQuery(internal.retention._listUsers, {
      limit: PURGE_USERS_PER_RUN,
    })) as Id<"users">[];
    for (const userId of userIds) {
      // Fire-and-forget per-user purge so a slow one can't starve the rest.
      await ctx.scheduler.runAfter(0, internal.retention._purgeUser, {
        userId,
      });
    }
    return { scheduledUsers: userIds.length };
  },
});

export const _listUsers = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const users = await ctx.db.query("users").take(limit);
    return users.map((u) => u._id);
  },
});

// ─── per-user purge ────────────────────────────────────────────────────────

export const _purgeUser = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const settings = (await ctx.runQuery(
      internal.retention._getEffectiveSettings,
      { userId },
    )) as {
      spamRetentionDays: number;
      trashRetentionDays: number;
      blockedSenderImmediate: boolean;
    };

    let deletedSpam = 0;
    let deletedTrash = 0;
    const now = Date.now();

    // 0 = delete on the next sweep (use `now` as the cutoff so every spam/
    // trash thread is older than it). N > 0 = N days. We always run the loop.
    {
      const cutoff = now - settings.spamRetentionDays * 86_400_000;
      for (let i = 0; i < 8; i++) {
        const ids = (await ctx.runQuery(internal.retention._findSpamExpired, {
          userId,
          olderThan: cutoff,
          limit: PURGE_THREADS_PER_BATCH,
        })) as Id<"threads">[];
        if (ids.length === 0) break;
        for (const id of ids) {
          await ctx.runMutation(internal.retention._deleteThreadCascade, {
            threadId: id,
          });
          deletedSpam++;
        }
      }
    }

    {
      const cutoff = now - settings.trashRetentionDays * 86_400_000;
      for (let i = 0; i < 8; i++) {
        const ids = (await ctx.runQuery(internal.retention._findTrashExpired, {
          userId,
          olderThan: cutoff,
          limit: PURGE_THREADS_PER_BATCH,
        })) as Id<"threads">[];
        if (ids.length === 0) break;
        for (const id of ids) {
          await ctx.runMutation(internal.retention._deleteThreadCascade, {
            threadId: id,
          });
          deletedTrash++;
        }
      }
    }

    return { userId, deletedSpam, deletedTrash };
  },
});

// ─── candidate-thread lookups ─────────────────────────────────────────────

export const _findSpamExpired = internalQuery({
  args: {
    userId: v.id("users"),
    olderThan: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { userId, olderThan, limit }) => {
    const accts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out: Id<"threads">[] = [];
    for (const a of accts) {
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) =>
          q.eq("accountId", a._id).lt("lastMessageAt", olderThan),
        )
        .order("asc")
        .take(limit);
      for (const t of threads) {
        if (t.labels.includes("SPAM")) {
          out.push(t._id);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  },
});

export const _findTrashExpired = internalQuery({
  args: {
    userId: v.id("users"),
    olderThan: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { userId, olderThan, limit }) => {
    const accts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out: Id<"threads">[] = [];
    for (const a of accts) {
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) =>
          q.eq("accountId", a._id).lt("lastMessageAt", olderThan),
        )
        .order("asc")
        .take(limit);
      for (const t of threads) {
        if (t.isTrashed) {
          out.push(t._id);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  },
});

// ─── thread cascade delete (chunked-safe) ────────────────────────────────

export const _deleteThreadCascade = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return { deleted: false };

    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .collect();

    for (const e of emails) {
      const attachments = await ctx.db
        .query("attachments")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .collect();
      for (const a of attachments) await ctx.db.delete(a._id);

      const trackingRows = await ctx.db
        .query("emailTracking")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .collect();
      for (const t of trackingRows) {
        const opens = await ctx.db
          .query("emailOpens")
          .withIndex("by_trackingId_openedAt", (q) =>
            q.eq("trackingId", t.trackingId),
          )
          .collect();
        for (const o of opens) await ctx.db.delete(o._id);
        const clicks = await ctx.db
          .query("linkClicks")
          .withIndex("by_trackingId_clickedAt", (q) =>
            q.eq("trackingId", t.trackingId),
          )
          .collect();
        for (const c of clicks) await ctx.db.delete(c._id);
        await ctx.db.delete(t._id);
      }

      const classifications = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .collect();
      for (const c of classifications) await ctx.db.delete(c._id);

      await ctx.db.delete(e._id);
    }

    const comments = await ctx.db
      .query("threadComments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const c of comments) {
      const reactions = await ctx.db
        .query("commentReactions")
        .withIndex("by_comment_user_emoji", (q) => q.eq("commentId", c._id))
        .collect();
      for (const r of reactions) await ctx.db.delete(r._id);
      await ctx.db.delete(c._id);
    }
    const mentions = await ctx.db
      .query("threadMentions")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const m of mentions) await ctx.db.delete(m._id);
    const access = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) => q.eq("threadId", threadId))
      .collect();
    for (const a of access) await ctx.db.delete(a._id);
    const handoffs = await ctx.db
      .query("threadHandoffs")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const h of handoffs) await ctx.db.delete(h._id);

    await ctx.db.delete(threadId);
    return { deleted: true, emailCount: emails.length };
  },
});
