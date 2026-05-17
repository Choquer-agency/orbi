import { v } from "convex/values";
import {
  mutation,
  query,
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const UNDO_WINDOW_MS = 60_000; // 60s undo window — matches the toast counter, drives send-now / undoSend / updatePending eligibility.

async function ensureEmailOwnedByUser(
  ctx: { db: any },
  emailId: Id<"emails">,
  userId: Id<"users">,
): Promise<{ email: Doc<"emails">; account: Doc<"mailAccounts"> } | null> {
  const email = await ctx.db.get(emailId);
  if (!email) return null;
  const account = await ctx.db.get(email.accountId);
  if (!account || (account as Doc<"mailAccounts">).userId !== userId) return null;
  return { email, account };
}

function newLocalProviderMessageId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newLocalProviderThreadId(): string {
  return `local-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Dispatch contact extraction for an outbound email's recipients, so that
// people the user emails through the app immediately appear in the compose
// autocomplete. Mirrors the to/cc/bcc loop in sync/gmailData._onNewEmailInserted
// — that path only fires when sync inserts a *new* row, but our outbound
// path patches an existing local row, so sync reports isNew=false and never
// triggers contact extraction. Calling this directly from the send mutations
// fills the gap.
async function dispatchOutboundContactExtraction(
  ctx: {
    db: any;
    scheduler: { runAfter: (delay: number, ref: any, args: any) => Promise<unknown> };
  },
  account: Doc<"mailAccounts">,
  recipients: Array<{ email: string; name?: string }>,
  receivedAt: number,
): Promise<void> {
  const userAccounts = await ctx.db
    .query("mailAccounts")
    .withIndex("by_user", (q: any) => q.eq("userId", account.userId))
    .collect();
  const selfEmails = new Set(
    userAccounts.map((a: Doc<"mailAccounts">) => a.email.toLowerCase().trim()),
  );
  const seen = new Set<string>();
  for (const r of recipients) {
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
      receivedAt,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .collect();
    return {
      data: {
        ...owned.email,
        id: owned.email._id,
        attachments: attachments.map((a) => ({ ...a, id: a._id })),
      },
    };
  },
});

// Email tracking metadata for the TrackingInfo component (open count, opens list, link clicks).
// Returns null if tracking is disabled or not yet recorded for this email.
export const getEmailTracking = query({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) return { data: null };
    const tracking = await ctx.db
      .query("emailTracking")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (!tracking) return { data: null };
    const opens = await ctx.db
      .query("emailOpens")
      .withIndex("by_trackingId_openedAt", (q) =>
        q.eq("trackingId", tracking.trackingId),
      )
      .order("desc")
      .take(50);
    const clicks = await ctx.db
      .query("linkClicks")
      .withIndex("by_trackingId_clickedAt", (q) =>
        q.eq("trackingId", tracking.trackingId),
      )
      .order("desc")
      .take(50);
    return {
      data: {
        id: tracking._id,
        trackingId: tracking.trackingId,
        isEnabled: tracking.isEnabled,
        openCount: tracking.openCount ?? 0,
        lastOpenedAt: tracking.lastOpenedAt,
        opens: opens.map((o) => ({ ...o, id: o._id })),
        clicks: clicks.map((c) => ({ ...c, id: c._id })),
      },
    };
  },
});

export const listByThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    const account = await ctx.db.get(thread.accountId);
    if (!account || (account as Doc<"mailAccounts">).userId !== userId) {
      // Check shared access
      const access = await ctx.db
        .query("threadAccess")
        .withIndex("by_thread_user", (q) =>
          q.eq("threadId", threadId).eq("userId", userId),
        )
        .unique();
      if (!access) throw new Error("Access denied");
    }
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .order("asc")
      .collect();
    return { data: emails };
  },
});

export const listFailed = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const failedArrays = await Promise.all(
      accounts.map((a) =>
        ctx.db
          .query("emails")
          .withIndex("by_account_receivedAt", (q) => q.eq("accountId", a._id))
          .filter((q) => q.eq(q.field("sendStatus"), "FAILED"))
          .collect(),
      ),
    );
    const failed = failedArrays
      .flat()
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((e) => ({
        id: e._id,
        subject: e.subject,
        toAddresses: e.toAddresses,
        sendError: e.sendError,
        sendAttempts: e.sendAttempts,
        createdAt: e._creationTime,
        threadId: e.threadId,
      }));
    return { data: failed };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Attachments — file uploads via Convex storage.
// Frontend flow:
//   1. call generateAttachmentUploadUrl → POST file → get storageId
//   2. include `attachmentUploads: [{ filename, mimeType, size, storageId }]` in send/reply
// ─────────────────────────────────────────────────────────────────────────────

export const generateAttachmentUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getAttachmentUrl = query({
  args: { attachmentId: v.id("attachments") },
  handler: async (ctx, { attachmentId }) => {
    const userId = await requireUser(ctx);
    const attachment = await ctx.db.get(attachmentId);
    if (!attachment) throw new Error("Attachment not found");
    const owned = await ensureEmailOwnedByUser(ctx, attachment.emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (!attachment.storageId) {
      return { url: null, providerAttachmentId: attachment.providerAttachmentId };
    }
    const url = await ctx.storage.getUrl(attachment.storageId);
    return { url, providerAttachmentId: null };
  },
});

// Internal helpers used by the download action below.
export const _getAttachmentForDownload = internalQuery({
  args: { attachmentId: v.id("attachments") },
  handler: async (ctx, { attachmentId }) => {
    const attachment = await ctx.db.get(attachmentId);
    if (!attachment) return null;
    const email = await ctx.db.get(attachment.emailId);
    if (!email) return null;
    const account = await ctx.db.get(email.accountId);
    if (!account) return null;
    return {
      attachment: {
        _id: attachment._id,
        emailId: attachment.emailId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        providerAttachmentId: attachment.providerAttachmentId,
        storageId: attachment.storageId,
      },
      email: { _id: email._id, providerMessageId: email.providerMessageId, accountId: email.accountId },
      account: { _id: account._id, userId: account.userId, provider: account.provider },
    };
  },
});

// Used by oauth.gmail.send / oauth.microsoft.send to attach files. Returns
// only the metadata needed to build a MIME message — the bytes are pulled
// separately via ctx.storage.get(storageId) inside the send action.
export const _getAttachmentsForSend = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .collect();
    return rows
      .filter((r) => r.storageId !== undefined)
      .map((r) => ({
        filename: r.filename,
        mimeType: r.mimeType,
        storageId: r.storageId as Id<"_storage">,
      }));
  },
});

export const _setAttachmentStorageId = internalMutation({
  args: { attachmentId: v.id("attachments"), storageId: v.id("_storage") },
  handler: async (ctx, { attachmentId, storageId }) => {
    await ctx.db.patch(attachmentId, { storageId });
  },
});

/**
 * Public download endpoint. Returns a URL the frontend can fetch.
 * - If the attachment is already in Convex storage → return its URL
 * - Else fetch from Gmail/Microsoft, store in Convex storage, return URL
 *
 * Auth: requires the calling user to own the email.
 */
export const downloadAttachment = action({
  args: { attachmentId: v.id("attachments") },
  handler: async (ctx, { attachmentId }): Promise<{ url: string; filename: string; mimeType: string }> => {
    const userId = await requireUser(ctx);

    const ctxData = (await ctx.runQuery(internal.emails._getAttachmentForDownload, {
      attachmentId,
    })) as {
      attachment: {
        _id: Id<"attachments">;
        emailId: Id<"emails">;
        filename: string;
        mimeType: string;
        providerAttachmentId?: string;
        storageId?: Id<"_storage">;
      };
      email: { _id: Id<"emails">; providerMessageId: string; accountId: Id<"mailAccounts"> };
      account: { _id: Id<"mailAccounts">; userId: Id<"users">; provider: string };
    } | null;

    if (!ctxData) throw new Error("Attachment not found");
    if (ctxData.account.userId !== userId) throw new Error("Not authorized");

    // Already in Convex storage — just return the URL
    if (ctxData.attachment.storageId) {
      const url = await ctx.storage.getUrl(ctxData.attachment.storageId);
      if (!url) throw new Error("Storage URL unavailable");
      return { url, filename: ctxData.attachment.filename, mimeType: ctxData.attachment.mimeType };
    }

    // Need to fetch from provider
    if (!ctxData.attachment.providerAttachmentId) {
      throw new Error("Attachment has no storage and no providerAttachmentId");
    }

    let dataBytes: Uint8Array;
    if (ctxData.account.provider === "GMAIL") {
      const accessToken = await ctx.runAction(internal.oauth.tokenManager.getAccessToken, {
        accountId: ctxData.account._id,
      });
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ctxData.email.providerMessageId}/attachments/${ctxData.attachment.providerAttachmentId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error(`Gmail attachment fetch failed: ${res.status}`);
      const json = (await res.json()) as { data: string };
      // Gmail uses URL-safe base64
      const b64 = json.data.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      dataBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) dataBytes[i] = bin.charCodeAt(i);
    } else if (ctxData.account.provider === "MICROSOFT") {
      const accessToken = await ctx.runAction(internal.oauth.tokenManager.getAccessToken, {
        accountId: ctxData.account._id,
      });
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${ctxData.email.providerMessageId}/attachments/${ctxData.attachment.providerAttachmentId}/$value`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error(`Microsoft attachment fetch failed: ${res.status}`);
      dataBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      throw new Error(`Provider ${ctxData.account.provider} not supported for attachment download`);
    }

    // Store in Convex storage and cache the storageId on the attachment row
    const storageId = await ctx.storage.store(
      new Blob([dataBytes as BlobPart], { type: ctxData.attachment.mimeType }),
    );
    await ctx.runMutation(internal.emails._setAttachmentStorageId, {
      attachmentId: ctxData.attachment._id,
      storageId,
    });
    const url = await ctx.storage.getUrl(storageId);
    if (!url) throw new Error("Storage URL unavailable after upload");
    return { url, filename: ctxData.attachment.filename, mimeType: ctxData.attachment.mimeType };
  },
});

