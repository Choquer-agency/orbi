import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

const UNDO_WINDOW_MS = 10_000;

const recipient = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});

const composeMode = v.union(
  v.literal("compose"),
  v.literal("reply"),
  v.literal("forward"),
);

function newDraftThreadId(): string {
  return `draft-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newDraftMessageId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create a draft (compose / reply / forward)
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    accountId: v.id("mailAccounts"),
    threadId: v.optional(v.id("threads")),
    subject: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    toAddresses: v.optional(v.array(recipient)),
    mode: composeMode,
    parentEmailId: v.optional(v.id("emails")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }

    // Look up inReplyTo if replying / forwarding
    let inReplyTo: string | undefined;
    if ((args.mode === "reply" || args.mode === "forward") && args.parentEmailId) {
      const parent = await ctx.db.get(args.parentEmailId);
      if (parent) {
        inReplyTo = parent.internetMessageId || parent.providerMessageId;
      }
    }

    const now = Date.now();

    let resolvedThreadId: Id<"threads"> | undefined = args.threadId;
    if (!resolvedThreadId) {
      resolvedThreadId = await ctx.db.insert("threads", {
        accountId: account._id,
        providerThreadId: newDraftThreadId(),
        subject: args.subject || "(no subject)",
        snippet: (args.bodyText || "").slice(0, 200),
        isRead: true,
        isStarred: false,
        isArchived: false,
        isTrashed: false,
        labels: ["DRAFT"],
        participantEmails: [
          account.email,
          ...((args.toAddresses ?? []).map((a) => a.email)),
        ],
        messageCount: 0,
        lastMessageAt: now,
      });
    }

    const emailId = await ctx.db.insert("emails", {
      accountId: account._id,
      threadId: resolvedThreadId,
      providerMessageId: newDraftMessageId(),
      inReplyTo,
      references: [],
      fromAddress: account.email,
      fromName: account.displayName || account.email.split("@")[0],
      toAddresses: args.toAddresses ?? [],
      ccAddresses: [],
      bccAddresses: [],
      subject: args.subject ?? "",
      bodyText: args.bodyText ?? "",
      bodyHtml: args.bodyHtml ?? "",
      snippet: (args.bodyText || "").slice(0, 200),
      isRead: true,
      isStarred: false,
      isDraft: true,
      labels: ["DRAFT"],
      hasAttachments: false,
      receivedAt: now,
      sendStatus: "NONE",
      sendAttempts: 0,
    });

    return { data: { id: emailId, threadId: resolvedThreadId } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-save updates to a draft
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
  args: {
    draftId: v.id("emails"),
    subject: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    toAddresses: v.optional(v.array(recipient)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const email = await ctx.db.get(args.draftId);
    if (!email) throw new Error("Draft not found");
    const account = await ctx.db.get(email.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Draft not found");
    }
    if (!email.isDraft) throw new Error("Email is not a draft");

    const patch: Record<string, unknown> = {};
    if (args.subject !== undefined) patch.subject = args.subject;
    if (args.bodyHtml !== undefined) patch.bodyHtml = args.bodyHtml;
    if (args.bodyText !== undefined) {
      patch.bodyText = args.bodyText;
      patch.snippet = args.bodyText.slice(0, 200);
    }
    if (args.toAddresses !== undefined) patch.toAddresses = args.toAddresses;

    await ctx.db.patch(args.draftId, patch);

    // Update thread snippet/subject when bodyText changes.
    if (args.bodyText !== undefined) {
      const threadPatch: Record<string, unknown> = {
        snippet: args.bodyText.slice(0, 200),
      };
      if (args.subject !== undefined) threadPatch.subject = args.subject;
      await ctx.db.patch(email.threadId, threadPatch);
    }

    return { data: await ctx.db.get(args.draftId) };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Discard a draft
// ─────────────────────────────────────────────────────────────────────────────

export const discard = mutation({
  args: { draftId: v.id("emails") },
  handler: async (ctx, { draftId }) => {
    const userId = await requireUser(ctx);
    const email = await ctx.db.get(draftId);
    if (!email) throw new Error("Draft not found");
    const account = await ctx.db.get(email.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Draft not found");
    }
    if (!email.isDraft) throw new Error("Email is not a draft");

    const thread = await ctx.db.get(email.threadId);
    await ctx.db.delete(draftId);

    // Clean up draft-only thread (no other emails).
    if (thread && thread.providerThreadId.startsWith("draft-thread-")) {
      const remaining = await ctx.db
        .query("emails")
        .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", email.threadId))
        .collect();
      if (remaining.length === 0) {
        await ctx.db.delete(email.threadId);
      }
    }

    return { data: { success: true } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Send a draft — converts draft → pending send + schedules actual send.
// ─────────────────────────────────────────────────────────────────────────────

export const sendDraft = mutation({
  args: { draftId: v.id("emails") },
  handler: async (ctx, { draftId }) => {
    const userId = await requireUser(ctx);
    const email = await ctx.db.get(draftId);
    if (!email) throw new Error("Draft not found");
    const account = await ctx.db.get(email.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Draft not found");
    }
    if (!email.isDraft) throw new Error("Email is not a draft");

    const to = (email.toAddresses ?? []) as Array<{ email: string }>;
    if (!to || to.length === 0) {
      throw new Error("Draft has no recipients");
    }

    const now = Date.now();
    const undoDeadlineAt = now + UNDO_WINDOW_MS;

    await ctx.db.patch(draftId, {
      isDraft: false,
      sendStatus: "PENDING_SEND",
      sentAt: now,
      undoDeadlineAt,
      labels: ["SENT"],
    });

    const thread = await ctx.db.get(email.threadId);
    if (thread) {
      const threadPatch: Record<string, unknown> = {
        lastMessageAt: now,
        snippet: (email.bodyText || "").slice(0, 200),
        labels: ["SENT"],
      };
      if (thread.providerThreadId.startsWith("draft-thread-")) {
        threadPatch.providerThreadId = thread.providerThreadId.replace(
          "draft-thread-",
          "local-thread-",
        );
        threadPatch.messageCount = 1;
        threadPatch.participantEmails = [
          account.email,
          ...to.map((a) => a.email),
        ];
      }
      await ctx.db.patch(email.threadId, threadPatch);
    }

    await ctx.scheduler.runAfter(UNDO_WINDOW_MS, internal.emails.actuallySend, {
      emailId: draftId,
    });

    return { data: { id: draftId, threadId: email.threadId } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// List drafts for current user
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    accountId: v.optional(v.id("mailAccounts")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const accountIds = args.accountId
      ? [args.accountId]
      : accounts.map((a) => a._id);
    if (accountIds.length === 0) return { data: [] };

    const limitNum = Math.min(args.limit ?? 100, 500);

    const emailsArrays = await Promise.all(
      accountIds.map((aid) =>
        ctx.db
          .query("emails")
          .withIndex("by_account_receivedAt", (q) => q.eq("accountId", aid))
          .order("desc")
          .take(limitNum),
      ),
    );
    const drafts = emailsArrays
      .flat()
      .filter((e) => e.isDraft)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limitNum);

    return { data: drafts.map((d) => ({ ...d, id: d._id })) };
  },
});

export const count = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const arrays = await Promise.all(
      accounts.map((a) =>
        ctx.db
          .query("emails")
          .withIndex("by_account_receivedAt", (q) => q.eq("accountId", a._id))
          .collect(),
      ),
    );
    const total = arrays.flat().filter((e) => e.isDraft).length;
    return { data: { count: total } };
  },
});
