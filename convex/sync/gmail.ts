"use node";

// ─────────────────────────────────────────────────────────────────────────────
// gmail.ts — Gmail incremental sync (history API) + chunked continuation.
//
// Ported from:
//   - packages/backend/src/services/gmail/gmail-sync.ts
//   - packages/backend/src/workers/gmail-sync.worker.ts
//
// Architecture notes
// ──────────────────
// Convex actions have a hard runtime ceiling around 10 minutes; we target
// ~2 minutes per chunk to stay well under that. The flow is:
//
//   1. `syncIncremental` (public action) — auth-checked, called by the user
//      "Sync now" button or by the cron job. It reads the current cursor and
//      schedules `_continueSync` with no work to do up front.
//   2. `_continueSync` (internalAction) — fetches a slice of work (one page
//      of history results, or one batch of changed thread ids), persists
//      everything via gmailData mutations, and if there's more to do it
//      schedules another `_continueSync` invocation. Otherwise it stamps the
//      new historyId as `syncCursor` and stops.
//
// Auto-reply for OOO is implemented as `_sendAutoReplyIfAllowed`, scheduled
// from `_onNewEmailInserted` for inbound mail when the user has an active
// auto-reply delegation.
// ─────────────────────────────────────────────────────────────────────────────

import { action, internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireUser } from "../lib/auth";
import { withRefreshOn401 } from "../oauth/tokenManager";

