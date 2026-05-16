"use node";

// ─────────────────────────────────────────────────────────────────────────────
// gmailHistorical.ts — full historical Gmail backfill, chunked + resumable.
//
// Ported from:
//   - packages/backend/src/services/gmail/gmail-historical-sync.ts
//   - packages/backend/src/workers/gmail-historical-sync.worker.ts
//
// Flow
// ────
// `startHistorical` (public action, requires auth) marks the account
// IN_PROGRESS and schedules the first chunk. Each `_continueHistorical`
// chunk pulls one page of thread ids (~100 threads), fetches & persists
// each, updates progress, and either schedules the next page or stamps
// COMPLETED. Failures are caught and logged; the chunk re-queues itself
// where possible (rate-limit / 5xx) with a backoff.
//
// Progress payload shape (`mailAccounts.historicalSyncProgress`):
//   {
//     syncedThreads: number,
//     totalThreads: number,        // resultSizeEstimate, refreshed each page
//     pageToken?: string,          // next page to fetch
//     startedAt: number,           // ms epoch
//     lastBatchAt: number,
//     error?: string,
//   }
// ─────────────────────────────────────────────────────────────────────────────

import { action, internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireUser } from "../lib/auth";
import { withRefreshOn401 } from "../oauth/tokenManager";

const BATCH_SIZE = 100; // Gmail's max page size for threads.list

interface HistoricalProgress {
  syncedThreads: number;
  totalThreads: number;
  pageToken?: string;
  startedAt: number;
  lastBatchAt: number;
  error?: string;
}

interface GmailThreadListResponse {
  threads?: { id?: string; historyId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
interface GmailThreadResponse {
  id?: string;
  historyId?: string;
  messages?: GmailThreadMessage[];
}
interface GmailThreadMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: {
    mimeType?: string;
    filename?: string;
    headers?: { name?: string; value?: string }[];
    body?: { data?: string; size?: number; attachmentId?: string };
    parts?: GmailThreadMessage["payload"][];
  };
}
interface GmailProfileResponse {
  emailAddress?: string;
  historyId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Light fetch wrapper (same idea as the one in gmail.ts; kept local so each
// "use node" file is self-contained and can be torn down cleanly).
// ─────────────────────────────────────────────────────────────────────────────
async function gmailFetch<T>(url: string, accessToken: string): Promise<T> {
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
// Public trigger (requires auth). Marks the account IN_PROGRESS and queues
// the first chunk.
// ─────────────────────────────────────────────────────────────────────────────
export const startHistorical = action({
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

    // Resume support: keep existing progress if a sync is mid-flight.
    const existing = (account.historicalSyncProgress ?? null) as
      | HistoricalProgress
      | null;
    const startedAt = existing?.startedAt ?? Date.now();
    const progress: HistoricalProgress = {
      syncedThreads: existing?.syncedThreads ?? 0,
      totalThreads: existing?.totalThreads ?? 0,
      pageToken: existing?.pageToken,
      startedAt,
      lastBatchAt: Date.now(),
    };

    await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
      accountId,
      progress,
      status: "IN_PROGRESS",
    });

    await ctx.scheduler.runAfter(
      0,
      internal.sync.gmailHistorical._continueHistorical,
      {
        accountId,
        pageToken: progress.pageToken,
      },
    );
    return { queued: true, startedAt };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Resumable chunk worker. Each invocation processes one Gmail threads.list
// page (~100 threads), updates progress, and re-queues itself if there is a
// nextPageToken.
// ─────────────────────────────────────────────────────────────────────────────
export const _continueHistorical = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    pageToken: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, pageToken }) => {
    const account = await ctx.runQuery(
      internal.sync.gmailData._getAccountForSync,
      { accountId },
    );
    if (!account) return;

    const cursorInfo = await ctx.runQuery(
      internal.sync.gmailData._getSyncCursor,
      { accountId },
    );
    const existingProgress = (cursorInfo?.historicalSyncProgress ?? null) as
      | HistoricalProgress
      | null;
    const progress: HistoricalProgress = existingProgress ?? {
      syncedThreads: 0,
      totalThreads: 0,
      startedAt: Date.now(),
      lastBatchAt: Date.now(),
    };

    let list: GmailThreadListResponse;
    try {
      list = await withRefreshOn401(ctx, accountId, async (token) => {
        const url = new URL(
          "https://gmail.googleapis.com/gmail/v1/users/me/threads",
        );
        url.searchParams.set("maxResults", String(BATCH_SIZE));
        url.searchParams.set("q", "-in:spam -in:trash");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        return await gmailFetch<GmailThreadListResponse>(url.toString(), token);
      });
    } catch (err) {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 429 || (status && status >= 500)) {
        // Transient — retry in 60s.
        await ctx.scheduler.runAfter(
          60_000,
          internal.sync.gmailHistorical._continueHistorical,
          { accountId, pageToken },
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
        accountId,
        progress: { ...progress, error: message, lastBatchAt: Date.now() },
        status: "FAILED",
      });
      throw err;
    }

