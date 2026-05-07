"use node";

// ─────────────────────────────────────────────────────────────────────────────
// microsoftHistorical.ts — full historical Microsoft Graph backfill.
//
// Port of:
//   - packages/backend/src/services/microsoft/microsoft-historical-sync.ts
//   - packages/backend/src/workers/microsoft-historical-sync.worker.ts
//
// We can't run the entire historical pull inside one action (Convex actions
// have a wall-clock budget), so:
//   - `startHistorical` initialises progress + kicks off the first chunk.
//   - `_continueHistorical` processes one page (~50 messages) and re-schedules
//     itself if `@odata.nextLink` is present, or finalises (snapshots a
//     deltaLink, marks COMPLETED) when done.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { withRefreshOn401 } from "../oauth/tokenManager";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const MESSAGE_SELECT_FIELDS = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "body",
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
}

interface Page {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

interface HistoricalProgress {
  syncedMessages: number;
  totalMessages: number;
  nextLink?: string;
  startedAt: string;
  lastBatchAt: string;
  error?: string;
}

interface SyncAccountInfo {
  _id: Id<"mailAccounts">;
  userId: Id<"users">;
  email: string;
  syncCursor: string | null;
  historicalSyncStatus: string;
  historicalSyncProgress: HistoricalProgress | null;
  userEmails: string[];
}

class GraphHttpError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(status: number, message: string, retryAfter: number | null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function graphFetch(url: string, accessToken: string): Promise<Page> {
  const fullUrl = url.startsWith("http") ? url : `${GRAPH_BASE}${url}`;
  const res = await fetch(fullUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : null;
    throw new GraphHttpError(
      res.status,
      `Graph ${res.status}: ${text.slice(0, 200)}`,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  return (await res.json()) as Page;
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
      )) as unknown as { id?: string };
      if (folder?.id) map.set(folder.id, [f.label]);
    } catch {
      // ignore missing folders
    }
  }
  return map;
}

function resolveLabels(
  folderMap: Map<string, string[]>,
  parentFolderId: string | undefined,
): string[] {
  if (!parentFolderId) return [];
  return folderMap.get(parentFolderId) ?? [];
}

interface ChunkContext {
  accountId: Id<"mailAccounts">;
  userId: Id<"users">;
  userEmails: string[];
  folderMap: Map<string, string[]>;
}

async function syncConversationBatch(
  ctx: ActionCtx,
  conversationId: string,
  messages: GraphMessage[],
  accessToken: string,
  cctx: ChunkContext,
): Promise<void> {
  if (messages.length === 0) return;
  messages.sort(
    (a, b) =>
      new Date(a.receivedDateTime).getTime() -
      new Date(b.receivedDateTime).getTime(),
  );

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  const subject = firstMsg.subject || "(no subject)";
  const snippet = lastMsg.bodyPreview || "";

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

  const threadId: Id<"threads"> = await ctx.runMutation(
    internal.sync.microsoftData._upsertThread,
    {
      accountId: cctx.accountId,
      providerThreadId: conversationId,
      subject,
      snippet,
      isRead: !hasUnread,
      isStarred: hasStarred,
      isArchived:
        !threadLabels.includes("INBOX") && !threadLabels.includes("SENT"),
      isTrashed: threadLabels.includes("TRASH"),
      labels: threadLabels,
      participantEmails: [...participants],
      messageCount: messages.length,
      lastMessageAt: lastDate,
      ...(lastReceivedAt !== undefined ? { lastReceivedAt } : {}),
    },
  );

  for (const msg of messages) {
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
        snippet: msg.bodyPreview,
        isRead: !!msg.isRead,
        isStarred: msg.flag?.flagStatus === "flagged",
        isDraft: !!msg.isDraft,
        labels: resolveLabels(cctx.folderMap, msg.parentFolderId),
        hasAttachments: !!msg.hasAttachments,
        receivedAt: new Date(msg.receivedDateTime).getTime(),
        sentAt: msg.sentDateTime
          ? new Date(msg.sentDateTime).getTime()
          : undefined,
      },
    )) as { emailId: Id<"emails">; isNew: boolean };

    if (upsertResult.isNew) {
      const senderLower = fromEmail.toLowerCase().trim();
      const isOutbound = !!senderLower && cctx.userEmails.includes(senderLower);
      // Historical sync intentionally still fans out the post-insert pipeline
      // so contacts/classifications get backfilled. Notifications are
      // suppressed for outbound mail; the createIfAllowed helper checks
      // per-type prefs anyway, so users can mute NEW_EMAIL during backfill.
      await ctx.runMutation(internal.sync.microsoftData._onNewEmailInserted, {
        emailId: upsertResult.emailId,
        accountId: cctx.accountId,
        bodyText: bodyText ?? null,
        isOutbound,
      });
    }
  }
}