const attachmentUpload = v.object({
  filename: v.string(),
  mimeType: v.string(),
  size: v.number(),
  storageId: v.id("_storage"),
});

const recipient = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Send (compose) — creates thread + email row + attachments + schedules send.
// Mutation only writes; the actual provider send happens in `actuallySend` action.
// ─────────────────────────────────────────────────────────────────────────────

export const send = mutation({
  args: {
    accountId: v.id("mailAccounts"),
    to: v.array(recipient),
    cc: v.optional(v.array(recipient)),
    bcc: v.optional(v.array(recipient)),
    subject: v.string(),
    bodyHtml: v.string(),
    bodyText: v.string(),
    attachments: v.optional(v.array(attachmentUpload)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }

    const now = Date.now();
    const undoDeadlineAt = now + UNDO_WINDOW_MS;
    const uploads = args.attachments ?? [];

    const threadId = await ctx.db.insert("threads", {
      accountId: account._id,
      providerThreadId: newLocalProviderThreadId(),
      subject: args.subject,
      snippet: (args.bodyText || "").slice(0, 200),
      isRead: true,
      isStarred: false,
      isArchived: false,
      isTrashed: false,
      labels: ["SENT"],
      participantEmails: [account.email, ...args.to.map((a) => a.email)],
      messageCount: 1,
      lastMessageAt: now,
    });

    const emailId = await ctx.db.insert("emails", {
      accountId: account._id,
      threadId,
      providerMessageId: newLocalProviderMessageId(),
      references: [],
      fromAddress: account.email,
      fromName: account.displayName || account.email.split("@")[0],
      toAddresses: args.to,
      ccAddresses: args.cc ?? [],
      bccAddresses: args.bcc ?? [],
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      snippet: (args.bodyText || "").slice(0, 200),
      isRead: true,
      isStarred: false,
      isDraft: false,
      labels: ["SENT"],
      hasAttachments: uploads.length > 0,
      receivedAt: now,
      sentAt: now,
      sendStatus: "PENDING_SEND",
      undoDeadlineAt,
      sendAttempts: 0,
    });

    for (const f of uploads) {
      await ctx.db.insert("attachments", {
        emailId,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        storageId: f.storageId,
      });
    }

    await dispatchOutboundContactExtraction(
      ctx,
      account,
      [...args.to, ...(args.cc ?? []), ...(args.bcc ?? [])],
      now,
    );

    await ctx.scheduler.runAfter(UNDO_WINDOW_MS, internal.emails.actuallySend, {
      emailId,
    });

    return { data: { id: emailId, threadId, undoDeadlineAt } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Reply — re-uses an existing thread.
// ─────────────────────────────────────────────────────────────────────────────

export const reply = mutation({
  args: {
    parentEmailId: v.id("emails"),
    accountId: v.id("mailAccounts"),
    // Caller may pass an explicit `to` (the chip list the user edited in the
    // compose UI). If omitted, default to the parent's sender — single-recipient
    // reply behavior.
    to: v.optional(v.array(recipient)),
    bodyHtml: v.optional(v.string()),
    bodyText: v.string(),
    cc: v.optional(v.array(recipient)),
    bcc: v.optional(v.array(recipient)),
    attachments: v.optional(v.array(attachmentUpload)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    const parent = await ctx.db.get(args.parentEmailId);
    if (!parent) throw new Error("Email not found");

    const now = Date.now();
    const undoDeadlineAt = now + UNDO_WINDOW_MS;
    const uploads = args.attachments ?? [];

    const subject = parent.subject.startsWith("Re:")
      ? parent.subject
      : `Re: ${parent.subject}`;

    const replyHtml =
      args.bodyHtml ?? `<p>${args.bodyText.replace(/\n/g, "<br/>")}</p>`;

    const toAddresses =
      args.to && args.to.length > 0
        ? args.to
        : [{ email: parent.fromAddress, name: parent.fromName }];
    if (toAddresses.length === 0) {
      throw new Error("Reply has no recipients");
    }

    const emailId = await ctx.db.insert("emails", {
      accountId: account._id,
      threadId: parent.threadId,
      providerMessageId: newLocalProviderMessageId(),
      inReplyTo: parent.internetMessageId || parent.providerMessageId,
      references: [],
      fromAddress: account.email,
      fromName: account.displayName || account.email.split("@")[0],
      toAddresses,
      ccAddresses: args.cc ?? [],
      bccAddresses: args.bcc ?? [],
      subject,
      bodyText: args.bodyText,
      bodyHtml: replyHtml,
      snippet: (args.bodyText || "").slice(0, 200),
      isRead: true,
      isStarred: false,
      isDraft: false,
      labels: ["SENT"],
      hasAttachments: uploads.length > 0,
      receivedAt: now,
      sentAt: now,
      sendStatus: "PENDING_SEND",
      undoDeadlineAt,
      sendAttempts: 0,
    });

    for (const f of uploads) {
      await ctx.db.insert("attachments", {
        emailId,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        storageId: f.storageId,
      });
    }

    await ctx.db.patch(parent.threadId, {
      snippet: (args.bodyText || "").slice(0, 200),
      lastMessageAt: now,
    });

    await dispatchOutboundContactExtraction(
      ctx,
      account,
      [...toAddresses, ...(args.cc ?? []), ...(args.bcc ?? [])],
      now,
    );

    // Replying resolves any open "Needs Response" signal on this thread.
    // Scheduled (not awaited) so the response stays snappy.
    await ctx.scheduler.runAfter(
      0,
      internal.ai.needsResponseData._dismissOpenSignalsForThread,
      { threadId: parent.threadId, kind: "replied" },
    );

    await ctx.scheduler.runAfter(UNDO_WINDOW_MS, internal.emails.actuallySend, {
      emailId,
    });

    return { data: { id: emailId, threadId: parent.threadId, undoDeadlineAt } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Forward
// ─────────────────────────────────────────────────────────────────────────────

export const forward = mutation({
  args: {
    sourceEmailId: v.id("emails"),
    accountId: v.id("mailAccounts"),
    to: v.array(recipient),
    bodyHtml: v.string(),
    bodyText: v.string(),
    attachments: v.optional(v.array(attachmentUpload)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    const source = await ctx.db.get(args.sourceEmailId);
    if (!source) throw new Error("Email not found");

    const now = Date.now();
    const undoDeadlineAt = now + UNDO_WINDOW_MS;
    const uploads = args.attachments ?? [];

    const subject = source.subject.startsWith("Fwd:")
      ? source.subject
      : `Fwd: ${source.subject}`;

    const emailId = await ctx.db.insert("emails", {
      accountId: account._id,
      threadId: source.threadId,
      providerMessageId: newLocalProviderMessageId(),
      inReplyTo: source.internetMessageId || source.providerMessageId,
      references: [],
      fromAddress: account.email,
      fromName: account.displayName || account.email.split("@")[0],
      toAddresses: args.to,
      ccAddresses: [],
      bccAddresses: [],
      subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      snippet: (args.bodyText || "").slice(0, 200),
      isRead: true,
      isStarred: false,
      isDraft: false,
      labels: ["SENT"],
      hasAttachments: uploads.length > 0,
      receivedAt: now,
      sentAt: now,
      sendStatus: "PENDING_SEND",
      undoDeadlineAt,
      sendAttempts: 0,
    });

    for (const f of uploads) {
      await ctx.db.insert("attachments", {
        emailId,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        storageId: f.storageId,
      });
    }

    await dispatchOutboundContactExtraction(ctx, account, args.to, now);

    await ctx.scheduler.runAfter(
      0,
      internal.ai.needsResponseData._dismissOpenSignalsForThread,
      { threadId: source.threadId, kind: "replied" },
    );

    await ctx.scheduler.runAfter(UNDO_WINDOW_MS, internal.emails.actuallySend, {
      emailId,
    });

    return { data: { id: emailId, threadId: source.threadId, undoDeadlineAt } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Edit (during pending-send window)
// ─────────────────────────────────────────────────────────────────────────────

export const updatePending = mutation({
  args: {
    emailId: v.id("emails"),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    snippet: v.optional(v.string()),
    subject: v.optional(v.string()),
    toAddresses: v.optional(v.array(recipient)),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, args.emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (owned.email.sendStatus !== "PENDING_SEND") {
      throw new Error("Can only edit emails that are pending send");
    }
    const patch: Record<string, unknown> = {};
    if (args.bodyText !== undefined) patch.bodyText = args.bodyText;
    if (args.bodyHtml !== undefined) patch.bodyHtml = args.bodyHtml;
    if (args.snippet !== undefined) patch.snippet = args.snippet;
    if (args.subject !== undefined) patch.subject = args.subject;
    if (args.toAddresses !== undefined) patch.toAddresses = args.toAddresses;
    await ctx.db.patch(args.emailId, patch);
    return { data: await ctx.db.get(args.emailId) };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Undo (during pending-send window). The scheduled `actuallySend` will short-circuit
// when it sees sendStatus === "UNDONE".
// ─────────────────────────────────────────────────────────────────────────────

export const undoSend = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (owned.email.sendStatus !== "PENDING_SEND") {
      throw new Error("Email cannot be undone — already sent or not pending");
    }
    if (
      owned.email.undoDeadlineAt !== undefined &&
      Date.now() > owned.email.undoDeadlineAt
    ) {
      throw new Error("Undo window has expired");
    }
    await ctx.db.patch(emailId, {
      sendStatus: "UNDONE",
      undoneAt: Date.now(),
    });
    return { data: await ctx.db.get(emailId) };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Send-now — bypass the undo window. We simply set status to SENDING and call
// the action directly. The originally-scheduled `actuallySend` will see status
// is no longer PENDING_SEND and skip.
// ─────────────────────────────────────────────────────────────────────────────

export const sendNow = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (owned.email.sendStatus !== "PENDING_SEND") {
      throw new Error("Email is not pending — cannot send now");
    }
    await ctx.db.patch(emailId, {
      sendStatus: "SENDING",
      undoDeadlineAt: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.emails.actuallySend, { emailId });
    return { data: { success: true } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry a failed send
// ─────────────────────────────────────────────────────────────────────────────

export const retrySend = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (owned.email.sendStatus !== "FAILED") {
      throw new Error(
        `Cannot retry — email status is ${owned.email.sendStatus}`,
      );
    }
    await ctx.db.patch(emailId, {
      sendStatus: "SENDING",
      sendError: undefined,
      sendAttempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.emails.actuallySend, { emailId });
    return { data: { message: "Retry queued" } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal action: actually call Gmail/Microsoft to send the email.
// Replaces the BullMQ pending-send + email-send workers.
// ─────────────────────────────────────────────────────────────────────────────

export const actuallySend = internalAction({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    // Action context: load email through internal query.
    const data = await ctx.runQuery(internal.emails._loadForSend, { emailId });
    if (!data) return;
    const { email, account } = data;

    if (email.sendStatus !== "PENDING_SEND" && email.sendStatus !== "SENDING") {
      // UNDONE / SENT / FAILED — skip.
      return;
    }

    try {
      let providerMessageId: string | undefined;
      let internetMessageId: string | undefined;
      if (account.provider === "GMAIL") {
        const result = await ctx.runAction(
          (internal as any).oauth.gmail.send,
          {
            accountId: account._id,
            message: {
              to: email.toAddresses,
              cc: email.ccAddresses ?? [],
              bcc: email.bccAddresses ?? [],
              subject: email.subject,
              bodyHtml: email.bodyHtml,
              bodyText: email.bodyText,
              inReplyTo: email.inReplyTo,
              emailId: email._id,
            },
          },
        );
        providerMessageId = result?.providerMessageId;
        internetMessageId = result?.internetMessageId;
      } else if (account.provider === "MICROSOFT") {
        const result = await ctx.runAction(
          (internal as any).oauth.microsoft.send,
          {
            accountId: account._id,
            message: {
              to: email.toAddresses,
              cc: email.ccAddresses ?? [],
              bcc: email.bccAddresses ?? [],
              subject: email.subject,
              bodyHtml: email.bodyHtml,
              bodyText: email.bodyText,
              inReplyTo: email.inReplyTo,
              emailId: email._id,
            },
          },
        );
        providerMessageId = result?.providerMessageId;
        internetMessageId = result?.internetMessageId;
      } else {
        throw new Error(`Unsupported provider: ${account.provider}`);
      }

      await ctx.runMutation(internal.emails._markSent, {
        emailId,
        providerMessageId,
        internetMessageId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.emails._markFailed, {
        emailId,
        error: message,
      });
      throw err;
    }
  },
});

// Internal helper query used by actuallySend.
export const _loadForSend = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    const account = await ctx.db.get(email.accountId);
    if (!account) return null;
    const thread = await ctx.db.get(email.threadId);
    return { email, account, thread };
  },
});

export const _markSent = internalMutation({
  args: {
    emailId: v.id("emails"),
    providerMessageId: v.optional(v.string()),
    internetMessageId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { emailId, providerMessageId, internetMessageId },
  ) => {
    const email = await ctx.db.get(emailId);
    if (!email) return;
    if (email.sendStatus === "UNDONE") return;
    const patch: Record<string, unknown> = {
      sendStatus: "SENT",
      sentAt: Date.now(),
      undoDeadlineAt: undefined,
    };
    if (providerMessageId) {
      patch.providerMessageId = providerMessageId;
    }
    if (internetMessageId) {
      patch.internetMessageId = internetMessageId;
    }
    await ctx.db.patch(emailId, patch);
  },
});

export const _markFailed = internalMutation({
  args: { emailId: v.id("emails"), error: v.string() },
  handler: async (ctx, { emailId, error }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return;
    await ctx.db.patch(emailId, {
      sendStatus: "FAILED",
      sendError: error,
      sendAttempts: (email.sendAttempts ?? 0) + 1,
    });
  },
});