    // Update total estimate (resultSizeEstimate is an estimate; keep the
    // largest seen so the progress bar never goes backward).
    if (typeof list.resultSizeEstimate === "number") {
      progress.totalThreads = Math.max(
        progress.totalThreads,
        list.resultSizeEstimate,
        progress.syncedThreads,
      );
    }

    const ids = (list.threads ?? [])
      .map((t) => t.id)
      .filter((id): id is string => !!id);
    let synced = progress.syncedThreads;

    for (const tid of ids) {
      try {
        await syncOneHistoricalThread(ctx, accountId, tid, account.userEmails);
        synced++;
      } catch (err) {
        const status =
          typeof err === "object" && err !== null && "status" in err
            ? (err as { status?: number }).status
            : undefined;
        // Skip on hard errors — match the Prisma worker's tolerance.
        if (status === 429 || (status && status >= 500)) {
          // Persist what we have and re-queue with the same page token so
          // we replay the failed thread on the next chunk.
          await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
            accountId,
            progress: {
              ...progress,
              syncedThreads: synced,
              pageToken,
              lastBatchAt: Date.now(),
            },
          });
          await ctx.scheduler.runAfter(
            60_000,
            internal.sync.gmailHistorical._continueHistorical,
            { accountId, pageToken },
          );
          return;
        }
        console.error(`[historical-sync] thread ${tid} failed:`, err);
      }
    }

    progress.syncedThreads = synced;
    progress.pageToken = list.nextPageToken;
    progress.lastBatchAt = Date.now();
    progress.totalThreads = Math.max(progress.totalThreads, synced);

    await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
      accountId,
      progress,
    });

    if (list.nextPageToken) {
      await ctx.scheduler.runAfter(
        0,
        internal.sync.gmailHistorical._continueHistorical,
        { accountId, pageToken: list.nextPageToken },
      );
      return;
    }

    // No more pages — stamp COMPLETED + sync cursor for incremental from now on.
    let profileHistoryId: string | undefined;
    try {
      const profile = await withRefreshOn401(ctx, accountId, async (token) =>
        gmailFetch<GmailProfileResponse>(
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          token,
        ),
      );
      profileHistoryId = profile.historyId;
    } catch {
      // Non-fatal — incremental sync will hit the fallback path.
    }

    await ctx.runMutation(internal.sync.gmailData._setHistoricalProgress, {
      accountId,
      progress: {
        ...progress,
        totalThreads: synced,
      },
      status: "COMPLETED",
      completedAt: Date.now(),
    });
    if (profileHistoryId) {
      await ctx.runMutation(internal.sync.gmailData._setSyncCursor, {
        accountId,
        syncCursor: profileHistoryId,
        lastSyncAt: Date.now(),
      });
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-thread fetch + persist. Same logic as the incremental path (delegated
// to gmailData mutations via the shared persist routine in gmail.ts), but
// kept inline here so this file's bundle doesn't pull anything from gmail.ts.
// We persist one thread at a time and call `_onNewEmailInserted` for each
// newly-inserted email.
// ─────────────────────────────────────────────────────────────────────────────
async function syncOneHistoricalThread(
  ctx: ActionCtx,
  accountId: Id<"mailAccounts">,
  gmailThreadId: string,
  userEmails: string[],
): Promise<void> {
  const thread = await withRefreshOn401(ctx, accountId, async (token) =>
    gmailFetch<GmailThreadResponse>(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(
        gmailThreadId,
      )}?format=full`,
      token,
    ),
  );
  const messages = thread.messages ?? [];
  if (messages.length === 0) return;

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
    for (const m of group) {
      const headers = m.payload?.headers ?? [];
      const from = getHeader(headers, "From");
      if (from) parseAddressList(from).forEach((a) => participants.add(a.email));
      const to = getHeader(headers, "To");
      if (to) parseAddressList(to).forEach((a) => participants.add(a.email));
    }

    const lastDate = lastMsg.internalDate ? Number(lastMsg.internalDate) : Date.now();
    let lastReceivedAt: number | undefined;
    for (const m of [...group].reverse()) {
      const msgHeaders = m.payload?.headers ?? [];
      const fromAddr = parseAddress(getHeader(msgHeaders, "From") || "").email;
      if (fromAddr && !userEmails.includes(fromAddr.toLowerCase())) {
        lastReceivedAt = m.internalDate ? Number(m.internalDate) : Date.now();
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

    for (const m of group) {
      const headers = m.payload?.headers ?? [];
      const msgId = m.id;
      if (!msgId) continue;

      const from = parseAddress(getHeader(headers, "From") || "");
      const toRaw = getHeader(headers, "To");
      const ccRaw = getHeader(headers, "Cc");
      const bccRaw = getHeader(headers, "Bcc");
      const internetMessageId = getHeader(headers, "Message-ID");
      const inReplyTo = getHeader(headers, "In-Reply-To");
      const referencesRaw = getHeader(headers, "References") || "";
      const refs = referencesRaw.split(/\s+/).filter(Boolean);

      const body = m.payload ? getBody(m.payload) : { text: "", html: "" };
      const attachments = m.payload ? getAttachments(m.payload) : [];
      const labels = m.labelIds ?? [];
      const receivedAt = m.internalDate ? Number(m.internalDate) : Date.now();
      const isOutbound =
        !!from.email && userEmails.includes(from.email.toLowerCase());

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
          snippet: m.snippet || undefined,
          isRead: !labels.includes("UNREAD"),
          isStarred: labels.includes("STARRED"),
          isDraft: labels.includes("DRAFT"),
          labels,
          hasAttachments: attachments.length > 0,
          receivedAt,
          sentAt: labels.includes("SENT") ? receivedAt : undefined,
        });

      if (upsertResult.isNew) {
        if (attachments.length > 0) {
          await ctx.runMutation(internal.sync.gmailData._insertAttachments, {
            emailId: upsertResult.emailId,
            attachments,
          });
        }
        // Historical sync runs in bulk; we still dispatch per-email side
        // effects so classification/notifications/contacts get populated.
        await ctx.runMutation(internal.sync.gmailData._onNewEmailInserted, {
          emailId: upsertResult.emailId,
          accountId,
          bodyText: body.text || null,
          isOutbound,
        });
      }
    }
  }

  if (groups.length > 1) {
    await ctx.runMutation(internal.sync.gmailData._cleanupEmptyThread, {
      accountId,
      providerThreadId: gmailThreadId,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME helpers — duplicated locally so this file is independent of gmail.ts.
// (Same logic, same shapes; intentionally not extracted to a shared util
// because both sites are "use node" and the helpers are tiny.)
// ─────────────────────────────────────────────────────────────────────────────
function getHeader(
  headers: { name?: string; value?: string }[] | undefined,
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
  const padded =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function getBody(payload: NonNullable<GmailThreadMessage["payload"]>): {
  text: string;
  html: string;
} {
  let text = "";
  let html = "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (!part) continue;
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
  payload: NonNullable<GmailThreadMessage["payload"]>,
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
    for (const part of payload.parts) {
      if (part) getAttachments(part, out);
    }
  }
  return out;
}

function splitIntoConversations(
  messages: GmailThreadMessage[],
): GmailThreadMessage[][] {
  // DISABLED — see convex/sync/gmail.ts for rationale.
  if (messages.length === 0) return [];
  return [messages];
}