async function getInitialDeltaLink(
  accessToken: string,
): Promise<string | null> {
  let url = `/me/messages/delta?$select=${MESSAGE_SELECT_FIELDS}&$top=1`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = (await graphFetch(url, accessToken)) as Page & {
      "@odata.deltaLink"?: string;
    };
    if (page["@odata.deltaLink"]) return page["@odata.deltaLink"];
    if (!page["@odata.nextLink"]) return null;
    url = page["@odata.nextLink"];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// startHistorical — initialise progress, schedule the first chunk.
// ─────────────────────────────────────────────────────────────────────────────

export const startHistorical = internalAction({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }): Promise<void> => {
    const accountInfo = (await ctx.runQuery(
      internal.sync.microsoftData._getAccountForSync,
      { accountId },
    )) as SyncAccountInfo | null;
    if (!accountInfo) throw new Error(`Account not found: ${accountId}`);

    const existing = accountInfo.historicalSyncProgress as
      | HistoricalProgress
      | null;
    const startedAt = existing?.startedAt ?? new Date().toISOString();
    const syncedMessages = existing?.syncedMessages ?? 0;
    const totalMessages = existing?.totalMessages ?? 0;
    const resumeUrl =
      existing?.nextLink ??
      `/me/messages?$select=${MESSAGE_SELECT_FIELDS}&$orderby=receivedDateTime desc&$top=50&$filter=isDraft eq false`;

    const progress: HistoricalProgress = {
      syncedMessages,
      totalMessages,
      nextLink: resumeUrl,
      startedAt,
      lastBatchAt: new Date().toISOString(),
    };

    await ctx.runMutation(internal.sync.microsoftData._setHistoricalProgress, {
      accountId,
      status: "IN_PROGRESS" as const,
      progress,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.sync.microsoftHistorical._continueHistorical,
      { accountId, nextLink: resumeUrl },
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// _continueHistorical — process one page, then re-schedule until done.
// ─────────────────────────────────────────────────────────────────────────────

export const _continueHistorical = internalAction({
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

    const existing =
      (accountInfo.historicalSyncProgress as HistoricalProgress | null) ??
      null;
    let syncedMessages = existing?.syncedMessages ?? 0;
    let totalMessages = existing?.totalMessages ?? 0;
    const startedAt = existing?.startedAt ?? new Date().toISOString();

    try {
      await withRefreshOn401(ctx, accountId, async (accessToken) => {
        const folderMap = await buildFolderMap(accessToken);
        const cctx: ChunkContext = {
          accountId,
          userId: accountInfo.userId,
          userEmails: accountInfo.userEmails,
          folderMap,
        };

        // Process a SINGLE page per scheduler tick to keep within action budget.
        let page: Page;
        let retries = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            page = await graphFetch(nextLink, accessToken);
            break;
          } catch (err) {
            if (err instanceof GraphHttpError) {
              if (err.status === 429 && retries < 3) {
                // Honor Retry-After (max 30s in the budget) then retry.
                const wait = Math.min((err.retryAfter ?? 30) * 1000, 30_000);
                await new Promise((r) => setTimeout(r, wait));
                retries++;
                continue;
              }
              if (err.status >= 500 && retries < 3) {
                await new Promise((r) =>
                  setTimeout(r, Math.pow(2, retries) * 1000),
                );
                retries++;
                continue;
              }
            }
            throw err;
          }
        }

        const messages = page.value || [];
        if (messages.length === 0) {
          // No more results. Snapshot a deltaLink, mark COMPLETED, exit.
          let deltaLink: string | null = null;
          try {
            deltaLink = await getInitialDeltaLink(accessToken);
          } catch {
            // not fatal
          }
          await ctx.runMutation(
            internal.sync.microsoftData._setHistoricalProgress,
            {
              accountId,
              status: "COMPLETED" as const,
              completedAt: Date.now(),
              progress: {
                syncedMessages,
                totalMessages: syncedMessages,
                startedAt,
                lastBatchAt: new Date().toISOString(),
              } as HistoricalProgress,
            },
          );
          if (deltaLink) {
            await ctx.runMutation(
              internal.sync.microsoftData._setSyncCursor,
              {
                accountId,
                syncCursor: deltaLink,
                lastSyncAt: Date.now(),
              },
            );
          }
          return;
        }

        if (page["@odata.count"]) {
          totalMessages = page["@odata.count"];
        } else if (totalMessages === 0) {
          totalMessages = Math.max(
            syncedMessages + 1000,
            messages.length * 20,
          );
        }

        // Group messages in this page by conversation.
        const groups = new Map<string, GraphMessage[]>();
        for (const msg of messages) {
          if (!groups.has(msg.conversationId)) {
            groups.set(msg.conversationId, []);
          }
          groups.get(msg.conversationId)!.push(msg);
        }

        for (const [conversationId, msgs] of groups) {
          try {
            await syncConversationBatch(
              ctx,
              conversationId,
              msgs,
              accessToken,
              cctx,
            );
            syncedMessages += msgs.length;
          } catch (err: unknown) {
            console.error(
              `[microsoft-historical] Conversation ${conversationId} failed:`,
              err instanceof Error ? err.message : err,
            );
            syncedMessages += msgs.length; // count as processed even on failure
          }
        }

        const next = page["@odata.nextLink"];
        const progress: HistoricalProgress = {
          syncedMessages,
          totalMessages,
          nextLink: next,
          startedAt,
          lastBatchAt: new Date().toISOString(),
        };
        await ctx.runMutation(
          internal.sync.microsoftData._setHistoricalProgress,
          { accountId, progress },
        );

        if (next) {
          // Reschedule for the next page with a small gap so we don't busy-loop.
          await ctx.scheduler.runAfter(
            500,
            internal.sync.microsoftHistorical._continueHistorical,
            { accountId, nextLink: next },
          );
        } else {
          // Wrap up: snapshot deltaLink and mark COMPLETED.
          let deltaLink: string | null = null;
          try {
            deltaLink = await getInitialDeltaLink(accessToken);
          } catch {
            // not fatal
          }
          await ctx.runMutation(
            internal.sync.microsoftData._setHistoricalProgress,
            {
              accountId,
              status: "COMPLETED" as const,
              completedAt: Date.now(),
              progress: {
                syncedMessages,
                totalMessages: syncedMessages,
                startedAt,
                lastBatchAt: new Date().toISOString(),
              } as HistoricalProgress,
            },
          );
          if (deltaLink) {
            await ctx.runMutation(
              internal.sync.microsoftData._setSyncCursor,
              {
                accountId,
                syncCursor: deltaLink,
                lastSyncAt: Date.now(),
              },
            );
          }
        }
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(`[microsoft-historical] Failed:`, message);
      await ctx.runMutation(
        internal.sync.microsoftData._setHistoricalProgress,
        {
          accountId,
          status: "FAILED" as const,
          progress: {
            syncedMessages,
            totalMessages,
            nextLink,
            startedAt,
            lastBatchAt: new Date().toISOString(),
            error: message,
          } as HistoricalProgress,
        },
      );
      throw err;
    }
  },
});
