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
import { promisedFollowUpText } from "./lib/promiseDetector";
import { injectTracking } from "./lib/trackingInject";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

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

// Re-exported for backwards compatibility. The implementation lives in
// convex/lib/promiseDetector.ts so the sync paths can share it.
function promisedFollowUp(text: string | undefined): boolean {
  return promisedFollowUpText(text);
}

function normalizeAddressList(value: unknown): Array<{ email?: string; name?: string }> {
  if (Array.isArray(value)) return value as Array<{ email?: string; name?: string }>;
  if (!value) return [];
  if (typeof value === "string") return value ? [{ email: value }] : [];
  if (typeof value === "object") return [value as { email?: string; name?: string }];
  return [];
}

function normalizeEmailForClient<T extends Doc<"emails">>(email: T) {
  return {
    ...email,
    id: email._id,
    toAddresses: normalizeAddressList(email.toAddresses),
    ccAddresses: normalizeAddressList(email.ccAddresses),
    bccAddresses: normalizeAddressList(email.bccAddresses),
  };
}

function firstRecipientEmail(toAddresses: unknown): string | null {
  const first = normalizeAddressList(toAddresses)[0];
  return first?.email?.toLowerCase().trim() || null;
}

// Dispatch contact extraction for an outbound email's recipients so people
// the user emails through the app immediately appear in compose autocomplete.
// The sync path (gmailData/_onNewEmailInserted) only fires when sync inserts
// a brand-new row, but our outbound path patches an existing local row, so
// sync reports isNew=false and skips contact extraction. Calling this directly
// from the send mutations fills the gap.
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
        ...normalizeEmailForClient(owned.email),
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
    return { data: emails.map(normalizeEmailForClient) };
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
          .withIndex("by_account_sendStatus_receivedAt", (q) =>
            q.eq("accountId", a._id).eq("sendStatus", "FAILED"),
          )
          .order("desc")
          .take(50),
      ),
    );
    const failed = failedArrays
      .flat()
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((e) => ({
        id: e._id,
        subject: e.subject,
        toAddresses: normalizeAddressList(e.toAddresses),
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
    await ctx.db.patch(attachmentId, {
      storageId,
      // Lets the attachment-blob retention cron age this cache out.
      storageCachedAt: Date.now(),
    });
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
    if (ctxData.account.userId !== userId) {
      // Shared-access grantees (handoff / @mention) may view attachments —
      // the grant already covers the whole thread's content.
      const shared: boolean = await ctx.runQuery(
        internal.emails._userHasThreadAccessForEmail,
        { emailId: ctxData.email._id, userId },
      );
      if (!shared) throw new Error("Not authorized");
    }

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
      hasSentMail: true,
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

    return { data: { id: emailId, threadId, subject: args.subject, undoDeadlineAt } };
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

    // Build References chain. CRUCIAL: only use real RFC-5322 message IDs
    // (parent.internetMessageId). The fallback `providerMessageId` may be a
    // local placeholder ("local-...") if the parent itself hasn't been
    // delivered yet — stuffing that into In-Reply-To/References makes Gmail's
    // send API reject the message (and the row gets stuck in SENDING). Walk
    // up the thread to find the nearest ancestor with a real internetMessageId.
    let parentId: string | undefined = parent.internetMessageId;
    let walker = parent;
    while (!parentId && walker.inReplyTo) {
      const nextWalker = await ctx.db
        .query("emails")
        .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", parent.threadId))
        .collect();
      const found = nextWalker.find(
        (e) =>
          e.internetMessageId === walker.inReplyTo ||
          e.providerMessageId === walker.inReplyTo,
      );
      if (!found) break;
      walker = found;
      parentId = walker.internetMessageId;
    }
    const referencesChain = Array.from(
      new Set<string>(
        [
          ...(parent.references ?? []).filter((r) => !r.startsWith("local-")),
          parentId,
        ].filter(Boolean) as string[],
      ),
    );

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
      // Only set inReplyTo when we have a REAL message id. Otherwise leave
      // it undefined and rely on Gmail's threadId / Microsoft conversationId
      // for threading.
      inReplyTo: parentId,
      references: referencesChain,
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
      hasSentMail: true,
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

    return { data: { id: emailId, threadId: parent.threadId, subject, undoDeadlineAt } };
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

    return { data: { id: emailId, threadId: source.threadId, subject, undoDeadlineAt } };
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

export const editPendingSend = mutation({
  args: {
    emailId: v.id("emails"),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
  },
  handler: async (ctx, { emailId, bodyText, bodyHtml }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (owned.email.sendStatus !== "PENDING_SEND") {
      throw new Error("Email cannot be edited — already sent or not pending");
    }
    const patch: Record<string, unknown> = {};
    if (bodyText !== undefined) {
      patch.bodyText = bodyText;
      patch.snippet = bodyText.slice(0, 200);
    }
    if (bodyHtml !== undefined) patch.bodyHtml = bodyHtml;
    if (Object.keys(patch).length > 0) await ctx.db.patch(emailId, patch);
    return { data: { success: true } };
  },
});

export const sendNow = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (owned.email.sendStatus !== "PENDING_SEND") {
      throw new Error("Email is not pending — cannot send now");
    }
    // Leave the row PENDING_SEND — actuallySend's atomic claim performs the
    // PENDING_SEND→SENDING transition. Clearing the undo deadline here just
    // stops the undo UI; the claim is what actually closes the race with the
    // original undo-window job (whichever invocation claims first sends,
    // the other no-ops).
    await ctx.db.patch(emailId, { undoDeadlineAt: undefined });
    await ctx.scheduler.runAfter(0, internal.emails.actuallySend, { emailId });
    return { data: { success: true } };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry a failed send
// ─────────────────────────────────────────────────────────────────────────────

export const discardFailedSend = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const owned = await ensureEmailOwnedByUser(ctx, emailId, userId);
    if (!owned) throw new Error("Email not found");
    if (
      owned.email.sendStatus !== "FAILED" &&
      owned.email.sendStatus !== "UNDONE"
    ) {
      throw new Error(
        `Cannot discard — send status is ${owned.email.sendStatus}`,
      );
    }
    const atts = await ctx.db
      .query("attachments")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .collect();
    for (const a of atts) await ctx.db.delete(a._id);
    const body = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (body) await ctx.db.delete(body._id);
    await ctx.db.delete(emailId);
    return { data: { success: true } };
  },
});

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
      sendStatus: "PENDING_SEND",
      sendError: undefined,
      sendAttempts: 0,
      sendingStartedAt: undefined,
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
  args: {
    emailId: v.id("emails"),
    // Present when this send came from a scheduledEmails row — lets the
    // sent/failed marks reconcile that row too.
    scheduledEmailId: v.optional(v.id("scheduledEmails")),
  },
  handler: async (ctx, { emailId, scheduledEmailId }) => {
    // Atomically claim the email BEFORE touching the provider. Actions are
    // at-most-once, and several paths can schedule a send for the same email
    // (undo-window job, send-now, cron safety nets) — the claim guarantees
    // only one of them talks to Gmail/Outlook, and closes the undo race:
    // once claimed, undoSend throws instead of "undoing" a delivered email.
    const claim: { ok: boolean } = await ctx.runMutation(
      internal.emails._claimForSend,
      { emailId },
    );
    if (!claim.ok) return;

    // Action context: load email through internal query.
    const data = await ctx.runQuery(internal.emails._loadForSend, { emailId });
    if (!data) return;
    const { email, account, thread, parentReferences } = data;

    // Build full References header per RFC 5322. CRUCIAL: drop any local
    // placeholder ids ("local-*") — those are fake message ids we create
    // before send and would break Gmail / Outlook threading if leaked into
    // the outgoing headers.
    const isLocal = (s: string | undefined): boolean =>
      !!s && s.startsWith("local-");
    const cleanRefs = (parentReferences ?? []).filter((r) => !isLocal(r));
    const cleanInReplyTo = isLocal(email.inReplyTo) ? undefined : email.inReplyTo;
    const referencesChain: string[] = [...cleanRefs];
    if (cleanInReplyTo && !referencesChain.includes(cleanInReplyTo)) {
      referencesChain.push(cleanInReplyTo);
    }
    // Gmail's API uses its own threadId (the providerThreadId on our thread
    // row) to glue messages into the same conversation. Pass it through
    // when the thread already has a real provider thread id — even if we
    // don't have a parent message id, threadId is enough to keep Gmail
    // threading.
    // Orbi sometimes synthesizes sub-thread ids like "19e2d4f1de1fbd14::1"
    // for Gmail conversations that split by subject divergence. The real
    // Gmail thread id is the part before "::". Strip the suffix before
    // handing it to the API, otherwise Gmail returns
    // "Invalid thread_id value".
    const rawProviderThreadId =
      thread?.providerThreadId && !thread.providerThreadId.startsWith("local-")
        ? thread.providerThreadId
        : undefined;
    const providerThreadId = rawProviderThreadId?.includes("::")
      ? rawProviderThreadId.split("::")[0]
      : rawProviderThreadId;

    // Open/click tracking: inject the pixel + rewrite links on the OUTGOING
    // copy only (the local emailBodies copy stays clean, so viewing your own
    // sent mail never fires the tracker). Skips text-only messages and the
    // system emails that have no HTML.
    let outgoingHtml = email.bodyHtml ?? "";
    if (outgoingHtml) {
      try {
        const siteUrl = process.env.CONVEX_SITE_URL;
        if (siteUrl) {
          const trackingId = crypto.randomUUID().replace(/-/g, "");
          const injected = injectTracking(outgoingHtml, trackingId, siteUrl);
          await ctx.runMutation(internal.tracking.pixel._createTracking, {
            emailId,
            trackingId,
            linkMap: injected.linkMap,
          });
          outgoingHtml = injected.html;
        }
      } catch (err) {
        // Tracking must never block a send — fall back to the clean HTML.
        console.error("[tracking] injection failed, sending untracked:", err);
        outgoingHtml = email.bodyHtml ?? "";
      }
    }

    try {
      let providerMessageId: string | undefined;
      let internetMessageId: string | undefined;
      // These are the FULL senders (convex/oauth/gmail.ts / microsoft.ts):
      // they attach uploaded files from Convex storage, set a From header,
      // and (Gmail) generate a real Message-ID. The stripped-down duplicates
      // in oauth/send.ts that used to be called here silently dropped every
      // attachment — that module is deleted.
      if (account.provider === "GMAIL") {
        const result = await ctx.runAction(
          internal.oauth.gmail.send,
          {
            accountId: account._id,
            message: {
              to: email.toAddresses,
              cc: email.ccAddresses ?? [],
              bcc: email.bccAddresses ?? [],
              subject: email.subject,
              bodyHtml: outgoingHtml,
              bodyText: email.bodyText ?? "",
              inReplyTo: cleanInReplyTo,
              references: referencesChain,
              providerThreadId,
              emailId: email._id,
            },
          },
        );
        providerMessageId = result?.providerMessageId;
        internetMessageId = result?.internetMessageId;
      } else if (account.provider === "MICROSOFT") {
        const result = await ctx.runAction(
          internal.oauth.microsoft.send,
          {
            accountId: account._id,
            message: {
              to: email.toAddresses,
              cc: email.ccAddresses ?? [],
              bcc: email.bccAddresses ?? [],
              subject: email.subject,
              bodyHtml: outgoingHtml,
              bodyText: email.bodyText ?? "",
              inReplyTo: cleanInReplyTo,
              references: referencesChain,
              emailId: email._id,
            },
          },
        );
        providerMessageId = result?.providerMessageId;
      } else {
        throw new Error(`Unsupported provider: ${account.provider}`);
      }

      await ctx.runMutation(internal.emails._markSent, {
        emailId,
        providerMessageId,
        internetMessageId,
        scheduledEmailId,
      });

      const contactEmail = firstRecipientEmail(email.toAddresses);
      if (contactEmail && promisedFollowUp(email.bodyText || email.bodyHtml)) {
        await ctx.runMutation(internal.followUps._ensureWatchForEmail, {
          userId: account.userId,
          threadId: email.threadId,
          emailId: String(email._id),
          contactEmail,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.emails._markFailed, {
        emailId,
        error: message,
        scheduledEmailId,
      });
      throw err;
    }
  },
});

