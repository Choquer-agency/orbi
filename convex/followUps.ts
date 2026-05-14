import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up watches — ported from packages/backend/src/routes/follow-ups.
//
// The Claude-driven draft generator lives in `convex/ai/followUp.ts`
// (`internal.ai.followUp.checkWatch`). This module owns watch CRUD and the
// hourly cron action `processFollowUpScans`, which delegates each due watch
// to `checkWatch` (which itself handles reply detection, drafting, and
// status advancement).
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FOLLOW_UP_INTERVALS = [1, 3, 7];
const FOLLOW_UP_SCAN_BATCH_LIMIT = 25;

/** POST /api/follow-ups */
export const create = mutation({
  args: {
    threadId: v.id("threads"),
    emailId: v.string(),
    contactEmail: v.string(),
    intervals: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const intervals = args.intervals ?? DEFAULT_FOLLOW_UP_INTERVALS;
    const nextCheckAt = Date.now() + intervals[0] * DAY_MS;

    const id = await ctx.db.insert("followUpWatches", {
      userId,
      threadId: args.threadId,
      emailId: args.emailId,
      contactEmail: args.contactEmail,
      intervals,
      currentStep: 0,
      nextCheckAt,
      status: "WATCHING",
    });
    return await ctx.db.get(id);
  },
});

export const _ensureWatchForEmail = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.id("threads"),
    emailId: v.string(),
    contactEmail: v.string(),
    intervals: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    const contactEmail = args.contactEmail.toLowerCase().trim();
    if (!contactEmail) return null;

    const existing = await ctx.db
      .query("followUpWatches")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    const active = existing.find(
      (w) =>
        w.userId === args.userId &&
        w.contactEmail.toLowerCase() === contactEmail &&
        w.status === "WATCHING",
    );
    if (active) return active;

    const intervals = args.intervals ?? DEFAULT_FOLLOW_UP_INTERVALS;
    const id = await ctx.db.insert("followUpWatches", {
      userId: args.userId,
      threadId: args.threadId,
      emailId: args.emailId,
      contactEmail,
      intervals,
      currentStep: 0,
      nextCheckAt: Date.now() + intervals[0] * DAY_MS,
      status: "WATCHING",
    });
    return await ctx.db.get(id);
  },
});

/** GET /api/follow-ups?status=… */
export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    const userId = await requireUser(ctx);
    let rows = (
      await ctx.db.query("followUpWatches").collect()
    ).filter((r) => r.userId === userId);
    if (status) rows = rows.filter((r) => r.status === status);
    rows.sort((a, b) => a.nextCheckAt - b.nextCheckAt);

    // Hydrate thread.subject + thread.snippet and last 5 events (matches
    // the Prisma include shape from the source route).
    const threadIds = Array.from(new Set(rows.map((r) => r.threadId)));
    const threads = await Promise.all(threadIds.map((id) => ctx.db.get(id)));
    const threadMap = new Map(
      threads
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => [t._id, { subject: t.subject, snippet: t.snippet }]),
    );

    const hydrated = await Promise.all(
      rows.map(async (r) => {
        const events = await ctx.db
          .query("followUpEvents")
          .withIndex("by_watch", (q) => q.eq("watchId", r._id))
          .order("desc")
          .take(5);
        return {
          ...r,
          thread: threadMap.get(r.threadId) ?? null,
          events,
        };
      }),
    );
    return hydrated;
  },
});

/** GET /api/follow-ups/:id */
export const get = query({
  args: { id: v.id("followUpWatches") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const watch = await ctx.db.get(id);
    if (!watch || watch.userId !== userId) {
      throw new Error("Follow-up watch not found");
    }
    const thread = await ctx.db.get(watch.threadId);
    const events = await ctx.db
      .query("followUpEvents")
      .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
      .order("asc")
      .collect();
    return {
      ...watch,
      thread: thread
        ? { subject: thread.subject, snippet: thread.snippet }
        : null,
      events,
    };
  },
});

/** DELETE /api/follow-ups/:id */
export const cancel = mutation({
  args: { id: v.id("followUpWatches") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const watch = await ctx.db.get(id);
    if (!watch || watch.userId !== userId) {
      throw new Error("Follow-up watch not found");
    }
    await ctx.db.patch(id, {
      status: "CANCELLED",
      resolvedAt: Date.now(),
    });
    return await ctx.db.get(id);
  },
});

/**
 * POST /api/follow-ups/:id/send — approve a drafted follow-up.
 * The Fastify version only logs a `follow_up_sent` event (the actual send
 * is a no-op TODO). Mirrors that behavior here.
 */
