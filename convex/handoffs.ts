import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

const handoffStatus = v.union(
  v.literal("PENDING"),
  v.literal("ACCEPTED"),
  v.literal("DECLINED"),
  v.literal("COMPLETED"),
);

async function getDisplayName(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<string> {
  const u = (await ctx.db.get(userId)) as Doc<"users"> | null;
  return u?.displayName ?? u?.name ?? u?.email ?? "Unknown";
}

// Create a handoff: assigns thread to another user. Mirrors POST /api/threads/:threadId/handoff
export const create = mutation({
  args: {
    threadId: v.id("threads"),
    toUserId: v.id("users"),
    note: v.optional(v.string()),
    transferSla: v.optional(v.boolean()),
    transferFollowUps: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const fromUserId = await requireUser(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error("Thread not found");
    const toUser = await ctx.db.get(args.toUserId);
    if (!toUser) throw new Error("Target user not found");

    const handoffId = await ctx.db.insert("threadHandoffs", {
      threadId: args.threadId,
      fromUserId,
      toUserId: args.toUserId,
      note: args.note,
      transferSla: args.transferSla ?? false,
      transferFollowUps: args.transferFollowUps ?? false,
      status: "PENDING",
    });

    // Grant thread access (upsert to COLLABORATOR)
    const existingAccess = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) =>
        q.eq("threadId", args.threadId).eq("userId", args.toUserId),
      )
      .unique();
    if (existingAccess) {
      await ctx.db.patch(existingAccess._id, { accessLevel: "COLLABORATOR" });
    } else {
      await ctx.db.insert("threadAccess", {
        threadId: args.threadId,
        userId: args.toUserId,
        accessLevel: "COLLABORATOR",
        grantedAt: Date.now(),
      });
    }

    // Add internal comment for audit trail
    const fromName = await getDisplayName(ctx, fromUserId);
    const toName = await getDisplayName(ctx, args.toUserId);
    const noteSuffix = args.note ? `: "${args.note}"` : "";
    const auditText = `Thread handed off to ${toName}${noteSuffix}`;
    await ctx.db.insert("threadComments", {
      threadId: args.threadId,
      authorId: fromUserId,
      authorName: fromName,
      authorAvatarUrl: undefined,
      reactionCounts: {},
      bodyHtml: `<p>${auditText}</p>`,
      bodyText: auditText,
      isResolved: false,
      isEdited: false,
    });

    // Notify recipient
    await ctx.db.insert("notifications", {
      userId: args.toUserId,
      type: "ASSIGNMENT",
      title: "Thread handed off to you",
      body:
        args.note ??
        `${fromName} handed off: ${thread.subject}`,
      data: { threadId: args.threadId, handoffId },
      isRead: false,
    });

    // Optionally transfer follow-up watches
    if (args.transferFollowUps) {
      const watches = await ctx.db
        .query("followUpWatches")
        .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
        .collect();
      for (const w of watches) {
        if (w.userId === fromUserId && w.status === "WATCHING") {
          await ctx.db.patch(w._id, { userId: args.toUserId });
        }
      }
    }

    return { data: await ctx.db.get(handoffId) };
  },
});

// List handoffs assigned to the current user (optionally filtered by status)
export const listPending = query({
  args: { status: v.optional(handoffStatus) },
  handler: async (ctx, { status }) => {
    const userId = await requireUser(ctx);
    let rows;
    if (status) {
      rows = await ctx.db
        .query("threadHandoffs")
        .withIndex("by_toUser_status", (q) =>
          q.eq("toUserId", userId).eq("status", status),
        )
        .collect();
    } else {
      rows = await ctx.db
        .query("threadHandoffs")
        .withIndex("by_toUser_status", (q) => q.eq("toUserId", userId))
        .collect();
    }
    rows.sort((a, b) => b._creationTime - a._creationTime);

    const data = await Promise.all(
      rows.map(async (h) => {
        const thread = (await ctx.db.get(h.threadId)) as Doc<"threads"> | null;
        const fromUser = (await ctx.db.get(h.fromUserId)) as Doc<"users"> | null;
        return {
          ...h,
          id: h._id,
          thread: thread
            ? {
                id: thread._id,
                subject: thread.subject,
                snippet: thread.snippet,
                lastMessageAt: thread.lastMessageAt,
              }
            : null,
          fromUser: fromUser
            ? {
                id: fromUser._id,
                name: fromUser.displayName ?? fromUser.name ?? fromUser.email,
                avatarUrl: fromUser.avatarUrl ?? fromUser.image,
              }
            : null,
        };
      }),
    );
    return { data };
  },
});

export const accept = mutation({
  args: { handoffId: v.id("threadHandoffs") },
  handler: async (ctx, { handoffId }) => {
    const userId = await requireUser(ctx);
    const handoff = await ctx.db.get(handoffId);
    if (!handoff || handoff.toUserId !== userId) {
      throw new Error("Handoff not found");
    }
    if (handoff.status !== "PENDING") {
      throw new Error("Handoff already processed");
    }
    await ctx.db.patch(handoffId, {
      status: "ACCEPTED",
      acceptedAt: Date.now(),
    });
    return { data: await ctx.db.get(handoffId) };
  },
});

export const decline = mutation({
  args: { handoffId: v.id("threadHandoffs") },
  handler: async (ctx, { handoffId }) => {
    const userId = await requireUser(ctx);
    const handoff = await ctx.db.get(handoffId);
    if (!handoff || handoff.toUserId !== userId) {
      throw new Error("Handoff not found");
    }
    if (handoff.status !== "PENDING") {
      throw new Error("Handoff already processed");
    }
    await ctx.db.patch(handoffId, { status: "DECLINED" });

    // Revoke thread access on decline
    const access = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) =>
        q.eq("threadId", handoff.threadId).eq("userId", userId),
      )
      .unique();
    if (access) await ctx.db.delete(access._id);

    return { data: await ctx.db.get(handoffId) };
  },
});

// "Complete" = the handoff recipient finishes / returns to original owner.
export const complete = mutation({
  args: { handoffId: v.id("threadHandoffs") },
  handler: async (ctx, { handoffId }) => {
    const userId = await requireUser(ctx);
    const handoff = await ctx.db.get(handoffId);
    if (!handoff || handoff.toUserId !== userId || handoff.status !== "ACCEPTED") {
      throw new Error("Handoff not found or not accepted");
    }
    await ctx.db.patch(handoffId, {
      status: "COMPLETED",
      completedAt: Date.now(),
    });

    // Notify original owner
    await ctx.db.insert("notifications", {
      userId: handoff.fromUserId,
      type: "ASSIGNMENT",
      title: "Thread returned to you",
      body: "The thread you handed off has been returned.",
      data: { threadId: handoff.threadId, handoffId },
      isRead: false,
    });

    return { data: await ctx.db.get(handoffId) };
  },
});