// Atomic PENDING_SEND/stale-SENDING → SENDING transition. All send entry
// points funnel through this so exactly one invocation proceeds to the
// provider; everything else no-ops. A SENDING claim younger than
// IN_FLIGHT_MS is treated as live (another invocation is mid-call).
const IN_FLIGHT_MS = 5 * 60_000;

export const _claimForSend = internalMutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<{ ok: boolean }> => {
    const email = await ctx.db.get(emailId);
    if (!email) return { ok: false };
    const now = Date.now();
    if (email.sendStatus === "PENDING_SEND") {
      await ctx.db.patch(emailId, {
        sendStatus: "SENDING",
        sendingStartedAt: now,
        undoDeadlineAt: undefined,
      });
      return { ok: true };
    }
    if (email.sendStatus === "SENDING") {
      const started = email.sendingStartedAt;
      if (started !== undefined && now - started < IN_FLIGHT_MS) {
        return { ok: false }; // live in-flight send owns this email
      }
      // Stale claim (owning action died) or legacy SENDING row — take over.
      await ctx.db.patch(emailId, { sendingStartedAt: now });
      return { ok: true };
    }
    // UNDONE / SENT / FAILED / NONE — nothing to do.
    return { ok: false };
  },
});

// Internal helper query used by actuallySend. Also returns the thread (for
// providerThreadId, needed to keep Gmail replies in the same conversation)
// and the parent message's internetMessageId + references chain so we can
// build proper RFC-5322 References headers.
export const _loadForSend = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    let email = await ctx.db.get(emailId);
    if (!email) return null;
    const account = await ctx.db.get(email.accountId);
    if (!account) return null;
    // Provider-synced drafts keep their body in `emailBodies`, not on the
    // row — without this fallback, sending such a draft delivers an empty
    // message.
    if (!email.bodyHtml && !email.bodyText) {
      const bodyRow = await ctx.db
        .query("emailBodies")
        .withIndex("by_email", (q) => q.eq("emailId", emailId))
        .unique();
      if (bodyRow) {
        email = {
          ...email,
          bodyHtml: bodyRow.bodyHtml,
          bodyText: bodyRow.bodyText,
        };
      }
    }
    const thread = await ctx.db.get(email.threadId);
    // Try to locate the parent email (the one we're replying to) so we can
    // build a correct References chain. Match by internetMessageId against
    // this email's inReplyTo.
    let parentReferences: string[] | undefined;
    let parentProviderMessageId: string | undefined;
    if (email.inReplyTo) {
      const parent = await ctx.db
        .query("emails")
        .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", email.threadId))
        .collect();
      const match = parent.find(
        (p) =>
          p.internetMessageId === email.inReplyTo ||
          p.providerMessageId === email.inReplyTo,
      );
      if (match) {
        parentReferences = match.references ?? [];
        parentProviderMessageId = match.providerMessageId;
      }
    }
    return {
      email,
      account,
      thread,
      parentReferences,
      parentProviderMessageId,
    };
  },
});

