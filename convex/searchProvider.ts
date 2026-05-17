"use node";

// ─────────────────────────────────────────────────────────────────────────────
// searchProvider.ts — Provider-side full-text search fallback.
//
// Why this exists: incremental sync only stores headers + snippet for emails
// the user hasn't opened (see convex/sync/onDemandBody.ts). Local search
// (convex/search.ts) already only looks at subject/snippet/sender — but the
// AI chat's search_emails tool also searches bodyText, which is missing for
// unopened mail. This action escalates to Gmail's / Graph's server-side
// full-text indexes when local results are sparse, then imports the matches
// into Convex so they show up in the regular reactive thread list.
//
// Cost profile: per-search, not per-incoming-email. Bounded to maxResults
// per call (default 10). Imports a thin metadata stub for each new hit; the
// body still loads lazily via the existing on-demand fetcher when the user
// clicks the result.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { withRefreshOn401 } from "./oauth/tokenManager";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 25;

// ─── Tiny header helpers (mirror gmail.ts; kept inline so we don't have to
//     import a "use node" sibling). ──────────────────────────────────────────

interface GmailHeader {
  name?: string;
  value?: string;
}

function getHeader(headers: GmailHeader[] | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
    ?.value;
}

function parseAddress(raw: string): { email: string; name?: string } {
  const m = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, "").trim(), email: m[2].trim() };
  return { email: raw.trim() };
}

function parseAddressList(raw: string | undefined) {
  if (!raw) return [];
  return raw.split(",").map((a) => parseAddress(a));
}

// ─── Provider HTTP helpers ──────────────────────────────────────────────────

async function gmailGet<T>(url: string, token: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(
      `Gmail ${r.status}: ${text.slice(0, 300)}`,
    ) as Error & { status: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json()) as T;
}

async function graphGet<T>(url: string, token: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ConsistencyLevel: "eventual",
    },
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(
      `Graph ${r.status}: ${text.slice(0, 300)}`,
    ) as Error & { status: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json()) as T;
}

// ─── Provider search calls ──────────────────────────────────────────────────

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>;
}

interface GmailMetadataResponse {
  id?: string;
  snippet?: string;
  internalDate?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: {
    headers?: GmailHeader[];
  };
}

interface GraphMessageSearchResponse {
  value?: Array<{
    id: string;
    conversationId?: string;
    subject?: string;
    bodyPreview?: string;
    receivedDateTime?: string;
    from?: { emailAddress?: { address?: string; name?: string } };
    toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
    ccRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
    bccRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
    internetMessageId?: string;
    isRead?: boolean;
    isDraft?: boolean;
    hasAttachments?: boolean;
  }>;
}

async function searchGmail(
  ctx: ActionCtx,
  accountId: Id<"mailAccounts">,
  query: string,
  maxResults: number,
): Promise<
  Array<{
    providerMessageId: string;
    providerThreadId: string;
    subject: string;
    snippet: string;
    fromAddress: string;
    fromName?: string;
    toAddresses: Array<{ email: string; name?: string }>;
    ccAddresses: Array<{ email: string; name?: string }>;
    receivedAt: number;
    isRead: boolean;
    internetMessageId?: string;
    labels: string[];
  }>
> {
  const list = await withRefreshOn401(ctx, accountId, async (token) =>
    gmailGet<GmailMessageListResponse>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      token,
    ),
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const hits = [];
  for (const id of ids) {
    try {
      const msg = await withRefreshOn401(ctx, accountId, async (token) =>
        gmailGet<GmailMetadataResponse>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
          token,
        ),
      );
      const headers = msg.payload?.headers ?? [];
      const from = parseAddress(getHeader(headers, "From") || "");
      const labels = msg.labelIds ?? [];
      hits.push({
        providerMessageId: msg.id ?? id,
        providerThreadId: msg.threadId ?? id,
        subject: getHeader(headers, "Subject") || "(no subject)",
        snippet: msg.snippet || "",
        fromAddress: from.email,
        fromName: from.name,
        toAddresses: parseAddressList(getHeader(headers, "To")),
        ccAddresses: parseAddressList(getHeader(headers, "Cc")),
        receivedAt: msg.internalDate ? Number(msg.internalDate) : Date.now(),
        isRead: !labels.includes("UNREAD"),
        internetMessageId: getHeader(headers, "Message-ID"),
        labels,
      });
    } catch (err) {
      console.warn(`[searchProvider] gmail metadata fetch failed for ${id}:`, err);
    }
  }
  return hits;
}

