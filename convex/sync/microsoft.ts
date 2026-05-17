"use node";

// ─────────────────────────────────────────────────────────────────────────────
// microsoft.ts — Microsoft Graph incremental sync action.
//
// Port of:
//   - packages/backend/src/services/microsoft/microsoft-sync.ts
//   - packages/backend/src/workers/microsoft-sync.worker.ts
//
// Public actions:
//   - syncIncremental({ accountId })  — entry point; uses /me/messages/delta
//     when a syncCursor is present, otherwise lists recent inbox messages and
//     stores a fresh deltaLink for next run.
//   - _continueSync                    — paginates through delta result pages.
//
// Plus an OOO auto-reply helper (`_sendAutoReplyIfAllowed`) that mirrors the
// gmail one.  The data layer lives in microsoftData.ts so we don't mix
// query/mutation handlers into a "use node" file.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { withRefreshOn401 } from "../oauth/tokenManager";
import { preprocessEmailBody } from "../lib/emailPreprocess";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// `body` is intentionally omitted — full bodies are the biggest egress driver
// on incremental sync (~50-500 KB of HTML per message). They're fetched
// on-demand when the user opens the message (see convex/sync/onDemandBody.ts).
// `bodyPreview` (~255 chars) is kept as the snippet for list rendering.
const MESSAGE_SELECT_FIELDS = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "isRead",
  "isDraft",
  "hasAttachments",
  "flag",
  "parentFolderId",
  "internetMessageId",
  "internetMessageHeaders",
].join(",");

interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  parentFolderId?: string;
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  "@removed"?: { reason: string };
}

interface DeltaPage {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

class GraphHttpError extends Error {
  status: number;
  retryAfter: number | null;
  graphCode: string | null;
  constructor(
    status: number,
    message: string,
    retryAfter: number | null,
    graphCode: string | null,
  ) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.graphCode = graphCode;
  }
}

async function graphFetch(url: string, accessToken: string): Promise<DeltaPage> {
  const fullUrl = url.startsWith("http") ? url : `${GRAPH_BASE}${url}`;
  const res = await fetch(fullUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let code: string | null = null;
    try {
      code = JSON.parse(text)?.error?.code ?? null;
    } catch {
      // not JSON
    }
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : null;
    throw new GraphHttpError(
      res.status,
      `Graph ${res.status}: ${text.slice(0, 300)}`,
      Number.isFinite(retryAfter) ? retryAfter : null,
      code,
    );
  }
  return (await res.json()) as DeltaPage;
}

function parseRecipients(
  recipients: GraphRecipient[] | undefined,
): { email: string; name?: string }[] {
  return (recipients || []).map((r) => ({
    email: r.emailAddress.address,
    ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}),
  }));
}

function getInternetHeader(
  headers: { name: string; value: string }[] | undefined,
  name: string,
): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Resolve a parentFolderId to our label set ("INBOX", "SENT", etc.) by
 * looking up the well-known folders for this mailbox once and caching them
 * inside the sync run.
 */
async function buildFolderMap(
  accessToken: string,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const wellKnown: { name: string; label: string }[] = [
    { name: "inbox", label: "INBOX" },
    { name: "sentitems", label: "SENT" },
    { name: "drafts", label: "DRAFT" },
    { name: "deleteditems", label: "TRASH" },
    { name: "archive", label: "ARCHIVE" },
    { name: "junkemail", label: "SPAM" },
  ];
  for (const f of wellKnown) {
    try {
      const folder = (await graphFetch(
        `/me/mailFolders/${f.name}?$select=id`,
        accessToken,
      )) as { id?: string };
      if (folder?.id) map.set(folder.id, [f.label]);
    } catch {
      // Folder may not exist (e.g., no archive). Skip silently.
    }
  }
  return map;
}