// Shared-access check for attachment/body reads by non-owners.
export const _userHasThreadAccessForEmail = internalQuery({
  args: { emailId: v.id("emails"), userId: v.id("users") },
  handler: async (ctx, { emailId, userId }): Promise<boolean> => {
    const email = await ctx.db.get(emailId);
    if (!email) return false;
    const access = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) =>
        q.eq("threadId", email.threadId).eq("userId", userId),
      )
      .unique();
    return !!access;
  },
});

export const _getAttachmentForHttp = internalQuery({
  args: { userId: v.id("users"), attachmentId: v.id("attachments") },
  handler: async (ctx, { userId, attachmentId }) => {
    const attachment = await ctx.db.get(attachmentId);
    if (!attachment) return null;
    const email = await ctx.db.get(attachment.emailId);
    if (!email) return null;
    const account = await ctx.db.get(email.accountId);
    if (!account) return null;
    if (account.userId !== userId) {
      const access = await ctx.db
        .query("threadAccess")
        .withIndex("by_thread_user", (q) =>
          q.eq("threadId", email.threadId).eq("userId", userId),
        )
        .unique();
      if (!access) return null;
    }
    return {
      attachment: {
        _id: attachment._id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        providerAttachmentId: attachment.providerAttachmentId,
        storageId: attachment.storageId,
      },
      email: {
        providerMessageId: email.providerMessageId,
      },
      account: {
        _id: account._id,
        provider: account.provider,
      },
    };
  },
});

