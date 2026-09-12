'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { requireUser } from './lib/auth';
import { withRefreshOn401 } from './oauth/tokenManager';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  gmailSearchQuery,
  microsoftSearchQuery,
  parseSearchOperators,
} from '../packages/shared/src/search';

interface Address {
  email: string;
  name?: string;
}
interface SearchHit {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  snippet: string;
  fromAddress: string;
  fromName?: string;
  toAddresses: Address[];
  ccAddresses: Address[];
  receivedAt: number;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  internetMessageId?: string;
  labels: string[];
}
interface SearchPage {
  hits: SearchHit[];
  nextCursor?: string;
  incomplete?: boolean;
}

function parseAddress(raw: string): Address {
  const m = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
  return { email: raw.trim() };
}
function parseAddressList(raw?: string): Address[] {
  // Commas inside display names are not recipient separators.
  return (raw?.match(/(?:[^,"<]|"(?:\\.|[^"\\])*"|<[^>]*>)+/g) ?? []).map(parseAddress);
}
async function providerGet<T>(url: string, token: string): Promise<T> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    // Do not log provider response bodies, which can contain mailbox data.
    const err = new Error(`Mail search failed (${r.status})`) as Error & { status: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json()) as T;
}
interface GmailPart {
  filename?: string;
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
}
function hasFiles(part?: GmailPart): boolean {
  return !!part?.filename || !!part?.parts?.some(hasFiles);
}
async function searchGmail(
  ctx: ActionCtx,
  accountId: Id<'mailAccounts'>,
  raw: string,
  limit: number,
  cursor?: string,
): Promise<SearchPage> {
  const params = new URLSearchParams({ q: gmailSearchQuery(raw), maxResults: String(limit) });
  if (cursor) params.set('pageToken', cursor);
  const list = await withRefreshOn401(ctx, accountId, (token) =>
    providerGet<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, token),
  );
  const hits: SearchHit[] = [];
  let incomplete = false;
  const ids = list.messages ?? [];
  // Bound concurrency to avoid a serial network round trip for every result.
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.allSettled(
      ids.slice(i, i + 8).map(async ({ id }): Promise<SearchHit> => {
        const fields =
          'id,threadId,snippet,internalDate,labelIds,payload(headers,filename,parts(filename,parts(filename,parts(filename))))';
        const msg = await withRefreshOn401(ctx, accountId, (token) =>
          providerGet<GmailMessage>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full&fields=${encodeURIComponent(fields)}`,
            token,
          ),
        );
        const header = (name: string) =>
          msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
        const from = parseAddress(header('From') ?? '');
        const labels = msg.labelIds ?? [];
        return {
          providerMessageId: msg.id,
          providerThreadId: msg.threadId,
          subject: header('Subject') || '(no subject)',
          snippet: msg.snippet ?? '',
          fromAddress: from.email,
          fromName: from.name,
          toAddresses: parseAddressList(header('To')),
          ccAddresses: parseAddressList(header('Cc')),
          receivedAt: Number(msg.internalDate) || 0,
          isRead: !labels.includes('UNREAD'),
          isStarred: labels.includes('STARRED'),
          isDraft: labels.includes('DRAFT'),
          hasAttachments: hasFiles(msg.payload),
          internetMessageId: header('Message-ID'),
          labels,
        };
      }),
    );
    for (const result of batch) {
      if (result.status === 'fulfilled') hits.push(result.value);
      else incomplete = true;
    }
  }
  return { hits, nextCursor: list.nextPageToken, incomplete };
}
interface GraphAddress {
  emailAddress?: { address?: string; name?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  internetMessageId?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  parentFolderId?: string;
}
async function searchMicrosoft(
  ctx: ActionCtx,
  accountId: Id<'mailAccounts'>,
  raw: string,
  limit: number,
  cursor?: string,
  cachedFolders: Array<{ folderId: string; labels: string[] }> = [],
): Promise<SearchPage> {
  const p = parseSearchOperators(raw);
  const kql = microsoftSearchQuery(raw);
  const params = new URLSearchParams({
    $select:
      'id,conversationId,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients,internetMessageId,isRead,isDraft,hasAttachments,flag,categories,parentFolderId',
    $top: String(limit),
  });
  if (kql) params.set('$search', JSON.stringify(kql));
  else params.set('$orderby', 'receivedDateTime desc');
  let url = `https://graph.microsoft.com/v1.0/me/messages?${params}`;
  if (cursor) {
    const next = new URL(cursor);
    // Cursors arrive from the client. Never forward tokens to arbitrary URLs.
    if (
      next.origin !== 'https://graph.microsoft.com' ||
      next.pathname !== '/v1.0/me/messages' ||
      next.username ||
      next.password
    )
      throw new Error('Invalid search cursor');
    url = next.href;
  }
  const response = await withRefreshOn401(ctx, accountId, (token) =>
    providerGet<{
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
    }>(url, token),
  );
  let folders = cachedFolders;
  if (!folders.length && response.value?.some((m) => m.parentFolderId)) {
    folders = await Promise.all(
      [
        ['inbox', 'INBOX'],
        ['sentitems', 'SENT'],
        ['drafts', 'DRAFT'],
        ['deleteditems', 'TRASH'],
        ['junkemail', 'SPAM'],
      ].map(async ([name, label]) => {
        const folder = await withRefreshOn401(ctx, accountId, (token) =>
          providerGet<{ id: string }>(
            `https://graph.microsoft.com/v1.0/me/mailFolders/${name}?$select=id`,
            token,
          ),
        );
        return { folderId: folder.id, labels: [label] };
      }),
    );
  }
  const addresses = (items?: GraphAddress[]): Address[] =>
    (items ?? []).map((r) => ({
      email: r.emailAddress?.address ?? '',
      name: r.emailAddress?.name,
    }));
  const hits = (response.value ?? [])
    .filter((m) => {
      if (p.isUnread && m.isRead) return false;
      if (p.isRead && !m.isRead) return false;
      if (p.isStarred && m.flag?.flagStatus !== 'flagged') return false;
      if (p.label && !m.categories?.some((c) => c.toLowerCase() === p.label!.toLowerCase()))
        return false;
      return true;
    })
    .map(
      (m): SearchHit => ({
        providerMessageId: m.id,
        providerThreadId: m.conversationId || m.id,
        subject: m.subject || '(no subject)',
        snippet: m.bodyPreview ?? '',
        fromAddress: m.from?.emailAddress?.address ?? '',
        fromName: m.from?.emailAddress?.name,
        toAddresses: addresses(m.toRecipients),
        ccAddresses: addresses(m.ccRecipients),
        receivedAt: Date.parse(m.receivedDateTime ?? '') || 0,
        isRead: !!m.isRead,
        isDraft: !!m.isDraft,
        isStarred: m.flag?.flagStatus === 'flagged',
        hasAttachments: !!m.hasAttachments,
        internetMessageId: m.internetMessageId,
        labels: [
          ...(folders.find((f) => f.folderId === m.parentFolderId)?.labels ?? []),
          ...(m.categories ?? []),
        ],
      }),
    );
  return { hits, nextCursor: response['@odata.nextLink'] };
}

export const searchViaProvider = action({
  args: {
    query: v.string(),
    accountId: v.optional(v.id('mailAccounts')),
    maxResults: v.optional(v.number()),
    cursors: v.optional(v.array(v.object({ accountId: v.id('mailAccounts'), cursor: v.string() }))),
  },
  returns: v.object({
    imported: v.number(),
    matched: v.number(),
    emailIds: v.array(v.id('emails')),
    nextCursors: v.array(v.object({ accountId: v.id('mailAccounts'), cursor: v.string() })),
    failedAccounts: v.number(),
    searchedAccounts: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const empty = {
      imported: 0,
      matched: 0,
      emailIds: [] as Id<'emails'>[],
      nextCursors: [] as Array<{ accountId: Id<'mailAccounts'>; cursor: string }>,
      failedAccounts: 0,
      searchedAccounts: 0,
    };
    if (!args.query.trim()) return empty;
    if (args.query.length > 2000) throw new Error('Search is too long');
    const limit = Math.max(1, Math.min(Math.floor(args.maxResults ?? 40), 50));
    const accounts: Array<{
      _id: Id<'mailAccounts'>;
      provider: string;
      folderMap: Array<{ folderId: string; labels: string[] }>;
    }> = await ctx.runQuery(internal.searchProviderData._listSearchableAccounts, {
      userId,
      accountId: args.accountId,
    });
    const selected = args.cursors
      ? accounts.filter((a) => args.cursors!.some((c) => c.accountId === a._id))
      : accounts;
    const perAccountLimit = Math.min(
      limit,
      Math.max(1, Math.floor(100 / Math.max(1, selected.length))),
    );
    const pages = await Promise.all(
      selected.map(async (account) => {
        const cursor = args.cursors?.find((c) => c.accountId === account._id)?.cursor;
        try {
          const page =
            account.provider === 'GMAIL'
              ? await searchGmail(ctx, account._id, args.query, perAccountLimit, cursor)
              : account.provider === 'MICROSOFT'
                ? await searchMicrosoft(
                    ctx,
                    account._id,
                    args.query,
                    perAccountLimit,
                    cursor,
                    account.folderMap,
                  )
                : null;
          if (!page) return { ...empty, failedAccounts: 1 };
          const saved: { imported: number; emailIds: Id<'emails'>[] } = await ctx.runMutation(
            internal.searchProviderData._upsertSearchHits,
            { accountId: account._id, hits: page.hits },
          );
          return {
            ...saved,
            matched: page.hits.length,
            failedAccounts: page.incomplete ? 1 : 0,
            searchedAccounts: 1,
            nextCursors: page.nextCursor
              ? [{ accountId: account._id, cursor: page.nextCursor }]
              : [],
          };
        } catch (error) {
          console.warn(
            'Mail provider search unavailable',
            error instanceof Error ? error.message : 'Unknown error',
          );
          return { ...empty, failedAccounts: 1 };
        }
      }),
    );
    return pages.reduce(
      (sum, page) => ({
        imported: sum.imported + page.imported,
        matched: sum.matched + page.matched,
        emailIds: [...sum.emailIds, ...page.emailIds],
        nextCursors: [...sum.nextCursors, ...page.nextCursors],
        failedAccounts: sum.failedAccounts + page.failedAccounts,
        searchedAccounts: sum.searchedAccounts + page.searchedAccounts,
      }),
      empty,
    );
  },
});
