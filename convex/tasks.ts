import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Tasks — ported from packages/backend/src/routes/dashboard (task endpoints)
// AI extraction (extractTasks) is owned by Agent C; this module is CRUD only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/dashboard/tasks?status=open|done|all
 * Returns the user's tasks ordered by status then deadline (asc, nulls last)
 * then creation time (desc).
 */
export const list = query({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
  },
  handler: async (ctx, { status = "open", limit = 50, page = 1 }) => {
    const userId = await requireUser(ctx);
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    let rows;
    if (status === "open") {
      rows = await ctx.db
        .query("tasks")
        .withIndex("by_user_status_deadline", (q) =>
          q.eq("userId", userId).eq("status", "OPEN"),
        )
        .take(skip + take);
    } else if (status === "done") {
      const [done, autoResolved] = await Promise.all([
        ctx.db
          .query("tasks")
          .withIndex("by_user_status_deadline", (q) =>
            q.eq("userId", userId).eq("status", "DONE"),
          )
          .take(skip + take),
        ctx.db
          .query("tasks")
          .withIndex("by_user_status_deadline", (q) =>
            q.eq("userId", userId).eq("status", "AUTO_RESOLVED"),
          )
          .take(skip + take),
      ]);
      rows = [...done, ...autoResolved];
    } else {
      const [open, done, autoResolved] = await Promise.all([
        ctx.db
          .query("tasks")
          .withIndex("by_user_status_deadline", (q) =>
            q.eq("userId", userId).eq("status", "OPEN"),
          )
          .take(skip + take),
        ctx.db
          .query("tasks")
          .withIndex("by_user_status_deadline", (q) =>
            q.eq("userId", userId).eq("status", "DONE"),
          )
          .take(skip + take),
        ctx.db
          .query("tasks")
          .withIndex("by_user_status_deadline", (q) =>
            q.eq("userId", userId).eq("status", "AUTO_RESOLVED"),
          )
          .take(skip + take),
      ]);
      rows = [...open, ...done, ...autoResolved];
    }

    rows.sort((a, b) => {
      // OPEN before DONE/AUTO_RESOLVED (alpha order matches Prisma `asc`).
      if (a.status !== b.status) return a.status < b.status ? -1 : 1;
      const aDeadline = a.deadline ?? Number.POSITIVE_INFINITY;
      const bDeadline = b.deadline ?? Number.POSITIVE_INFINITY;
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      return b._creationTime - a._creationTime;
    });

    const total = rows.length;
    const slice = rows.slice(skip, skip + take);

    // Hydrate thread.subject like the Prisma include.
    const threadIds = Array.from(new Set(slice.map((t) => t.threadId)));
    const threads = await Promise.all(threadIds.map((id) => ctx.db.get(id)));
    const threadMap = new Map(
      threads
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => [t._id, { subject: t.subject }]),
    );

    return {
      data: slice.map((t) => ({
        ...t,
        thread: threadMap.get(t.threadId) ?? null,
      })),
      total,
      hasMore: skip + take < total,
    };
  },
});

/** List all tasks belonging to a thread (used by thread detail panes). */
export const listByThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return rows.sort((a, b) => {
      if (a.status !== b.status) return a.status < b.status ? -1 : 1;
      const aDeadline = a.deadline ?? Number.POSITIVE_INFINITY;
      const bDeadline = b.deadline ?? Number.POSITIVE_INFINITY;
      return aDeadline - bDeadline;
    });
  },
});

/** GET /api/tasks/:id */
export const get = query({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const task = await ctx.db.get(id);
    if (!task || task.userId !== userId) {
      throw new Error("Task not found");
    }
    const thread = await ctx.db.get(task.threadId);
    return {
      ...task,
      thread: thread ? { subject: thread.subject } : null,
    };
  },
});

/**
 * PATCH /api/dashboard/tasks/:id — toggle DONE/OPEN.
 * Marks resolvedBy = "manual" when transitioning to DONE.
 */
export const markDone = mutation({
  args: {
    id: v.id("tasks"),
    status: v.union(v.literal("DONE"), v.literal("OPEN")),
  },
  handler: async (ctx, { id, status }) => {
    const userId = await requireUser(ctx);
    const task = await ctx.db.get(id);
    if (!task || task.userId !== userId) {
      throw new Error("Task not found");
    }
    await ctx.db.patch(id, {
      status,
      resolvedAt: status === "DONE" ? Date.now() : undefined,
      resolvedBy: status === "DONE" ? "manual" : undefined,
    });
    return await ctx.db.get(id);
  },
});

/**
 * Internal — mark a task auto-resolved (called by AI/classifier workers
 * when a later email fulfills a promise/deadline).
 */
export const autoResolve = internalMutation({
  args: {
    id: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { id, reason }) => {
    const task = await ctx.db.get(id);
    if (!task || task.status !== "OPEN") return;
    await ctx.db.patch(id, {
      status: "AUTO_RESOLVED",
      resolvedAt: Date.now(),
      resolvedBy: reason ?? "auto",
    });
  },
});
