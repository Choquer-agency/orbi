// ─────────────────────────────────────────────────────────────────────────────
// chatHistory.ts — port of routes/ai/chat-history.ts.
//
// CRUD for chatConversations + chatMessages plus an internal query used by the
// streaming HTTP action to build the message history before each round.
// ─────────────────────────────────────────────────────────────────────────────

import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "../_generated/server";
import { v } from "convex/values";
import { requireUser } from "../lib/auth";
import type { Id } from "../_generated/dataModel";

// ── List conversations ──────────────────────────────────────────────────────

export const listConversations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const conversations = await ctx.db
      .query("chatConversations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);

    // For each, peek at the first message for a fallback title.
    const result: Array<{
      id: Id<"chatConversations">;
      title: string;
      createdAt: number;
      updatedAt: number;
    }> = [];
    for (const c of conversations) {
      let title = c.title || "";
      if (!title) {
        const first = await ctx.db
          .query("chatMessages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
          .order("asc")
          .first();
        title = first?.content.slice(0, 80) || "New conversation";
      }
      result.push({
        id: c._id,
        title,
        createdAt: c._creationTime,
        updatedAt: c._creationTime,
      });
    }
    return result;
  },
});

// ── Get single conversation with messages ───────────────────────────────────

export const getConversation = query({
  args: { id: v.id("chatConversations") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const conversation = await ctx.db.get(id);
    if (!conversation || conversation.userId !== userId) {
      throw new Error("Conversation not found");
    }

    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .order("asc")
      .collect();

    return {
      id: conversation._id,
      title: conversation.title,
      messages: messages.map((m) => ({
        id: m._id,
        role: m.role,
        content: m.content,
        ...((m.metadata as Record<string, unknown> | undefined) || {}),
        createdAt: m._creationTime,
      })),
      createdAt: conversation._creationTime,
      updatedAt: conversation._creationTime,
    };
  },
});

// ── Create conversation ─────────────────────────────────────────────────────

export const createConversation = mutation({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, { title }) => {
    const userId = await requireUser(ctx);
    const id = await ctx.db.insert("chatConversations", {
      userId,
      title: title || undefined,
    });
    return { id };
  },
});

// ── Save message ─────────────────────────────────────────────────────────────

export const saveMessage = mutation({
  args: {
    conversationId: v.id("chatConversations"),
    role: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, { conversationId, role, content, metadata }) => {
    const userId = await requireUser(ctx);
    const conv = await ctx.db.get(conversationId);
    if (!conv || conv.userId !== userId) {
      throw new Error("Conversation not found");
    }

    const id = await ctx.db.insert("chatMessages", {
      conversationId,
      role,
      content,
      metadata,
    });

    if (!conv.title && role === "user") {
      await ctx.db.patch(conversationId, { title: content.slice(0, 80) });
    }
    return { id };
  },
});

// ── Delete conversation (cascade messages) ──────────────────────────────────

export const deleteConversation = mutation({
  args: { id: v.id("chatConversations") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const conv = await ctx.db.get(id);
    if (!conv || conv.userId !== userId) {
      throw new Error("Conversation not found");
    }

    // Cascade delete messages
    const msgs = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .collect();
    for (const m of msgs) {
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(id);
    return { success: true };
  },
});

// ── Internal: messages for streaming (no auth — caller is the http action,
// which already validates ownership). Returns the recent ~20 messages in the
// shape the Anthropic SDK expects. ──

export const getMessagesForStreaming = internalQuery({
  args: { conversationId: v.id("chatConversations") },
  handler: async (ctx, { conversationId }) => {
    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("asc")
      .collect();
    // Last 20, in chronological order.
    const recent = all.slice(-20);
    return recent.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
  },
});

// ── Internal: ownership check for streaming auth. ──

export const assertConversationOwner = internalQuery({
  args: { conversationId: v.id("chatConversations"), userId: v.id("users") },
  handler: async (ctx, { conversationId, userId }) => {
    const conv = await ctx.db.get(conversationId);
    if (!conv || conv.userId !== userId) return false;
    return true;
  },
});

// ── Internal: ensure a conversation exists, creating one if missing. ──

export const ensureConversation = internalMutation({
  args: {
    conversationId: v.optional(v.id("chatConversations")),
    userId: v.id("users"),
  },
  handler: async (
    ctx,
    { conversationId, userId },
  ): Promise<Id<"chatConversations">> => {
    if (conversationId) {
      const conv = await ctx.db.get(conversationId);
      if (conv && conv.userId === userId) return conversationId;
    }
    return await ctx.db.insert("chatConversations", { userId });
  },
});
