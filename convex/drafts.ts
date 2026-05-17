import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

const UNDO_WINDOW_MS = 60_000;

const recipient = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});

function normalizeAddressList(value: unknown): Array<{ email?: string; name?: string }> {
  if (Array.isArray(value)) return value as Array<{ email?: string; name?: string }>;
  if (!value) return [];
  if (typeof value === "string") return value ? [{ email: value }] : [];
  if (typeof value === "object") return [value as { email?: string; name?: string }];
  return [];
}

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

    let resolvedSubject = args.subject || "";
    if (!resolvedSubject && (args.mode === "reply" || args.mode === "forward")) {
      if (args.parentEmailId) {
        const parent = await ctx.db.get(args.parentEmailId);
        if (parent) {
          resolvedSubject = args.mode === "forward"
            ? (parent.subject.startsWith("Fwd:") ? parent.subject : `Fwd: ${parent.subject}`)
            : (parent.subject.startsWith("Re:") ? parent.subject : `Re: ${parent.subject}`);
        }
      }
      if (!resolvedSubject && args.threadId) {
        const thread = await ctx.db.get(args.threadId);
        if (thread) {
          resolvedSubject = args.mode === "forward"
            ? (thread.subject.startsWith("Fwd:") ? thread.subject : `Fwd: ${thread.subject}`)
            : (thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`);
        }
      }
    }

    let resolvedThreadId: Id<"threads"> | undefined = args.threadId;
    if (!resolvedThreadId) {
      resolvedThreadId = await ctx.db.insert("threads", {
        accountId: account._id,
        providerThreadId: newDraftThreadId(),
        subject: resolvedSubject || "(no subject)",
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
      subject: resolvedSubject,
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
    // Autosave is best-effort: if the draft was deleted, sent, or doesn't
    // belong to this user, return silently rather than failing the caller.
    // A stale autosave firing after Send must never block the send flow.
    if (!email) return { data: null, stale: true as const };
    const account = await ctx.db.get(email.accountId);
    if (!account || account.userId !== userId) {
      return { data: null, stale: true as const };
    }
    if (!email.isDraft) return { data: null, stale: true as const };

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
    // Idempotent: missing / non-draft / not-owned is treated as already-discarded.
    // The unmount cleanup in useAutoSaveDraft fires this fire-and-forget after
    // sendDraft has already converted the row, so a throw here is a false alarm.
    if (!email) return { data: { success: true } };
    const account = await ctx.db.get(email.accountId);
    if (!account || account.userId !== userId) {
      return { data: { success: true } };
    }
    if (!email.isDraft) return { data: { success: true } };

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

    const fallbackSubject = email.subject || (await ctx.db.get(email.threadId))?.subject || "(no subject)";
    const now = Date.now();
    const undoDeadlineAt = now + UNDO_WINDOW_MS;

    await ctx.db.patch(draftId, {
      isDraft: false,
      sendStatus: "PENDING_SEND",
      subject: fallbackSubject,
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

    // Index every recipient as a contact so they show up in compose
    // autocomplete next time. Mirrors the to/cc/bcc loop in emails.send;
    // sync's _onNewEmailInserted won't fire for these because the row is
    // patched (not inserted) on the next pull.
    {
      const userAccounts = await ctx.db
        .query("mailAccounts")
        .withIndex("by_user", (q) => q.eq("userId", account.userId))
        .collect();
      const selfEmails = new Set(
        userAccounts.map((a) => a.email.toLowerCase().trim()),
      );
      const allRecipients = [
        ...((email.toAddresses as Array<{ email?: string; name?: string }> | undefined) ?? []),
        ...((email.ccAddresses as Array<{ email?: string; name?: string }> | undefined) ?? []),
        ...((email.bccAddresses as Array<{ email?: string; name?: string }> | undefined) ?? []),
      ];
      const seen = new Set<string>();
      for (const r of allRecipients) {
        const addr = (r?.email ?? "").toLowerCase().trim();
        if (!addr || !addr.includes("@")) continue;
        if (selfEmails.has(addr)) continue;
        if (seen.has(addr)) continue;
        seen.add(addr);
        await ctx.scheduler.runAfter(0, internal.contacts.upsertFromEmail, {
          userId: account.userId,
          email: addr,
          name: r?.name ?? null,
          isSender: false,
          isOutbound: true,
          bodyText: null,
          receivedAt: now,
        });
      }
    }

    await ctx.scheduler.runAfter(
      0,
      internal.ai.needsResponseData._dismissOpenSignalsForThread,
      { threadId: email.threadId, kind: "replied" },
    );

    await ctx.scheduler.runAfter(UNDO_WINDOW_MS, internal.emails.actuallySend, {
      emailId: draftId,
    });

    return { data: { id: draftId, threadId: email.threadId, subject: fallbackSubject, undoDeadlineAt } };
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
    const ownedAccountIds = new Set(accounts.map((a) => a._id));
    if (args.accountId && !ownedAccountIds.has(args.accountId)) {
      throw new Error("Account not found");
    }
    const accountIds = args.accountId
      ? [args.accountId]
      : accounts.map((a) => a._id);
    if (accountIds.length === 0) return { data: [] };

    const limitNum = Math.min(args.limit ?? 100, 500);

    // Take only from the draft-only slice of each account so we don't pull
    // hundreds of non-draft emails just to filter them out.
    const emailsArrays = await Promise.all(
      accountIds.map((aid) =>
        ctx.db
          .query("emails")
          .withIndex("by_account_isDraft_receivedAt", (q) =>
            q.eq("accountId", aid).eq("isDraft", true),
          )
          .order("desc")
          .take(limitNum),
      ),
    );
    const drafts = emailsArrays
      .flat()
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limitNum);

    return {
      data: drafts.map((d) => ({
        ...d,
        id: d._id,
        toAddresses: normalizeAddressList(d.toAddresses),
        ccAddresses: normalizeAddressList(d.ccAddresses),
        bccAddresses: normalizeAddressList(d.bccAddresses),
      })),
    };
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
    // Iterate the draft-only index slice per account so we don't read every
    // email row in the mailbox just to compute a badge count.
    const arrays = await Promise.all(
      accounts.map((a) =>
        ctx.db
          .query("emails")
          .withIndex("by_account_isDraft_receivedAt", (q) =>
            q.eq("accountId", a._id).eq("isDraft", true),
          )
          .collect(),
      ),
    );
    const total = arrays.reduce((sum, rows) => sum + rows.length, 0);
    return { data: { count: total } };
  },
});
