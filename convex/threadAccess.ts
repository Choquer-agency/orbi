import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

const accessLevel = v.union(
  v.literal("VIEWER"),
  v.literal("COLLABORATOR"),
  v.literal("OWNER"),
);

async function userOwnsAccount(
  ctx: { db: any },
  userId: Id<"users">,
  accountId: Id<"mailAccounts">,
): Promise<boolean> {
  const account = (await ctx.db.get(accountId)) as Doc<"mailAccounts"> | null;
  return !!account && account.userId === userId;
}

// List collaborators on a thread (denormalized w/ user info)
export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");

    // Only allow listing if user owns the account or already has access.
    const ownsAccount = await userOwnsAccount(ctx, userId, thread.accountId);
    if (!ownsAccount) {
      const myAccess = await ctx.db
        .query("threadAccess")
        .withIndex("by_thread_user", (q) =>
          q.eq("threadId", threadId).eq("userId", userId),
        )
        .unique();
      if (!myAccess) throw new Error("Access denied");
    }

    const rows = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) => q.eq("threadId", threadId))
      .collect();

    const data = await Promise.all(
      rows.map(async (r) => {
        const u = (await ctx.db.get(r.userId)) as Doc<"users"> | null;
        return {
          ...r,
          id: r._id,
          user: u
            ? {
                id: u._id,
                name: u.displayName ?? u.name ?? u.email,
                avatarUrl: u.avatarUrl ?? u.image,
                email: u.email,
              }
            : null,
        };
      }),
    );
    return { data };
  },
});

// Grant access (idempotent — updates accessLevel if already exists)
export const grant = mutation({
  args: {
    threadId: v.id("threads"),
    userId: v.id("users"),
    accessLevel: accessLevel,
  },
  handler: async (ctx, args) => {
    const requesterId = await requireUser(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsAccount(ctx, requesterId, thread.accountId))) {
      throw new Error("Access denied");
    }

    const existing = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) =>
        q.eq("threadId", args.threadId).eq("userId", args.userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { accessLevel: args.accessLevel });
      return { data: await ctx.db.get(existing._id) };
    }
    const id = await ctx.db.insert("threadAccess", {
      threadId: args.threadId,
      userId: args.userId,
      accessLevel: args.accessLevel,
      grantedAt: Date.now(),
    });
    return { data: await ctx.db.get(id) };
  },
});

export const revoke = mutation({
  args: { threadId: v.id("threads"), userId: v.id("users") },
  handler: async (ctx, { threadId, userId }) => {
    const requesterId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsAccount(ctx, requesterId, thread.accountId))) {
      throw new Error("Access denied");
    }
    const existing = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) =>
        q.eq("threadId", threadId).eq("userId", userId),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { data: { success: true } };
  },
});