export const _markSent = internalMutation({
  args: {
    emailId: v.id("emails"),
    providerMessageId: v.optional(v.string()),
    internetMessageId: v.optional(v.string()),
    scheduledEmailId: v.optional(v.id("scheduledEmails")),
  },
  handler: async (
    ctx,
    { emailId, providerMessageId, internetMessageId, scheduledEmailId },
  ) => {
    const email = await ctx.db.get(emailId);
    if (!email) return;
    if (email.sendStatus === "UNDONE") return;
    const patch: Record<string, unknown> = {
      sendStatus: "SENT",
      sentAt: Date.now(),
      undoDeadlineAt: undefined,
      sendingStartedAt: undefined,
    };
    if (providerMessageId) {
      patch.providerMessageId = providerMessageId;
    }
    if (internetMessageId) {
      patch.internetMessageId = internetMessageId;
    }
    await ctx.db.patch(emailId, patch);
    // Chokepoint for the denormalized Sent-folder flag: every successful
    // provider send passes through here (compose, reply, forward, drafts,
    // scheduled), so the thread is guaranteed to be marked.
    const threadForFlag = await ctx.db.get(email.threadId);
    if (threadForFlag && !threadForFlag.hasSentMail) {
      await ctx.db.patch(email.threadId, { hasSentMail: true });
    }
    if (scheduledEmailId) {
      const row = await ctx.db.get(scheduledEmailId);
      if (row && row.status === "SENDING") {
        await ctx.db.patch(scheduledEmailId, { status: "SENT" });
      }
    }
  },
});