async function searchMicrosoft(
  ctx: ActionCtx,
  accountId: Id<"mailAccounts">,
  query: string,
  maxResults: number,
): Promise<
  Array<{
    providerMessageId: string;
    providerThreadId: string;
    subject: string;
    snippet: string;
    fromAddress: string;
    fromName?: string;
    toAddresses: Array<{ email: string; name?: string }>;
    ccAddresses: Array<{ email: string; name?: string }>;
    receivedAt: number;
    isRead: boolean;
    internetMessageId?: string;
    labels: string[];
  }>
> {
  // Graph $search needs ConsistencyLevel: eventual (handled in graphGet).
  const select =
    "id,conversationId,subject,bodyPreview,receivedDateTime,from,toRecipients,ccRecipients,bccRecipients,internetMessageId,isRead,isDraft,hasAttachments";
  const res = await withRefreshOn401(ctx, accountId, async (token) =>
    graphGet<GraphMessageSearchResponse>(
      `https://graph.microsoft.com/v1.0/me/messages?$select=${select}&$top=${maxResults}&$search="${encodeURIComponent(query)}"`,
      token,
    ),
  );
  return (res.value ?? []).map((m) => ({
    providerMessageId: m.id,
    providerThreadId: m.conversationId || m.id,
    subject: m.subject || "(no subject)",
    snippet: m.bodyPreview || "",
    fromAddress: m.from?.emailAddress?.address || "(unknown)",
    fromName: m.from?.emailAddress?.name,
    toAddresses: (m.toRecipients ?? []).map((r) => ({
      email: r.emailAddress?.address || "",
      name: r.emailAddress?.name,
    })),
    ccAddresses: (m.ccRecipients ?? []).map((r) => ({
      email: r.emailAddress?.address || "",
      name: r.emailAddress?.name,
    })),
    receivedAt: m.receivedDateTime
      ? new Date(m.receivedDateTime).getTime()
      : Date.now(),
    isRead: !!m.isRead,
    internetMessageId: m.internetMessageId,
    labels: [],
  }));
}

// ─── Public action: search via provider, import missing matches ────────────

export const searchViaProvider = action({
  args: {
    query: v.string(),
    accountId: v.optional(v.id("mailAccounts")),
    maxResults: v.optional(v.number()),
  },
  returns: v.object({
    imported: v.number(),
    matched: v.number(),
    emailIds: v.array(v.id("emails")),
  }),
  handler: async (ctx, { query, accountId, maxResults }) => {
    const userId = await requireUser(ctx);
    if (!query.trim()) return { imported: 0, matched: 0, emailIds: [] };

    const limit = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

    const accounts: Array<{ _id: Id<"mailAccounts">; provider: string }> =
      await ctx.runQuery(internal.searchProviderData._listSearchableAccounts, {
        userId,
        accountId,
      });
    if (accounts.length === 0) {
      return { imported: 0, matched: 0, emailIds: [] };
    }

    const allEmailIds: Id<"emails">[] = [];
    let importedCount = 0;
    let matchedCount = 0;

    for (const account of accounts) {
      let hits: Awaited<ReturnType<typeof searchGmail>> = [];
      try {
        if (account.provider === "GMAIL") {
          hits = await searchGmail(ctx, account._id, query, limit);
        } else if (account.provider === "MICROSOFT") {
          hits = await searchMicrosoft(ctx, account._id, query, limit);
        }
      } catch (err) {
        console.warn(
          `[searchProvider] provider search failed for ${account._id}:`,
          err,
        );
        continue;
      }
      matchedCount += hits.length;
      if (hits.length === 0) continue;

      const result: { imported: number; emailIds: Id<"emails">[] } =
        await ctx.runMutation(internal.searchProviderData._upsertSearchHits, {
          accountId: account._id,
          hits,
        });
      importedCount += result.imported;
      allEmailIds.push(...result.emailIds);
    }

    return {
      imported: importedCount,
      matched: matchedCount,
      emailIds: allEmailIds,
    };
  },
});

// Internal helpers (queries + mutations) live in convex/searchProviderData.ts
// because Convex disallows queries/mutations inside "use node" modules.