interface SyncAccountInfo {
  _id: Id<"mailAccounts">;
  userId: Id<"users">;
  email: string;
  syncCursor: string | null;
  userEmails: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-message processing (writes through internal mutations).
// ─────────────────────────────────────────────────────────────────────────────

interface ConversationContext {
  accountId: Id<"mailAccounts">;
  userId: Id<"users">;
  userEmails: string[];
  folderMap: Map<string, string[]>;
}

function resolveLabels(
  folderMap: Map<string, string[]>,
  parentFolderId: string | undefined,
): string[] {
  if (!parentFolderId) return [];
  return folderMap.get(parentFolderId) ?? [];
}

async function syncConversationMessages(
  ctx: ActionCtx,
  conversationId: string,
  messages: GraphMessage[],
  accessToken: string,
  cctx: ConversationContext,
): Promise<void> {
  if (messages.length === 0) return;

  // Sort ascending by receivedDateTime.
  messages.sort(
    (a, b) =>
      new Date(a.receivedDateTime).getTime() -
      new Date(b.receivedDateTime).getTime(),
  );

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];

  const subject = firstMsg.subject || "(no subject)";
  const snippet = lastMsg.bodyPreview || "";

  // Aggregate participants and labels across the conversation.
  const participants = new Set<string>();
  const allLabels = new Set<string>();
  for (const msg of messages) {
    if (msg.from?.emailAddress?.address) {
      participants.add(msg.from.emailAddress.address);
    }
    for (const r of msg.toRecipients ?? []) {
      if (r.emailAddress?.address) participants.add(r.emailAddress.address);
    }
    for (const lbl of resolveLabels(cctx.folderMap, msg.parentFolderId)) {
      allLabels.add(lbl);
    }
  }
  const threadLabels = [...allLabels];

  const hasUnread = messages.some((m) => !m.isRead);
  const hasStarred = messages.some((m) => m.flag?.flagStatus === "flagged");
  const lastDate = new Date(lastMsg.receivedDateTime).getTime();

  let lastReceivedAt: number | undefined;
  for (const msg of [...messages].reverse()) {
    const fromEmail = msg.from?.emailAddress?.address?.toLowerCase();
    if (fromEmail && !cctx.userEmails.includes(fromEmail)) {
      lastReceivedAt = new Date(msg.receivedDateTime).getTime();
      break;
    }
  }

  // 1. Upsert the thread — gated by a fingerprint check so we don't
  //    call into the mutation (and re-fire `threads.list`) when nothing
  //    about the conversation has actually changed.
  const threadIsArchived =
    !threadLabels.includes("INBOX") && !threadLabels.includes("SENT");
  const threadIsTrashed = threadLabels.includes("TRASH");
  const participantList = [...participants];
  const fp = (await ctx.runQuery(
    internal.sync.microsoftData._getThreadFingerprint,
    {
      accountId: cctx.accountId,
      providerThreadId: conversationId,
    },
  )) as {
    id: Id<"threads">;
    subject: string;
    snippet?: string;
    isRead: boolean;
    isStarred: boolean;
    isArchived: boolean;
    isTrashed: boolean;
    labels: string[];
    participantEmails: string[];
    messageCount: number;
    lastMessageAt: number;
    lastReceivedAt?: number;
  } | null;
  let threadId: Id<"threads">;
  const fpMatches =
    fp &&
    fp.subject === subject &&
    fp.snippet === snippet &&
    fp.isRead === !hasUnread &&
    fp.isStarred === hasStarred &&
    fp.isArchived === threadIsArchived &&
    fp.isTrashed === threadIsTrashed &&
    fp.messageCount === messages.length &&
    fp.lastMessageAt === lastDate &&
    (fp.lastReceivedAt ?? undefined) === (lastReceivedAt ?? undefined) &&
    fp.labels.length === threadLabels.length &&
    fp.labels.every((l, i) => l === threadLabels[i]) &&
    fp.participantEmails.length === participantList.length &&
    fp.participantEmails.every((p, i) => p === participantList[i]);
  if (fpMatches) {
    threadId = fp!.id;
  } else {
    threadId = await ctx.runMutation(
      internal.sync.microsoftData._upsertThread,
      {
        accountId: cctx.accountId,
        providerThreadId: conversationId,
        subject,
        snippet,
        isRead: !hasUnread,
        isStarred: hasStarred,
        isArchived: threadIsArchived,
        isTrashed: threadIsTrashed,
        labels: threadLabels,
        participantEmails: participantList,
        messageCount: messages.length,
        lastMessageAt: lastDate,
        ...(lastReceivedAt !== undefined ? { lastReceivedAt } : {}),
      },
    );
  }

