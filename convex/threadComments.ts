import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function extractMentionIds(html: string): string[] {
  const regex = /data-mention-id="([^"]+)"/g;
  const ids: string[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.push(match[1]);
  }
  return [...new Set(ids)];
}

async function lookupAuthor(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<{ name: string; avatarUrl?: string }> {
  const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
  const name =
    user?.displayName ?? user?.name ?? user?.email ?? "Unknown user";
  const avatarUrl = user?.avatarUrl ?? user?.image;
  return { name, avatarUrl };
}

async function bumpReactionCount(
  ctx: { db: any },
  commentId: Id<"threadComments">,
  emoji: string,
  delta: 1 | -1,
) {
  const comment = await ctx.db.get(commentId);
  if (!comment) return;
  const counts = { ...(comment.reactionCounts ?? {}) } as Record<string, number>;
  const next = (counts[emoji] ?? 0) + delta;
  if (next <= 0) {
    delete counts[emoji];
  } else {
    counts[emoji] = next;
  }
  await ctx.db.patch(commentId, { reactionCounts: counts });
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    await requireUser(ctx);
    const comments = await ctx.db
      .query("threadComments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("asc")
      .collect();

    // Hydrate mentions + reactions per comment. Author info is denormalized.
    const data = await Promise.all(
      comments.map(async (c) => {
        const mentions = await ctx.db
          .query("threadMentions")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId))
          .filter((q) => q.eq(q.field("commentId"), c._id))
          .collect();
        const mentionsHydrated = await Promise.all(
          mentions.map(async (m) => {
            const u = (await ctx.db.get(m.mentionedUserId)) as Doc<"users"> | null;
            return {
              ...m,
              id: m._id,
              mentionedUser: u
                ? {
                    id: u._id,
                    name: u.displayName ?? u.name ?? u.email,
                    avatarUrl: u.avatarUrl ?? u.image,
                  }
                : null,
            };
          }),
        );
        const reactions = await ctx.db
          .query("commentReactions")
          .withIndex("by_comment", (q) => q.eq("commentId", c._id))
          .collect();
        const reactionsHydrated = await Promise.all(
          reactions.map(async (r) => {
            const u = (await ctx.db.get(r.userId)) as Doc<"users"> | null;
            return {
              ...r,
              id: r._id,
              user: u
                ? { id: u._id, name: u.displayName ?? u.name ?? u.email }
                : null,
            };
          }),
        );

        return {
          ...c,
          id: c._id,
          author: {
            id: c.authorId,
            name: c.authorName,
            avatarUrl: c.authorAvatarUrl,
          },
          mentions: mentionsHydrated,
          reactions: reactionsHydrated,
        };
      }),
    );
    return { data };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export const add = mutation({
  args: {
    threadId: v.id("threads"),
    bodyHtml: v.string(),
    bodyText: v.string(),
  },
  handler: async (ctx, { threadId, bodyHtml, bodyText }) => {
    const userId = await requireUser(ctx);

    // Verify thread exists
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");

    const author = await lookupAuthor(ctx, userId);

    const mentionedIds = extractMentionIds(bodyHtml);

    const commentId = await ctx.db.insert("threadComments", {
      threadId,
      authorId: userId,
      authorName: author.name,
      authorAvatarUrl: author.avatarUrl,
      reactionCounts: {},
      bodyHtml,
      bodyText,
      isResolved: false,
      isEdited: false,
    });

    // Create mentions and grant thread access (idempotent upsert)
    for (const mid of mentionedIds) {
      // Validate the mentioned user exists
      const mentionedUser = await ctx.db.get(mid as Id<"users">);
      if (!mentionedUser) continue;

      // Avoid dup mention rows for the same comment+user
      const existingMention = await ctx.db
        .query("threadMentions")
        .withIndex("by_comment_user", (q) =>
          q.eq("commentId", commentId).eq("mentionedUserId", mid as Id<"users">),
        )
        .unique();
      if (!existingMention) {
        await ctx.db.insert("threadMentions", {
          commentId,
          threadId,
          mentionedUserId: mid as Id<"users">,
        });
      }

      // Upsert thread access
      const existingAccess = await ctx.db
        .query("threadAccess")
        .withIndex("by_thread_user", (q) =>
          q.eq("threadId", threadId).eq("userId", mid as Id<"users">),
        )
        .unique();
      if (!existingAccess) {
        await ctx.db.insert("threadAccess", {
          threadId,
          userId: mid as Id<"users">,
          accessLevel: "COLLABORATOR",
          grantedAt: Date.now(),
        });
      }

      // Notify the mentioned user
      await ctx.db.insert("notifications", {
        userId: mid as Id<"users">,
        type: "MENTION",
        title: `${author.name} mentioned you`,
        body: bodyText.slice(0, 200),
        data: { threadId, commentId },
        isRead: false,
      });
    }

    const comment = await ctx.db.get(commentId);
    return {
      data: {
        ...comment!,
        id: commentId,
        author: { id: userId, name: author.name, avatarUrl: author.avatarUrl },
      },
    };
  },
});

export const edit = mutation({
  args: {
    commentId: v.id("threadComments"),
    bodyHtml: v.string(),
    bodyText: v.string(),
  },
  handler: async (ctx, { commentId, bodyHtml, bodyText }) => {
    const userId = await requireUser(ctx);
    const comment = await ctx.db.get(commentId);
    if (!comment || comment.authorId !== userId) {
      throw new Error("Comment not found");
    }
    await ctx.db.patch(commentId, {
      bodyHtml,
      bodyText,
      isEdited: true,
      editedAt: Date.now(),
    });
    return { data: await ctx.db.get(commentId) };
  },
});

export const remove = mutation({
  args: { commentId: v.id("threadComments") },
  handler: async (ctx, { commentId }) => {
    const userId = await requireUser(ctx);
    const comment = await ctx.db.get(commentId);
    if (!comment || comment.authorId !== userId) {
      throw new Error("Comment not found");
    }

    // Cascade: delete mentions + reactions
    const mentions = await ctx.db
      .query("threadMentions")
      .withIndex("by_thread", (q) => q.eq("threadId", comment.threadId))
      .filter((q) => q.eq(q.field("commentId"), commentId))
      .collect();
    for (const m of mentions) await ctx.db.delete(m._id);

    const reactions = await ctx.db
      .query("commentReactions")
      .withIndex("by_comment", (q) => q.eq("commentId", commentId))
      .collect();
    for (const r of reactions) await ctx.db.delete(r._id);

    await ctx.db.delete(commentId);
    return { data: { success: true } };
  },
});

export const resolve = mutation({
  args: { commentId: v.id("threadComments") },
  handler: async (ctx, { commentId }) => {
    const userId = await requireUser(ctx);
    const comment = await ctx.db.get(commentId);
    if (!comment) throw new Error("Comment not found");
    const resolving = !comment.isResolved;
    await ctx.db.patch(commentId, {
      isResolved: resolving,
      resolvedBy: resolving ? userId : undefined,
      resolvedAt: resolving ? Date.now() : undefined,
    });
    return { data: await ctx.db.get(commentId) };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Reactions — also update the parent comment's reactionCounts atomically.
// ─────────────────────────────────────────────────────────────────────────────

export const addReaction = mutation({
  args: { commentId: v.id("threadComments"), emoji: v.string() },
  handler: async (ctx, { commentId, emoji }) => {
    const userId = await requireUser(ctx);
    const comment = await ctx.db.get(commentId);
    if (!comment) throw new Error("Comment not found");

    const existing = await ctx.db
      .query("commentReactions")
      .withIndex("by_comment_user_emoji", (q) =>
        q.eq("commentId", commentId).eq("userId", userId).eq("emoji", emoji),
      )
      .unique();
    if (existing) {
      return { data: existing };
    }

    const reactionId = await ctx.db.insert("commentReactions", {
      commentId,
      userId,
      emoji,
    });
    await bumpReactionCount(ctx, commentId, emoji, 1);

    return { data: await ctx.db.get(reactionId) };
  },
});

export const removeReaction = mutation({
  args: { commentId: v.id("threadComments"), emoji: v.string() },
  handler: async (ctx, { commentId, emoji }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("commentReactions")
      .withIndex("by_comment_user_emoji", (q) =>
        q.eq("commentId", commentId).eq("userId", userId).eq("emoji", emoji),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      await bumpReactionCount(ctx, commentId, emoji, -1);
    }
    return { data: { success: true } };
  },
});