// Per-chunk work caps. Tuned to stay well below Convex's per-action limit.
const THREADS_PER_CHUNK = 25;
const HISTORY_PAGE_SIZE = 100;
// Initial-sync cap: number of threads pulled when we have no cursor at all.
const INITIAL_THREAD_COUNT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Types — Gmail REST shapes (only the fields we touch)
// ─────────────────────────────────────────────────────────────────────────────
interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailPayload {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
}
interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPayload;
}
interface GmailHistoryEntry {
  messages?: { id?: string; threadId?: string }[];
  messagesAdded?: { message?: { id?: string; threadId?: string } }[];
  messagesDeleted?: { message?: { id?: string; threadId?: string } }[];
  labelsAdded?: { message?: { id?: string; threadId?: string } }[];
  labelsRemoved?: { message?: { id?: string; threadId?: string } }[];
}
interface GmailHistoryResponse {
  history?: GmailHistoryEntry[];
  nextPageToken?: string;
  historyId?: string;
}
interface GmailThreadListResponse {
  threads?: { id?: string; historyId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
interface GmailThreadResponse {
  id?: string;
  historyId?: string;
  messages?: GmailMessage[];
}
interface GmailProfileResponse {
  emailAddress?: string;
  historyId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// fetch wrapper — surfaces a `status` property on errors so withRefreshOn401
// can detect a 401 and refresh the token.
// ─────────────────────────────────────────────────────────────────────────────
async function gmailFetch<T>(
  url: string,
  accessToken: string,
): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(
      `Gmail API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME header / body helpers (1:1 port of Prisma version)
// ─────────────────────────────────────────────────────────────────────────────
function getHeader(
  headers: GmailHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
    ?.value;
}

function parseAddress(raw: string): { email: string; name?: string } {
  const m = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, "").trim(), email: m[2].trim() };
  return { email: raw.trim() };
}

function parseAddressList(
  raw: string | undefined,
): { email: string; name?: string }[] {
  if (!raw) return [];
  return raw.split(",").map((a) => parseAddress(a));
}

function decodeBase64Url(b64url: string): string {
  // Convert base64url → base64, then decode UTF-8.
  const padded =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function getBody(payload: GmailPayload): { text: string; html: string } {
  let text = "";
  let html = "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = getBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }
  return { text, html };
}

interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  providerAttachmentId?: string;
  contentId?: string;
}

function getAttachments(
  payload: GmailPayload,
  out: ParsedAttachment[] = [],
): ParsedAttachment[] {
  const cidHeader = payload.headers?.find(
    (h) => h.name?.toLowerCase() === "content-id",
  );
  const hasFilename = payload.filename && payload.filename.length > 0;
  const hasCid = !!cidHeader?.value;
  if ((hasFilename || hasCid) && payload.body?.attachmentId) {
    const contentId = cidHeader?.value?.replace(/[<>]/g, "");
    const mimeType = payload.mimeType || "application/octet-stream";
    out.push({
      filename:
        payload.filename ||
        `inline-${contentId || payload.body.attachmentId}.${
          mimeType.split("/")[1] || "bin"
        }`,
      mimeType,
      size: payload.body.size ?? 0,
      providerAttachmentId: payload.body.attachmentId,
      contentId: contentId ?? undefined,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) getAttachments(part, out);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation splitter — Gmail occasionally collapses unrelated emails into
// a single thread. Split into independent groups using In-Reply-To /
// References. (Direct port of the Prisma worker.)
// ─────────────────────────────────────────────────────────────────────────────
function splitIntoConversations(messages: GmailMessage[]): GmailMessage[][] {
  if (messages.length <= 1) return [messages];

  const groups: GmailMessage[][] = [];
  const groupMessageIds: Set<string>[] = [];

  for (const msg of messages) {
    const headers = msg.payload?.headers ?? [];
    const inReplyTo = getHeader(headers, "In-Reply-To") || "";
    const referencesRaw = getHeader(headers, "References") || "";
    const refs = referencesRaw.split(/\s+/).filter(Boolean);
    const allRefs = [inReplyTo, ...refs].filter(Boolean);
    const mid = getHeader(headers, "Message-ID") || "";

    let foundGroup = -1;
    for (let i = 0; i < groups.length; i++) {
      for (const r of allRefs) {
        if (groupMessageIds[i].has(r)) {
          foundGroup = i;
          break;
        }
      }
      if (foundGroup !== -1) break;
    }

    if (foundGroup !== -1) {
      groups[foundGroup].push(msg);
      if (mid) groupMessageIds[foundGroup].add(mid);
    } else {
      groups.push([msg]);
      const idSet = new Set<string>();
      if (mid) idSet.add(mid);
      groupMessageIds.push(idSet);
    }
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persist a single Gmail thread (split into sub-threads if necessary).
// Returns the count of newly inserted emails so the caller can dispatch
// downstream work (notifications, classification, etc.) for those alone.
// ─────────────────────────────────────────────────────────────────────────────
async function persistGmailThread(
  ctx: ActionCtx,
  args: {
    accountId: Id<"mailAccounts">;
    gmailThreadId: string;
    messages: GmailMessage[];
    userEmails: string[];
  },
): Promise<{ newEmailIds: Id<"emails">[]; bodyTextByEmailId: Record<string, string | null> }> {
  const { accountId, gmailThreadId, messages, userEmails } = args;
  const newEmailIds: Id<"emails">[] = [];
  const bodyTextByEmailId: Record<string, string | null> = {};

  if (messages.length === 0) {
    return { newEmailIds, bodyTextByEmailId };
  }

  const groups = splitIntoConversations(messages);

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const firstMsg = group[0];
    const lastMsg = group[group.length - 1];
    const firstHeaders = firstMsg.payload?.headers ?? [];

    const subThreadId =
      groups.length === 1 ? gmailThreadId : `${gmailThreadId}::${groupIdx}`;

    const subject = getHeader(firstHeaders, "Subject") || "(no subject)";
    const lastSnippet = lastMsg.snippet || "";
    const threadLabels = [
      ...new Set(group.flatMap((m) => m.labelIds ?? [])),
    ];

    const participants = new Set<string>();
    for (const msg of group) {
      const headers = msg.payload?.headers ?? [];
      const from = getHeader(headers, "From");
      if (from) parseAddressList(from).forEach((a) => participants.add(a.email));
      const to = getHeader(headers, "To");
      if (to) parseAddressList(to).forEach((a) => participants.add(a.email));
    }

    const lastDate = lastMsg.internalDate
      ? Number(lastMsg.internalDate)
      : Date.now();

    let lastReceivedAt: number | undefined;
    for (const msg of [...group].reverse()) {
      const msgHeaders = msg.payload?.headers ?? [];
      const msgFrom = parseAddress(getHeader(msgHeaders, "From") || "");
      if (
        msgFrom.email &&
        !userEmails.includes(msgFrom.email.toLowerCase())
      ) {
        lastReceivedAt = msg.internalDate
          ? Number(msg.internalDate)
          : Date.now();
        break;
      }
    }

    const threadId: Id<"threads"> = await ctx.runMutation(
      internal.sync.gmailData._upsertThread,
      {
        accountId,
        providerThreadId: subThreadId,
        subject,
        snippet: lastSnippet || undefined,
        isRead: !threadLabels.includes("UNREAD"),
        isStarred: threadLabels.includes("STARRED"),
        isArchived:
          !threadLabels.includes("INBOX") && !threadLabels.includes("SENT"),
        isTrashed: threadLabels.includes("TRASH"),
        labels: threadLabels,
        participantEmails: [...participants],
        messageCount: group.length,
        lastMessageAt: lastDate,
        lastReceivedAt,
      },
    );

    for (const msg of group) {
      const headers = msg.payload?.headers ?? [];
      const msgId = msg.id;
      if (!msgId) continue;

      const from = parseAddress(getHeader(headers, "From") || "");
      const toRaw = getHeader(headers, "To");
      const ccRaw = getHeader(headers, "Cc");
      const bccRaw = getHeader(headers, "Bcc");
      const internetMessageId = getHeader(headers, "Message-ID");
      const inReplyTo = getHeader(headers, "In-Reply-To");
      const referencesRaw = getHeader(headers, "References") || "";
      const refs = referencesRaw.split(/\s+/).filter(Boolean);

      const body = msg.payload ? getBody(msg.payload) : { text: "", html: "" };
      const attachments = msg.payload ? getAttachments(msg.payload) : [];
      const labels = msg.labelIds ?? [];
      const receivedAt = msg.internalDate
        ? Number(msg.internalDate)
        : Date.now();

      const upsertResult: { emailId: Id<"emails">; isNew: boolean } =
        await ctx.runMutation(internal.sync.gmailData._upsertEmail, {
          accountId,
          threadId,
          providerMessageId: msgId,
          internetMessageId,
          inReplyTo,
          references: refs,
          fromAddress: from.email,
          fromName: from.name,
          toAddresses: parseAddressList(toRaw),
          ccAddresses: parseAddressList(ccRaw),
          bccAddresses: parseAddressList(bccRaw),
          subject: getHeader(headers, "Subject") || "(no subject)",
          bodyText: body.text || undefined,
          bodyHtml: body.html || undefined,
          snippet: msg.snippet || undefined,
          isRead: !labels.includes("UNREAD"),
          isStarred: labels.includes("STARRED"),
          isDraft: labels.includes("DRAFT"),
          labels,
          hasAttachments: attachments.length > 0,
          receivedAt,
          sentAt: labels.includes("SENT") ? receivedAt : undefined,
        });

      if (upsertResult.isNew) {
        newEmailIds.push(upsertResult.emailId);
        bodyTextByEmailId[upsertResult.emailId] = body.text || null;
        if (attachments.length > 0) {
          await ctx.runMutation(internal.sync.gmailData._insertAttachments, {
            emailId: upsertResult.emailId,
            attachments,
          });
        }
      }
    }
  }

  // If we split a previously-combined thread, drop the now-empty original.
  if (groups.length > 1) {
    await ctx.runMutation(internal.sync.gmailData._cleanupEmptyThread, {
      accountId,
      providerThreadId: gmailThreadId,
    });
  }

  return { newEmailIds, bodyTextByEmailId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public trigger: queue an incremental sync for a single account. The caller
// must own `accountId`.
// ─────────────────────────────────────────────────────────────────────────────
export const syncIncremental = action({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const account = await ctx.runQuery(
      internal.sync.gmailData._getAccountForSync,
      { accountId },
    );
    if (!account) throw new Error("Account not found");
    if (account.userId !== userId) throw new Error("Account not found");
    if (account.provider !== "GMAIL") {
      throw new Error("Account is not a Gmail account");
    }

    // Schedule the first chunk. The chunk reads the cursor itself, so the
    // trigger doesn't need to pass it through.
    await ctx.scheduler.runAfter(0, internal.sync.gmail._continueSync, {
      accountId,
      pageToken: undefined,
      mode: "auto",
    });
    return { queued: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron-driven entry point. No auth (called by Convex cron). Iterates over all
// active Gmail accounts and schedules a sync for each.
// ─────────────────────────────────────────────────────────────────────────────
export const syncAllActiveAccounts = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts: Array<{ _id: Id<"mailAccounts"> }> = await ctx.runQuery(
      internal.sync.gmailData._listActiveAccounts,
      {},
    );
    for (const a of accounts) {
      await ctx.scheduler.runAfter(0, internal.sync.gmail._continueSync, {
        accountId: a._id,
        pageToken: undefined,
        mode: "auto",
      });
    }
    return { scheduled: accounts.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Resumable chunk runner. Two modes:
//   - "auto":     decide between history-API incremental sync and an
//                 initial thread-list pull based on whether a syncCursor
//                 exists. Used by syncIncremental + cron.
//   - "history":  continuation of an in-progress history-API pagination.
//   - "initial":  continuation of an in-progress initial thread-list pull.
//
// `pageToken` carries the position. When the entire sync is done the
// chunk stamps the new historyId on the account and stops.
// ─────────────────────────────────────────────────────────────────────────────
export const _continueSync = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    pageToken: v.optional(v.string()),
    mode: v.union(
      v.literal("auto"),
      v.literal("history"),
      v.literal("initial"),
    ),
  },
  handler: async (ctx, { accountId, pageToken, mode }) => {
    const cursorInfo = await ctx.runQuery(
      internal.sync.gmailData._getSyncCursor,
      { accountId },
    );
    if (!cursorInfo) return;

    const account = await ctx.runQuery(
      internal.sync.gmailData._getAccountForSync,
      { accountId },
    );
    if (!account) return;

    let resolvedMode: "history" | "initial" = "history";
    if (mode === "auto") {
      resolvedMode = cursorInfo.syncCursor ? "history" : "initial";
    } else {
      resolvedMode = mode;
    }

    try {
      if (resolvedMode === "history") {
        await runHistoryChunk(ctx, {
          accountId,
          pageToken,
          startHistoryId: cursorInfo.syncCursor!,
          userEmails: account.userEmails,
        });
      } else {
        await runInitialChunk(ctx, {
          accountId,
          pageToken,
          userEmails: account.userEmails,
        });
      }
    } catch (err: unknown) {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      // historyId expired — fall back to initial sync from a fresh pull.
      if (
        resolvedMode === "history" &&
        (status === 404 ||
          (err instanceof Error && /history/i.test(err.message)))
      ) {
        await ctx.scheduler.runAfter(0, internal.sync.gmail._continueSync, {
          accountId,
          pageToken: undefined,
          mode: "initial",
        });
        return;
      }
      throw err;
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// History-API chunk: collect all changed thread ids on this page and
// fetch + persist them. Schedules the next page if there is one; otherwise
// stamps the latest historyId as the cursor.
// ─────────────────────────────────────────────────────────────────────────────
async function runHistoryChunk(
  ctx: ActionCtx,
  args: {
    accountId: Id<"mailAccounts">;
    pageToken: string | undefined;
    startHistoryId: string;
    userEmails: string[];
  },
): Promise<void> {
  const { accountId, pageToken, startHistoryId, userEmails } = args;

  const data: GmailHistoryResponse = await withRefreshOn401(
    ctx,
    accountId,
    async (token) => {
      const url = new URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/history",
      );
      url.searchParams.set("startHistoryId", startHistoryId);
      for (const t of [
        "messageAdded",
        "messageDeleted",
        "labelAdded",
        "labelRemoved",
      ]) {
        url.searchParams.append("historyTypes", t);
      }
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      return await gmailFetch<GmailHistoryResponse>(url.toString(), token);
    },
  );

  const changedThreadIds = new Set<string>();
  for (const h of data.history ?? []) {
    for (const m of h.messagesAdded ?? []) {
      if (m.message?.threadId) changedThreadIds.add(m.message.threadId);
    }
    for (const m of h.messagesDeleted ?? []) {
      if (m.message?.threadId) changedThreadIds.add(m.message.threadId);
    }
    for (const m of h.labelsAdded ?? []) {
      if (m.message?.threadId) changedThreadIds.add(m.message.threadId);
    }
    for (const m of h.labelsRemoved ?? []) {
      if (m.message?.threadId) changedThreadIds.add(m.message.threadId);
    }
  }

  // Process this page's worth of thread IDs in one chunk. Each thread fetch
  // is small enough; if it ever times out, raise THREADS_PER_CHUNK awareness.
  const ids = [...changedThreadIds];
  for (let i = 0; i < ids.length; i += THREADS_PER_CHUNK) {
    const slice = ids.slice(i, i + THREADS_PER_CHUNK);
    for (const tid of slice) {
      try {
        await syncOneThread(ctx, accountId, tid, userEmails);
      } catch (err) {
        // Swallow per-thread failures so the rest of the chunk continues.
        // (Matches the Prisma worker behavior — failures land in logs.)
        console.error(`[gmail-sync] thread ${tid} failed:`, err);
      }
    }
  }

  if (data.nextPageToken) {
    await ctx.scheduler.runAfter(0, internal.sync.gmail._continueSync, {
      accountId,
      pageToken: data.nextPageToken,
      mode: "history",
    });
    return;
  }

  // No more pages — fetch profile to stamp the latest historyId.
  const profile: GmailProfileResponse = await withRefreshOn401(
    ctx,
    accountId,
    async (token) =>
      await gmailFetch<GmailProfileResponse>(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        token,
      ),
  );
  await ctx.runMutation(internal.sync.gmailData._setSyncCursor, {
    accountId,
    syncCursor: profile.historyId,
    lastSyncAt: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial-sync chunk: list a page of recent threads (first sync) and persist.
// ─────────────────────────────────────────────────────────────────────────────
async function runInitialChunk(
  ctx: ActionCtx,
  args: {
    accountId: Id<"mailAccounts">;
    pageToken: string | undefined;
    userEmails: string[];
  },
): Promise<void> {
  const { accountId, pageToken, userEmails } = args;

  const list: GmailThreadListResponse = await withRefreshOn401(
    ctx,
    accountId,
    async (token) => {
      const url = new URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/threads",
      );
      url.searchParams.set("maxResults", String(HISTORY_PAGE_SIZE));
      url.searchParams.set("q", "in:inbox OR in:sent");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      return await gmailFetch<GmailThreadListResponse>(url.toString(), token);
    },
  );

  const ids = (list.threads ?? []).map((t) => t.id).filter(Boolean) as string[];
  for (const tid of ids) {
    try {
      await syncOneThread(ctx, accountId, tid, userEmails);
    } catch (err) {
      console.error(`[gmail-sync] thread ${tid} failed:`, err);
    }
  }

  // Cap the very first sync so we don't pull years of mail through this path.
  // (Historical sync covers the rest, on demand.)
  const cursorInfo = await ctx.runQuery(
    internal.sync.gmailData._getSyncCursor,
    { accountId },
  );
  const fetchedSoFar =
    (cursorInfo?.historicalSyncProgress as { _initialFetched?: number } | null)
      ?._initialFetched ?? 0;
  const newCount = fetchedSoFar + ids.length;
  if (list.nextPageToken && newCount < INITIAL_THREAD_COUNT) {
    await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
      accountId,
      progress: { _initialFetched: newCount },
    });
    await ctx.scheduler.runAfter(0, internal.sync.gmail._continueSync, {
      accountId,
      pageToken: list.nextPageToken,
      mode: "initial",
    });
    return;
  }

  // Stamp historyId so next sync goes through the history API.
  const profile: GmailProfileResponse = await withRefreshOn401(
    ctx,
    accountId,
    async (token) =>
      await gmailFetch<GmailProfileResponse>(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        token,
      ),
  );
  await ctx.runMutation(internal.sync.gmailData._setSyncCursor, {
    accountId,
    syncCursor: profile.historyId,
    lastSyncAt: Date.now(),
  });
  // Clear scratch progress.
  await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
    accountId,
    progress: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch one Gmail thread (full payload) and persist it. Dispatch follow-ups
// for newly-inserted emails (classification / notification / OOO reply).
// ─────────────────────────────────────────────────────────────────────────────
async function syncOneThread(
  ctx: ActionCtx,
  accountId: Id<"mailAccounts">,
  gmailThreadId: string,
  userEmails: string[],
): Promise<void> {
  const thread: GmailThreadResponse = await withRefreshOn401(
    ctx,
    accountId,
    async (token) =>
      await gmailFetch<GmailThreadResponse>(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(
          gmailThreadId,
        )}?format=full`,
        token,
      ),
  );
  const messages = thread.messages ?? [];
  if (messages.length === 0) return;

  const { newEmailIds, bodyTextByEmailId } = await persistGmailThread(ctx, {
    accountId,
    gmailThreadId,
    messages,
    userEmails,
  });

  // Dispatch downstream work for genuinely new messages only.
  for (const emailId of newEmailIds) {
    // Determine inbound vs outbound for this message: easiest is to re-read
    // the email row, but we already know enough — we need fromAddress, which
    // _onNewEmailInserted will look up itself. We pass bodyText so the
    // contact extractor can pull a name from the signature.
    const bodyText = bodyTextByEmailId[emailId] ?? null;
    // Find the message that produced this id (by scanning messages array).
    // In practice we set isOutbound based on whether the sender is in
    // userEmails; the mutation looks up the email row again to be safe.
    let isOutbound = false;
    for (const m of messages) {
      if (m.id) {
        const headers = m.payload?.headers ?? [];
        const from = parseAddress(getHeader(headers, "From") || "");
        if (
          from.email &&
          userEmails.includes(from.email.toLowerCase()) &&
          // Match by message id is impossible without the persisted
          // providerMessageId here; we approximate by checking labels.
          (m.labelIds?.includes("SENT") ?? false)
        ) {
          isOutbound = true;
          break;
        }
      }
    }
    await ctx.runMutation(internal.sync.gmailData._onNewEmailInserted, {
      emailId,
      accountId,
      bodyText,
      isOutbound,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OOO auto-reply. Called once per inbound new email when the user has an
// active auto-reply delegation. Idempotent per (delegation, sender) — the
// dedupe lives in `convex/ooo.ts:hasAutoRepliedTo`.
// ─────────────────────────────────────────────────────────────────────────────
export const _sendAutoReplyIfAllowed = internalAction({
  args: {
    delegationId: v.id("outOfOfficeDelegations"),
    accountId: v.id("mailAccounts"),
    emailId: v.id("emails"),
  },
  handler: async (ctx, { delegationId, accountId, emailId }) => {
    // 1. Load the original email + delegation.
    const data = await ctx.runQuery(internal.sync.gmailData._loadAutoReplyContext, {
      delegationId,
      accountId,
      emailId,
    });
    if (!data) return;
    const { delegation, email, account } = data;
    if (!delegation.autoReplyEnabled) return;
    const now = Date.now();
    if (now < delegation.startAt || now > delegation.endAt) return;

    // 2. Skip if we've already auto-replied to this sender for this delegation.
    const senderAddress = email.fromAddress.toLowerCase().trim();
    const already = await ctx.runQuery(internal.ooo.hasAutoRepliedTo, {
      delegationId,
      senderAddress,
    });
    if (already) return;

    // 3. Build the reply body.
    const subject = (email.subject || "").startsWith("Re:")
      ? email.subject
      : `Re: ${email.subject || ""}`;
    const bodyHtml = delegation.autoReplyBody || "";
    const bodyText = bodyHtml.replace(/<[^>]+>/g, "");

    // 4. Build a minimal RFC2822 message and send via Gmail API.
    const fromHeader = account.email;
    const headers: string[] = [
      `From: ${fromHeader}`,
      `To: ${senderAddress}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
    ];
    if (email.internetMessageId) {
      headers.push(`In-Reply-To: ${email.internetMessageId}`);
      headers.push(`References: ${email.internetMessageId}`);
    }
    const raw = [...headers, "", bodyHtml || bodyText].join("\r\n");
    const rawB64 = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    try {
      await withRefreshOn401(ctx, accountId, async (token) => {
        const res = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw: rawB64 }),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(
            `Gmail send failed (${res.status}): ${text.slice(0, 300)}`,
          ) as Error & { status: number };
          err.status = res.status;
          throw err;
        }
      });

      // 5. Record so future inbound from this sender are skipped.
      await ctx.runMutation(internal.ooo.recordAutoReply, {
        delegationId,
        senderAddress,
      });
    } catch (err) {
      console.error("[gmail-sync] auto-reply send failed:", err);
    }
  },
});