  // 2. Upsert each message and dispatch post-insert work for new ones.
  for (const msg of messages) {
    const msgLabels = resolveLabels(cctx.folderMap, msg.parentFolderId);
    const inReplyTo =
      getInternetHeader(msg.internetMessageHeaders, "In-Reply-To") || undefined;
    const referencesRaw =
      getInternetHeader(msg.internetMessageHeaders, "References") || "";
    const refs = referencesRaw.split(/\s+/).filter(Boolean);

    const fromEmail = msg.from?.emailAddress?.address ?? "unknown";
    const fromName = msg.from?.emailAddress?.name;

    const bodyHtml =
      msg.body?.contentType?.toLowerCase() === "html" ? msg.body.content : undefined;
    const bodyText =
      msg.body?.contentType?.toLowerCase() === "text" ? msg.body.content : undefined;

    const receivedAt = new Date(msg.receivedDateTime).getTime();
    const sentAt = msg.sentDateTime
      ? new Date(msg.sentDateTime).getTime()
      : undefined;

    // Pre-check: if the email already exists and nothing about it changed,
    // skip both the body preprocessing and the upsert mutation entirely.
    // This is what eliminates the steady `_upsertEmail` log spam from
    // Microsoft Graph's chatty delta feed.
    const msgLabelsForCheck = msgLabels;
    const isRead = !!msg.isRead;
    const isStarred = msg.flag?.flagStatus === "flagged";
    const fingerprint = (await ctx.runQuery(
      internal.sync.microsoftData._getEmailFingerprint,
      { providerMessageId: msg.id },
    )) as {
      id: Id<"emails">;
      threadId: Id<"threads">;
      isRead: boolean;
      isStarred: boolean;
      labels: string[];
    } | null;
    if (
      fingerprint &&
      fingerprint.threadId === threadId &&
      fingerprint.isRead === isRead &&
      fingerprint.isStarred === isStarred &&
      fingerprint.labels.length === msgLabelsForCheck.length &&
      fingerprint.labels.every((l, i) => l === msgLabelsForCheck[i])
    ) {
      continue;
    }

    const pre = preprocessEmailBody(bodyHtml, bodyText, msg.subject || "");

    const upsertResult = (await ctx.runMutation(
      internal.sync.microsoftData._upsertEmail,
      {
        accountId: cctx.accountId,
        threadId,
        providerMessageId: msg.id,
        internetMessageId: msg.internetMessageId,
        inReplyTo,
        references: refs,
        fromAddress: fromEmail,
        fromName,
        toAddresses: parseRecipients(msg.toRecipients),
        ccAddresses: parseRecipients(msg.ccRecipients),
        bccAddresses: parseRecipients(msg.bccRecipients),
        subject: msg.subject || "(no subject)",
        bodyText,
        bodyHtml,
        bodyHtmlClean: pre.bodyHtmlClean,
        bodyHtmlTrimmed: pre.bodyHtmlTrimmed,
        hasQuotedHistory: pre.hasQuotedHistory,
        isForwarded: pre.isForwarded,
        snippet: msg.bodyPreview,
        isRead: !!msg.isRead,
        isStarred: msg.flag?.flagStatus === "flagged",
        isDraft: !!msg.isDraft,
        labels: msgLabels,
        hasAttachments: !!msg.hasAttachments,
        receivedAt,
        sentAt,
      },
    )) as { emailId: Id<"emails">; isNew: boolean };

    // 3. Pull attachment metadata for newly-inserted messages with attachments.
    if (upsertResult.isNew && msg.hasAttachments) {
      try {
        const attRes = (await graphFetch(
          `/me/messages/${msg.id}/attachments?$select=id,name,contentType,size,isInline,contentId`,
          accessToken,
        )) as {
          value?: Array<{
            id: string;
            name?: string;
            contentType?: string;
            size?: number;
            isInline?: boolean;
            contentId?: string;
          }>;
        };
        const attachments = (attRes.value || []).map((att) => ({
          filename: att.name || "attachment",
          mimeType: att.contentType || "application/octet-stream",
          size: att.size || 0,
          providerAttachmentId: att.id,
          contentId: att.isInline ? att.contentId ?? undefined : undefined,
        }));
        if (attachments.length > 0) {
          await ctx.runMutation(
            internal.sync.microsoftData._insertAttachments,
            { emailId: upsertResult.emailId, attachments },
          );
        }
      } catch {
        // Non-critical — attachments can be re-fetched later.
      }
    }

    // 4. Post-insert dispatch (blocked-sender, contact extract, classify, notify, OOO).
    if (upsertResult.isNew) {
      const senderLower = fromEmail.toLowerCase().trim();
      const isOutbound = !!senderLower && cctx.userEmails.includes(senderLower);
      await ctx.runMutation(
        internal.sync.microsoftData._onNewEmailInserted,
        {
          emailId: upsertResult.emailId,
          accountId: cctx.accountId,
          bodyText: bodyText ?? null,
          isOutbound,
        },
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron-driven entry point. Mirrors Gmail's pattern. No auth (called by Convex
// cron). Iterates over all active Microsoft accounts and schedules a sync for each.
// ─────────────────────────────────────────────────────────────────────────────
export const syncAllActiveAccounts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const accounts: Array<{ _id: Id<"mailAccounts"> }> = await ctx.runQuery(
      internal.sync.microsoftData._listActiveAccounts,
      {},
    );
    for (const a of accounts) {
      await ctx.scheduler.runAfter(0, internal.sync.microsoft.syncIncremental, {
        accountId: a._id,
      });
    }
    return { scheduled: accounts.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// syncIncremental — entry point.
// ─────────────────────────────────────────────────────────────────────────────

export const syncIncremental = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    maxResults: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, maxResults = 500 }): Promise<void> => {
    const accountInfo = (await ctx.runQuery(
      internal.sync.microsoftData._getAccountForSync,
      { accountId },
    )) as SyncAccountInfo | null;
    if (!accountInfo) throw new Error(`Account not found: ${accountId}`);
    if (accountInfo.userEmails.length === 0) {
      // Account has no peers — nothing to sync into.
      return;
    }

    await withRefreshOn401(ctx, accountId, async (accessToken) => {
      const folderMap = await buildFolderMap(accessToken);
      const cctx: ConversationContext = {
        accountId,
        userId: accountInfo.userId,
        userEmails: accountInfo.userEmails,
        folderMap,
      };

      // ── Incremental path: existing delta link ─────────────────────────────
      if (accountInfo.syncCursor) {
        try {
          await runDeltaPagination(ctx, accountInfo.syncCursor, accessToken, cctx);
          return;
        } catch (err) {
          if (
            err instanceof GraphHttpError &&
            (err.status === 410 || err.graphCode === "SyncStateNotFound")
          ) {
            // Delta token expired → fall through to full re-seed.
            await ctx.runMutation(
              internal.sync.microsoftData._setSyncCursor,
              { accountId, syncCursor: undefined },
            );
          } else {
            throw err;
          }
        }
      }

      // ── Full sync: pull recent messages, then snapshot a fresh deltaLink. ─
      let fetched = 0;
      let url = `/me/messages?$select=${MESSAGE_SELECT_FIELDS}&$orderby=receivedDateTime desc&$top=50`;
      const conversationGroups = new Map<string, GraphMessage[]>();

      while (fetched < maxResults) {
        const page = await graphFetch(url, accessToken);
        const messages: GraphMessage[] = page.value || [];
        if (messages.length === 0) break;
        for (const msg of messages) {
          if (!conversationGroups.has(msg.conversationId)) {
            conversationGroups.set(msg.conversationId, []);
          }
          conversationGroups.get(msg.conversationId)!.push(msg);
          fetched++;
          if (fetched >= maxResults) break;
        }
        if (!page["@odata.nextLink"] || fetched >= maxResults) break;
        url = page["@odata.nextLink"]!;
      }

      for (const [conversationId, msgs] of conversationGroups) {
        try {
          await syncConversationMessages(
            ctx,
            conversationId,
            msgs,
            accessToken,
            cctx,
          );
        } catch (err: unknown) {
          console.error(
            `[microsoft-sync] Conversation ${conversationId} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Capture a fresh deltaLink so the next run is incremental.
      try {
        const deltaLink = await getInitialDeltaLink(accessToken);
        await ctx.runMutation(internal.sync.microsoftData._setSyncCursor, {
          accountId,
          syncCursor: deltaLink ?? undefined,
          lastSyncAt: Date.now(),
        });
      } catch (err: unknown) {
        console.warn(
          "[microsoft-sync] Failed to fetch initial delta link:",
          err instanceof Error ? err.message : err,
        );
        await ctx.runMutation(internal.sync.microsoftData._setSyncCursor, {
          accountId,
          lastSyncAt: Date.now(),
        });
      }
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// _continueSync — delta-pagination continuation. Externalized so future
// retries can resume from a particular nextLink without redoing the prefix.
// ─────────────────────────────────────────────────────────────────────────────

export const _continueSync = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    nextLink: v.string(),
  },
  handler: async (ctx, { accountId, nextLink }): Promise<void> => {
    const accountInfo = (await ctx.runQuery(
      internal.sync.microsoftData._getAccountForSync,
      { accountId },
    )) as SyncAccountInfo | null;
    if (!accountInfo) return;

    await withRefreshOn401(ctx, accountId, async (accessToken) => {
      const folderMap = await buildFolderMap(accessToken);
      const cctx: ConversationContext = {
        accountId,
        userId: accountInfo.userId,
        userEmails: accountInfo.userEmails,
        folderMap,
      };
      await runDeltaPagination(ctx, nextLink, accessToken, cctx);
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: page through a delta result, batch by conversation,
// and persist the new deltaLink at the end.
// ─────────────────────────────────────────────────────────────────────────────

async function runDeltaPagination(
  ctx: ActionCtx,
  startUrl: string,
  accessToken: string,
  cctx: ConversationContext,
): Promise<void> {
  let url = startUrl;
  let newDeltaLink: string | undefined;
  const conversationGroups = new Map<string, GraphMessage[]>();
  const removedIds: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await graphFetch(url, accessToken);
    const messages: GraphMessage[] = page.value || [];
    for (const msg of messages) {
      if (msg["@removed"]) {
        removedIds.push(msg.id);
        continue;
      }
      if (!conversationGroups.has(msg.conversationId)) {
        conversationGroups.set(msg.conversationId, []);
      }
      conversationGroups.get(msg.conversationId)!.push(msg);
    }
    if (page["@odata.nextLink"]) {
      url = page["@odata.nextLink"];
    } else {
      newDeltaLink = page["@odata.deltaLink"];
      break;
    }
  }

  // Handle deletions first so we don't synthesise empty threads.
  for (const removedId of removedIds) {
    const found = (await ctx.runQuery(
      internal.sync.microsoftData._findEmailByProviderId,
      { providerMessageId: removedId },
    )) as { _id: Id<"emails">; threadId: Id<"threads"> } | null;
    if (found) {
      await ctx.runMutation(internal.sync.microsoftData._deleteEmail, {
        emailId: found._id,
      });
    }
  }

  // Upsert remaining changes.
  for (const [conversationId, msgs] of conversationGroups) {
    try {
      await syncConversationMessages(
        ctx,
        conversationId,
        msgs,
        accessToken,
        cctx,
      );
    } catch (err: unknown) {
      console.error(
        `[microsoft-sync] Delta conversation ${conversationId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Persist new cursor.
  await ctx.runMutation(internal.sync.microsoftData._setSyncCursor, {
    accountId: cctx.accountId,
    syncCursor: newDeltaLink ?? undefined,
    lastSyncAt: Date.now(),
  });
}

/**
 * Walk /me/messages/delta with $top=1 until we hit a deltaLink page. Used to
 * seed a fresh cursor at the end of a full sync.
 */
async function getInitialDeltaLink(accessToken: string): Promise<string | null> {
  let url = `/me/messages/delta?$select=${MESSAGE_SELECT_FIELDS}&$top=1`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await graphFetch(url, accessToken);
    if (page["@odata.deltaLink"]) return page["@odata.deltaLink"];
    if (!page["@odata.nextLink"]) return null;
    url = page["@odata.nextLink"];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// _sendAutoReplyIfAllowed — OOO auto-reply via Microsoft Graph.
// Mirrors the gmail equivalent: dedupe by sender, send via /me/sendMail,
// record the send in autoReplyLogs.
// ─────────────────────────────────────────────────────────────────────────────

export const _sendAutoReplyIfAllowed = internalAction({
  args: {
    delegationId: v.id("outOfOfficeDelegations"),
    accountId: v.id("mailAccounts"),
    emailId: v.id("emails"),
  },
  handler: async (ctx, { delegationId, accountId, emailId }): Promise<void> => {
    const email = (await ctx.runQuery(
      internal.sync.microsoftData._getEmailForReply,
      { emailId },
    )) as {
      _id: Id<"emails">;
      fromAddress: string;
      fromName: string | null;
      subject: string;
      internetMessageId: string | null;
      references: string[];
      providerMessageId: string;
      threadProviderId: string;
    } | null;
    if (!email) return;

    const sender = email.fromAddress.toLowerCase().trim();
    if (!sender) return;

    // Dedupe via the auto-reply log.
    const already = (await ctx.runQuery(internal.ooo.hasAutoRepliedTo, {
      delegationId,
      senderAddress: sender,
    })) as boolean;
    if (already) return;

    // Resolve the account owner so we can look up the active delegation.
    const accountInfo = (await ctx.runQuery(
      internal.sync.microsoftData._getAccountForSync,
      { accountId },
    )) as SyncAccountInfo | null;
    if (!accountInfo) return;

    // Re-check the delegation for active window + autoReplyEnabled.
    const delegation = (await ctx.runQuery(
      internal.ooo.getActiveDelegationForUser,
      { userId: accountInfo.userId, now: Date.now() },
    )) as {
      _id: Id<"outOfOfficeDelegations">;
      autoReplyEnabled: boolean;
      autoReplyBody?: string;
      autoReplySubject?: string;
    } | null;
    if (!delegation || !delegation.autoReplyEnabled) return;

    const replyBody =
      delegation.autoReplyBody ||
      "I'm currently out of the office and will respond when I'm back.";
    const replySubject =
      delegation.autoReplySubject ||
      (email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`);

    await withRefreshOn401(ctx, accountId, async (accessToken) => {
      const internetMessageHeaders: { name: string; value: string }[] = [];
      if (email.internetMessageId) {
        internetMessageHeaders.push({
          name: "In-Reply-To",
          value: email.internetMessageId,
        });
      }
      if (email.references.length > 0 || email.internetMessageId) {
        const refs = [...email.references];
        if (email.internetMessageId) refs.push(email.internetMessageId);
        internetMessageHeaders.push({
          name: "References",
          value: refs.join(" "),
        });
      }

      const sendBody = {
        message: {
          subject: replySubject,
          body: { contentType: "Text", content: replyBody },
          toRecipients: [
            {
              emailAddress: {
                address: email.fromAddress,
                ...(email.fromName ? { name: email.fromName } : {}),
              },
            },
          ],
          ...(internetMessageHeaders.length > 0
            ? { internetMessageHeaders }
            : {}),
        },
        saveToSentItems: true,
      };

      const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sendBody),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new GraphHttpError(
          res.status,
          `sendMail ${res.status}: ${text.slice(0, 200)}`,
          null,
          null,
        );
      }
    });

    await ctx.runMutation(internal.ooo.recordAutoReply, {
      delegationId,
      senderAddress: sender,
    });
  },
});