export const sendDrafted = mutation({
  args: {
    id: v.id("followUpWatches"),
    eventId: v.id("followUpEvents"),
  },
  handler: async (ctx, { id, eventId }) => {
    const userId = await requireUser(ctx);
    const watch = await ctx.db.get(id);
    if (!watch || watch.userId !== userId) {
      throw new Error("Follow-up watch not found");
    }
    const event = await ctx.db.get(eventId);
    if (!event || event.watchId !== id) {
      throw new Error("Follow-up event not found");
    }
    if (!event.draftBody) {
      throw new Error("No draft to send");
    }
    await ctx.db.insert("followUpEvents", {
      watchId: id,
      type: "follow_up_sent",
      draftBody: event.draftBody,
      draftTone: event.draftTone,
    });
    return { message: "Follow-up marked as sent", draftBody: event.draftBody };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron: hourly scan of WATCHING watches.
// ─────────────────────────────────────────────────────────────────────────────

/** Internal — list watches due for a check. */
export const _listDueWatches = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return await ctx.db
      .query("followUpWatches")
      .withIndex("by_status_nextCheckAt", (q) =>
        q.eq("status", "WATCHING").lte("nextCheckAt", now),
      )
      .order("asc")
      .take(FOLLOW_UP_SCAN_BATCH_LIMIT);
  },
});

/** Internal — has the contact replied to the thread since the watch's anchor? */
export const _checkForReply = internalQuery({
  args: {
    threadId: v.id("threads"),
    contactEmail: v.string(),
    sinceTs: v.number(),
  },
  handler: async (ctx, { threadId, contactEmail, sinceTs }) => {
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) =>
        q.eq("threadId", threadId).gt("receivedAt", sinceTs),
      )
      .collect();
    return emails.some(
      (e) => e.fromAddress.toLowerCase() === contactEmail.toLowerCase(),
    );
  },
});

/** Internal — apply scan result to a single watch. */
export const _applyWatchUpdate = internalMutation({
  args: {
    watchId: v.id("followUpWatches"),
    replied: v.boolean(),
    draftBody: v.optional(v.string()),
    draftTone: v.optional(v.string()),
  },
  handler: async (ctx, { watchId, replied, draftBody, draftTone }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.status !== "WATCHING") return;
    const now = Date.now();

    if (replied) {
      await ctx.db.patch(watchId, {
        status: "REPLIED",
        resolvedAt: now,
      });
      await ctx.db.insert("followUpEvents", {
        watchId,
        type: "reply_received",
      });
      return;
    }

    const nextStep = watch.currentStep + 1;
    const exhausted = nextStep >= watch.intervals.length;

    if (exhausted) {
      await ctx.db.patch(watchId, {
        status: "EXPIRED",
        resolvedAt: now,
      });
      await ctx.db.insert("followUpEvents", { watchId, type: "check" });
      return;
    }

    // Save draft event + advance to next interval.
    if (draftBody) {
      await ctx.db.insert("followUpEvents", {
        watchId,
        type: "follow_up_drafted",
        draftBody,
        draftTone,
      });
    } else {
      await ctx.db.insert("followUpEvents", { watchId, type: "check" });
    }

    const nextIntervalDays = watch.intervals[nextStep];
    await ctx.db.patch(watchId, {
      currentStep: nextStep,
      nextCheckAt: now + nextIntervalDays * DAY_MS,
    });

    // Notify the user that a follow-up draft is ready.
    if (draftBody) {
      await ctx.db.insert("notifications", {
        userId: watch.userId,
        type: "SNOOZE_REMINDER",
        title: "Follow-up draft ready",
        body: `A follow-up draft for ${watch.contactEmail} is ready to review.`,
        data: { watchId, threadId: watch.threadId },
        isRead: false,
      });
    }
  },
});

/**
 * Cron-driven scan. Walks WATCHING watches whose nextCheckAt has passed,
 * checks for replies, and (if no reply) calls Agent C's draft generator.
 *
 * Phase 4 will register this on an hourly cron.
 */
export const processFollowUpScans = internalAction({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.runQuery(internal.followUps._listDueWatches, {});
    let processed = 0;

    for (const watch of due) {
      // Delegate to convex/ai/followUp.ts:checkWatch — it handles reply
      // detection, drafting, and status advancement (REPLIED/EXPIRED/WATCHING).
      let result:
        | null
        | { status: "replied" }
        | { status: "expired" }
        | { status: "drafted"; draft: string; tone?: string } = null;
      try {
        result = await ctx.runAction(internal.ai.followUp.checkWatch, {
          watchId: watch._id,
        });
      } catch (err) {
        console.error("follow-up checkWatch failed", err);
      }

      // checkWatch writes events itself; we still own the user-facing
      // "draft ready" notification (matches the source backend behavior).
      if (result?.status === "drafted") {
        await ctx.runMutation(internal.followUps._notifyDraftReady, {
          watchId: watch._id,
        });
      }
      processed += 1;
    }

    // If we filled the batch the queue may still have more due watches
    // (e.g. after downtime). Schedule another tick in 30s so the backlog
    // drains instead of waiting another hour.
    if (due.length >= FOLLOW_UP_SCAN_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(
        30_000,
        internal.followUps.processFollowUpScans,
        {},
      );
    }

    return { processed, scheduledFollowUpTick: due.length >= FOLLOW_UP_SCAN_BATCH_LIMIT };
  },
});

/** Internal — emit a notification once a follow-up draft is ready. */
export const _notifyDraftReady = internalMutation({
  args: { watchId: v.id("followUpWatches") },
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return;
    await ctx.db.insert("notifications", {
      userId: watch.userId,
      type: "SNOOZE_REMINDER",
      title: "Follow-up draft ready",
      body: `A follow-up draft for ${watch.contactEmail} is ready to review.`,
      data: { watchId, threadId: watch.threadId },
      isRead: false,
    });
  },
});
