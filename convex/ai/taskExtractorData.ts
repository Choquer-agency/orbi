// ─────────────────────────────────────────────────────────────────────────────
// taskExtractorData.ts — V8-runtime queries/mutations for taskExtractor.ts.
// Split out because taskExtractor.ts uses "use node" for the Anthropic SDK.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import { buildThreadContext } from "../lib/threadContext";
import type { Id } from "../_generated/dataModel";

export const _buildThreadContextForTasks = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const result = await buildThreadContext(ctx, threadId);
    return result.contextText;
  },
});

export const _getExistingTaskDescriptions = internalQuery({
  args: { threadId: v.id("threads"), userId: v.id("users") },
  handler: async (ctx, { threadId, userId }) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return tasks
      .filter((t) => t.userId === userId)
      .map((t) => t.description.toLowerCase());
  },
});

export const _insertTasks = internalMutation({
  args: {
    threadId: v.id("threads"),
    userId: v.id("users"),
    tasks: v.array(
      v.object({
        description: v.string(),
        taskType: v.union(
          v.literal("PROMISE"),
          v.literal("DEADLINE"),
          v.literal("CHANGE_REQUEST"),
          v.literal("ACTION_ITEM"),
        ),
        contactEmail: v.optional(v.string()),
        contactName: v.optional(v.string()),
        deadline: v.optional(v.number()),
        status: v.union(v.literal("OPEN"), v.literal("DONE")),
      }),
    ),
  },
  handler: async (ctx, { threadId, userId, tasks }) => {
    const created: Id<"tasks">[] = [];
    for (const t of tasks) {
      const id = await ctx.db.insert("tasks", {
        userId,
        threadId,
        description: t.description,
        taskType: t.taskType,
        contactEmail: t.contactEmail,
        contactName: t.contactName,
        deadline: t.deadline,
        status: t.status === "DONE" ? "DONE" : "OPEN",
        resolvedAt: t.status === "DONE" ? Date.now() : undefined,
        resolvedBy: t.status === "DONE" ? "auto" : undefined,
      });
      created.push(id);
    }
    return created;
  },
});

export const _getOpenTasks = internalQuery({
  args: { threadId: v.id("threads"), userId: v.id("users") },
  handler: async (ctx, { threadId, userId }) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return tasks
      .filter((t) => t.userId === userId && t.status === "OPEN")
      .map((t) => ({ id: t._id, description: t.description }));
  },
});

export const _autoResolveTasks = internalMutation({
  args: { taskIds: v.array(v.id("tasks")), userId: v.id("users") },
  handler: async (ctx, { taskIds, userId }) => {
    for (const id of taskIds) {
      const t = await ctx.db.get(id);
      if (!t || t.userId !== userId) continue;
      await ctx.db.patch(id, {
        status: "AUTO_RESOLVED",
        resolvedAt: Date.now(),
        resolvedBy: "auto",
      });
    }
    return { resolved: taskIds.length };
  },
});