export const _markFailed = internalMutation({
  args: {
    emailId: v.id("emails"),
    error: v.string(),
    scheduledEmailId: v.optional(v.id("scheduledEmails")),
  },
  handler: async (ctx, { emailId, error, scheduledEmailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return;
    await ctx.db.patch(emailId, {
      sendStatus: "FAILED",
      sendError: error,
      sendAttempts: (email.sendAttempts ?? 0) + 1,
      sendingStartedAt: undefined,
    });
    if (scheduledEmailId) {
      const row = await ctx.db.get(scheduledEmailId);
      if (row && row.status === "SENDING") {
        await ctx.db.patch(scheduledEmailId, {
          status: "FAILED",
          failureReason: error,
        });
      }
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled-send materialization. A scheduledEmails row is just a saved
// intent — when it comes due, this turns it into a real `emails` row (the
// thing actuallySend knows how to deliver), mirroring what the send/reply
// mutations do at compose time. Called by scheduledEmails.dispatchOne inside
// its mutation transaction. Validates BEFORE inserting anything so a throw
// leaves no partial rows behind.
// ─────────────────────────────────────────────────────────────────────────────

function asAddressList(
  value: unknown,
): Array<{ email: string; name?: string }> {
  if (!Array.isArray(value)) return [];
  return (value as Array<{ email?: string; name?: string }>)
    .filter((a): a is { email: string; name?: string } => !!a?.email && a.email.trim().length > 0);
}

export async function materializeScheduledEmail(
  ctx: MutationCtx,
  row: Doc<"scheduledEmails">,
): Promise<Id<"emails">> {
  const account = await ctx.db.get(row.accountId);
  if (!account) throw new Error("Mail account no longer exists");

  // Resolve the reply parent when there is one. parentEmailId is stored as a
  // plain string; normalizeId rejects garbage without throwing.
  let parent: Doc<"emails"> | null = null;
  if (row.parentEmailId) {
    const pid = ctx.db.normalizeId("emails", row.parentEmailId);
    if (pid) parent = await ctx.db.get(pid);
  }

  // Recipients: what the user saved, falling back (for replies) to the
  // parent's sender — the same default the live reply mutation applies.
  let toAddresses = asAddressList(row.toAddresses);
  if (toAddresses.length === 0 && parent) {
    toAddresses = [{ email: parent.fromAddress, name: parent.fromName }];
  }
  if (toAddresses.length === 0) {
    throw new Error("Scheduled email has no recipients");
  }
  const ccAddresses = asAddressList(row.ccAddresses);
  const bccAddresses = asAddressList(row.bccAddresses);

  const now = Date.now();
  const isReply = !!parent && row.mode === "reply";

  // Threading headers for replies — same rules as the reply mutation: only
  // real RFC-5322 message ids (never "local-…" placeholders).
  let inReplyTo: string | undefined;
  let references: string[] = [];
  if (isReply && parent) {
    inReplyTo = parent.internetMessageId;
    references = Array.from(
      new Set(
        [
          ...(parent.references ?? []).filter((r) => !r.startsWith("local-")),
          inReplyTo,
        ].filter(Boolean) as string[],
      ),
    );
  }

  // Thread: replies join the parent's thread; otherwise use the saved
  // threadId (forward) or open a fresh thread (compose).
  let threadId: Id<"threads">;
  if (isReply && parent) {
    threadId = parent.threadId;
  } else if (row.threadId) {
    const t = await ctx.db.get(row.threadId);
    if (!t) throw new Error("Thread no longer exists");
    threadId = row.threadId;
  } else {
    threadId = await ctx.db.insert("threads", {
      accountId: account._id,
      providerThreadId: newLocalProviderThreadId(),
      subject: row.subject,
      snippet: (row.bodyText || "").slice(0, 200),
      isRead: true,
      isStarred: false,
      isArchived: false,
      isTrashed: false,
      labels: ["SENT"],
      participantEmails: [account.email, ...toAddresses.map((a) => a.email)],
      messageCount: 1,
      lastMessageAt: now,
      hasSentMail: true,
    });
  }

  const uploads = row.attachments ?? [];
  const emailId = await ctx.db.insert("emails", {
    accountId: account._id,
    threadId,
    providerMessageId: newLocalProviderMessageId(),
    inReplyTo,
    references,
    fromAddress: account.email,
    fromName: account.displayName || account.email.split("@")[0],
    toAddresses,
    ccAddresses,
    bccAddresses,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    snippet: (row.bodyText || "").slice(0, 200),
    isRead: true,
    isStarred: false,
    isDraft: false,
    labels: ["SENT"],
    hasAttachments: uploads.length > 0,
    receivedAt: now,
    sentAt: now,
    sendStatus: "PENDING_SEND",
    sendAttempts: 0,
  });

  // Files uploaded at schedule time become attachment rows on the real
  // email — the provider senders read these (via _getAttachmentsForSend)
  // and attach the stored bytes.
  for (const f of uploads) {
    await ctx.db.insert("attachments", {
      emailId,
      filename: f.filename,
      mimeType: f.mimeType,
      size: f.size,
      storageId: f.storageId,
    });
  }

  if (isReply && parent) {
    await ctx.db.patch(threadId, {
      snippet: (row.bodyText || "").slice(0, 200),
      lastMessageAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.ai.needsResponseData._dismissOpenSignalsForThread,
      { threadId, kind: "replied" },
    );
  }

  await dispatchOutboundContactExtraction(
    ctx,
    account,
    [...toAddresses, ...ccAddresses, ...bccAddresses],
    now,
  );

  return emailId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stuck-send sweeper (cron, every 10 min). Sends must never be silently
// lost: a SENDING row whose claim went stale means the action died mid-call
// — surface it as FAILED (the message may or may not have reached the
// provider, so the error says to check before retrying rather than
// auto-retrying and risking a double-send). A PENDING_SEND row whose
// undo-window job evidently never fired gets its send re-scheduled — safe,
// because actuallySend's claim makes re-dispatch idempotent.
// ─────────────────────────────────────────────────────────────────────────────

const SEND_STALE_MS = 10 * 60_000;

export const sweepStuckSends = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let failed = 0;
    let redispatched = 0;

    const sending = await ctx.db
      .query("emails")
      .withIndex("by_sendStatus_undoDeadline", (q) =>
        q.eq("sendStatus", "SENDING"),
      )
      .take(100);
    for (const e of sending) {
      const started = e.sendingStartedAt ?? e._creationTime;
      if (now - started > SEND_STALE_MS) {
        await ctx.db.patch(e._id, {
          sendStatus: "FAILED",
          sendError:
            "Send timed out — it may or may not have been delivered. Check the conversation before retrying.",
          sendAttempts: (e.sendAttempts ?? 0) + 1,
          sendingStartedAt: undefined,
        });
        failed++;
      }
    }

    const pending = await ctx.db
      .query("emails")
      .withIndex("by_sendStatus_undoDeadline", (q) =>
        q.eq("sendStatus", "PENDING_SEND"),
      )
      .take(100);
    for (const e of pending) {
      // The send job fires at undoDeadlineAt (or immediately for send-now,
      // which clears the deadline). Well past that with the row still
      // pending ⇒ the scheduled job was lost — re-dispatch.
      const dueAt = e.undoDeadlineAt ?? e._creationTime + UNDO_WINDOW_MS;
      if (now - dueAt > SEND_STALE_MS) {
        await ctx.scheduler.runAfter(0, internal.emails.actuallySend, {
          emailId: e._id,
        });
        redispatched++;
      }
    }

    // Reconcile scheduledEmails rows stuck in SENDING with their linked
    // email (or fail them if dispatch never produced one).
    const stuckScheduled = await ctx.db
      .query("scheduledEmails")
      .withIndex("by_status_sendAt", (q) =>
        q.eq("status", "SENDING").lte("sendAt", now - SEND_STALE_MS),
      )
      .take(50);
    for (const row of stuckScheduled) {
      const emailId = row.sentEmailId
        ? ctx.db.normalizeId("emails", row.sentEmailId)
        : null;
      const email = emailId ? await ctx.db.get(emailId) : null;
      if (!email) {
        await ctx.db.patch(row._id, {
          status: "FAILED",
          failureReason: "Dispatch failed before a send could start.",
        });
        failed++;
      } else if (email.sendStatus === "SENT") {
        await ctx.db.patch(row._id, { status: "SENT" });
      } else if (email.sendStatus === "FAILED") {
        await ctx.db.patch(row._id, {
          status: "FAILED",
          failureReason: email.sendError ?? "Send failed",
        });
      }
      // PENDING_SEND / SENDING → the email sweeps above handle it; this
      // reconciler catches it on a later pass.
    }

    return { failed, redispatched };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// System-authored outbound email (team invites, future digests). Creates the
// thread + email rows exactly like the send mutation would and dispatches
// immediately — no undo window, no user session (callers must do their own
// authorization). Delivery flows through the same actuallySend pipeline as
// everything else (claim, attachments, failure marking).
// ─────────────────────────────────────────────────────────────────────────────

export async function insertSystemOutboundEmail(
  ctx: MutationCtx,
  args: {
    accountId: Id<"mailAccounts">;
    to: Array<{ email: string; name?: string }>;
    subject: string;
    bodyHtml: string;
    bodyText: string;
  },
): Promise<Id<"emails">> {
  const account = await ctx.db.get(args.accountId);
  if (!account) throw new Error("Mail account not found");
  const now = Date.now();

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
    hasSentMail: true,
  });

  const emailId = await ctx.db.insert("emails", {
    accountId: account._id,
    threadId,
    providerMessageId: newLocalProviderMessageId(),
    references: [],
    fromAddress: account.email,
    fromName: account.displayName || account.email.split("@")[0],
    toAddresses: args.to,
    ccAddresses: [],
    bccAddresses: [],
    subject: args.subject,
    bodyText: args.bodyText,
    bodyHtml: args.bodyHtml,
    snippet: (args.bodyText || "").slice(0, 200),
    isRead: true,
    isStarred: false,
    isDraft: false,
    labels: ["SENT"],
    hasAttachments: false,
    receivedAt: now,
    sentAt: now,
    sendStatus: "PENDING_SEND",
    sendAttempts: 0,
  });

  await ctx.scheduler.runAfter(0, internal.emails.actuallySend, { emailId });
  return emailId;
}
