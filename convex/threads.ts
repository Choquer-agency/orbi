import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getUserMailAccountIds(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<Id<"mailAccounts">[]> {
  const accounts = await ctx.db
    .query("mailAccounts")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  return accounts.map((a: Doc<"mailAccounts">) => a._id);
}

function normalizeAddressList(value: unknown): Array<{ email?: string; name?: string }> {
  if (Array.isArray(value)) return value as Array<{ email?: string; name?: string }>;
  if (!value) return [];
  if (typeof value === "string") return value ? [{ email: value }] : [];
  if (typeof value === "object") return [value as { email?: string; name?: string }];
  return [];
}

async function getUserAccountEmails(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<{ ids: Id<"mailAccounts">[]; emails: string[] }> {
  const accounts = await ctx.db
    .query("mailAccounts")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  return {
    ids: accounts.map((a: Doc<"mailAccounts">) => a._id),
    emails: accounts
      .map((a: Doc<"mailAccounts">) => a.email)
      .filter(Boolean)
      .map((e: string) => e.toLowerCase()),
  };
}

function isSelfAddress(allAccountEmails: string[], fromAddress: string | undefined | null): boolean {
  if (!fromAddress) return false;
  return allAccountEmails.includes(fromAddress.toLowerCase());
}

async function userOwnsThread(
  ctx: { db: any },
  userId: Id<"users">,
  thread: Doc<"threads">,
): Promise<boolean> {
  const account = await ctx.db.get(thread.accountId);
  if (account && (account as Doc<"mailAccounts">).userId === userId) return true;
  const access = await ctx.db
    .query("threadAccess")
    .withIndex("by_thread_user", (q: any) =>
      q.eq("threadId", thread._id).eq("userId", userId),
    )
    .unique();
  return !!access;
}

function ciIncludes(haystack: string | undefined | null, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Search-operator parsing (ported from Fastify route)
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedSearch {
  text: string;
  from?: string;
  to?: string;
  cc?: string;
  before?: number;
  after?: number;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  isRead?: boolean;
  label?: string;
}

const OPERATOR_RE = /(?:^|\s)(from|to|cc|before|after|has|is|label):(\S+)/gi;

function parseSearchOperators(raw: string): ParsedSearch {
  const result: ParsedSearch = { text: "" };
  let remaining = raw;

  for (const match of raw.matchAll(OPERATOR_RE)) {
    const op = match[1].toLowerCase();
    const val = match[2];
    switch (op) {
      case "from":
        result.from = val;
        break;
      case "to":
        result.to = val;
        break;
      case "cc":
        result.cc = val;
        break;
      case "before": {
        const d = new Date(val);
        if (!isNaN(d.getTime())) result.before = d.getTime();
        break;
      }
      case "after": {
        const d = new Date(val);
        if (!isNaN(d.getTime())) result.after = d.getTime();
        break;
      }
      case "has":
        if (val.toLowerCase() === "attachment") result.hasAttachment = true;
        break;
      case "is":
        if (val.toLowerCase() === "unread") result.isUnread = true;
        else if (val.toLowerCase() === "starred") result.isStarred = true;
        else if (val.toLowerCase() === "read") result.isRead = true;
        break;
      case "label":
        result.label = val;
        break;
    }
    remaining = remaining.replace(match[0], " ");
  }

  result.text = remaining.replace(/\s+/g, " ").trim();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// list — main thread list (folder + filters + lightweight search)
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    accountId: v.optional(v.id("mailAccounts")),
    folder: v.optional(v.string()),
    isRead: v.optional(v.boolean()),
    isStarred: v.optional(v.boolean()),
    isArchived: v.optional(v.boolean()),
    search: v.optional(v.string()),
    from: v.optional(v.string()),
    category: v.optional(v.string()),
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const pageNum = args.page ?? 1;
    // Cap is generous so the per-page request can grow without silently
    // truncating (a tight cap would leave hasMore=true and loop the
    // IntersectionObserver). Frontend usually sends limit=80.
    const limitNum = Math.min(args.limit ?? 80, 2000);
    const skip = (pageNum - 1) * limitNum;

    const { ids: ownedAccountIds, emails: allAccountEmails } =
      await getUserAccountEmails(ctx, userId);

    const accountIds: Id<"mailAccounts">[] = args.accountId
      ? [args.accountId]
      : ownedAccountIds;
    if (accountIds.length === 0) {
      return { data: [], total: 0, page: pageNum, limit: limitNum, hasMore: false };
    }

    const searchTerm = args.search?.trim();
    const fromEmail = args.from?.trim();
    const folder = args.folder;

    let isFromFastPath = false;
    let parsed: ParsedSearch | null = null;
    if (searchTerm && searchTerm.length > 0) {
      parsed = parseSearchOperators(searchTerm);
    }
    // Free-text portion of the search term (after stripping operators like
    // from:, label:, etc). When this is non-empty we use the Convex search
    // indexes to look across the ENTIRE mailbox instead of the most recent
    // 2,500 threads — that was the gap users hit on big imports.
    const freeText = parsed?.text?.trim() ?? "";
    const useSearchIndex = freeText.length > 0;

    // Drafts fast path: when the user just wants the Drafts folder, the
    // generic candidate sweep (fetch top-N threads per account, then fan out
    // every thread's emails to find which have isDraft) would read every
    // body in the mailbox just to filter for a handful of draft rows. Use
    // the dedicated `by_account_isDraft_receivedAt` index instead — that
    // returns draft rows directly, so we only ever touch threads that
    // actually have a draft.
    if (folder === "drafts" && !searchTerm && !fromEmail) {
      const draftsArrays = await Promise.all(
        accountIds.map((aid) =>
          ctx.db
            .query("emails")
            .withIndex("by_account_isDraft_receivedAt", (q) =>
              q.eq("accountId", aid).eq("isDraft", true),
            )
            .order("desc")
            .take(skip + limitNum + 1),
        ),
      );
      // Pick the most-recent draft per thread and stash a tiny projection
      // (no bodyHtml) so the hydration loop below doesn't re-query the
      // emails table — that re-query reads every draft row's HTML for the
      // account and trips the 16MB limit on accounts with many drafts.
      const draftByThread = new Map<
        Id<"threads">,
        {
          fromAddress: string;
          fromName: string | undefined;
          snippet: string | undefined;
          receivedAt: number;
        }
      >();
      for (const d of draftsArrays.flat()) {
        const cur = draftByThread.get(d.threadId);
        if (!cur || d.receivedAt > cur.receivedAt) {
          draftByThread.set(d.threadId, {
            fromAddress: d.fromAddress,
            fromName: d.fromName,
            snippet: d.snippet,
            receivedAt: d.receivedAt,
          });
        }
      }
      const sortedThreadIds = Array.from(draftByThread.entries())
        .sort((a, b) => b[1].receivedAt - a[1].receivedAt)
        .map(([id]) => id);
      const total = sortedThreadIds.length;
      const pagedIds = sortedThreadIds.slice(skip, skip + limitNum);
      const draftThreads = (
        await Promise.all(pagedIds.map((id) => ctx.db.get(id)))
      ).filter((t): t is Doc<"threads"> => !!t && !t.isTrashed);
      const data = await Promise.all(
        draftThreads.map(async (t) => {
          const draftPreview = draftByThread.get(t._id);
          const comments = await ctx.db
            .query("threadComments")
            .withIndex("by_thread", (q) => q.eq("threadId", t._id))
            .collect();
          return {
            ...t,
            id: t._id,
            emails: draftPreview
              ? [
                  {
                    fromAddress: draftPreview.fromAddress,
                    fromName: draftPreview.fromName,
                    snippet: draftPreview.snippet,
                    receivedAt: draftPreview.receivedAt,
                    classification: null,
                  },
                ]
              : [],
            _count: { comments: comments.length },
            hasDraft: true,
          };
        }),
      );
      return {
        data,
        total,
        page: pageNum,
        limit: limitNum,
        hasMore: skip + limitNum < total,
      };
    }

    // Spam folder mirrors the upstream provider's SPAM label directly
    // (Gmail / Outlook). We trust the provider's anti-spam filter rather
    // than running our own — see classifier.ts. Scan recent threads per
    // account and keep the ones whose labels include "SPAM".
    if (folder === "spam" && !searchTerm && !fromEmail) {
      const perAccountLimit = 2000;
      const threadsArrays = await Promise.all(
        accountIds.map((aid) =>
          ctx.db
            .query("threads")
            .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", aid))
            .order("desc")
            .take(perAccountLimit),
        ),
      );
      const spamThreads = threadsArrays
        .flat()
        .filter((t) => !t.isTrashed && t.labels.includes("SPAM"))
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      const total = spamThreads.length;
      const pagedThreads = spamThreads.slice(skip, skip + limitNum);
      const data = await Promise.all(
        pagedThreads.map(async (t) => {
          const lastEmail = await ctx.db
            .query("emails")
            .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
            .order("desc")
            .first();
          const comments = await ctx.db
            .query("threadComments")
            .withIndex("by_thread", (q) => q.eq("threadId", t._id))
            .collect();
          return {
            ...t,
            id: t._id,
            emails: lastEmail
              ? [
                  {
                    fromAddress: lastEmail.fromAddress,
                    fromName: lastEmail.fromName,
                    snippet: lastEmail.snippet,
                    receivedAt: lastEmail.receivedAt,
                    classification: null,
                  },
                ]
              : [],
            _count: { comments: comments.length },
            hasDraft: false,
          };
        }),
      );
      return {
        data,
        total,
        page: pageNum,
        limit: limitNum,
        hasMore: skip + limitNum < total,
      };
    }

    // Shared With Me = threads where a teammate @-mentioned me in an internal
    // comment. Source of truth is `threadMentions`, not `threadAccess` (which
    // also catches handoffs / ad-hoc grants the user doesn't want surfaced
    // here). Self-mentions are excluded so authoring your own comment can't
    // drag the thread into this view.
    if (folder === "shared" && !searchTerm && !fromEmail) {
      const mentionRows = await ctx.db
        .query("threadMentions")
        .withIndex("by_user", (q) => q.eq("mentionedUserId", userId))
        .collect();

      const threadIds = new Set<Id<"threads">>();
      for (const m of mentionRows) {
        const comment = await ctx.db.get(m.commentId);
        if (comment && comment.authorId !== userId) {
          threadIds.add(m.threadId);
        }
      }

      const sharedThreads = (
        await Promise.all(Array.from(threadIds).map((id) => ctx.db.get(id)))
      )
        .filter((t): t is Doc<"threads"> => !!t && !t.isTrashed)
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      const total = sharedThreads.length;
      const pagedThreads = sharedThreads.slice(skip, skip + limitNum);
      const data = await Promise.all(
        pagedThreads.map(async (t) => {
          const lastEmail = await ctx.db
            .query("emails")
            .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
            .order("desc")
            .first();
          const comments = await ctx.db
            .query("threadComments")
            .withIndex("by_thread", (q) => q.eq("threadId", t._id))
            .collect();
          return {
            ...t,
            id: t._id,
            emails: lastEmail
              ? [
                  {
                    fromAddress: lastEmail.fromAddress,
                    fromName: lastEmail.fromName,
                    snippet: lastEmail.snippet,
                    receivedAt: lastEmail.receivedAt,
                    classification: null,
                  },
                ]
              : [],
            _count: { comments: comments.length },
            hasDraft: false,
          };
        }),
      );
      return {
        data,
        total,
        page: pageNum,
        limit: limitNum,
        hasMore: skip + limitNum < total,
      };
    }

    // Marketing fast path uses the AI emailClassifications table because the
    // pink "Marketing" pill in the inbox is driven by that signal, not a Gmail
    // label. Pull recent classifications matching this category and assemble
    // the thread list from them directly.
    if (folder === "marketing" && !searchTerm && !fromEmail) {
      const CLASSIFICATION_HITS = 300;
      const classifications = await ctx.db
        .query("emailClassifications")
        .withIndex("by_category", (q) => q.eq("category", folder))
        .order("desc")
        .take(CLASSIFICATION_HITS);
      const userAccountSet = new Set(accountIds.map((a) => String(a)));
      const threadLatest = new Map<
        Id<"threads">,
        {
          email: Doc<"emails">;
          classification: {
            category: string;
            confidence?: number;
            urgency?: string;
            summary?: string;
          };
        }
      >();
      for (const c of classifications) {
        const email = await ctx.db.get(c.emailId);
        if (!email) continue;
        if (!userAccountSet.has(String(email.accountId))) continue;
        const cur = threadLatest.get(email.threadId);
        if (!cur || email.receivedAt > cur.email.receivedAt) {
          threadLatest.set(email.threadId, {
            email,
            classification: {
              category: c.category,
              confidence: c.confidence,
              urgency: c.urgency,
              summary: c.summary,
            },
          });
        }
      }
      const sortedThreadIds = Array.from(threadLatest.entries())
        .sort((a, b) => b[1].email.receivedAt - a[1].email.receivedAt)
        .map(([id]) => id);
      const visibleIds = sortedThreadIds.filter((_id) => true);
      const total = visibleIds.length;
      const pagedIds = visibleIds.slice(skip, skip + limitNum);
      const pagedThreads = (
        await Promise.all(pagedIds.map((id) => ctx.db.get(id)))
      ).filter(
        (t): t is Doc<"threads"> => !!t && !t.isTrashed && !t.isArchived,
      );
      const data = await Promise.all(
        pagedThreads.map(async (t) => {
          const hit = threadLatest.get(t._id)!;
          const comments = await ctx.db
            .query("threadComments")
            .withIndex("by_thread", (q) => q.eq("threadId", t._id))
            .collect();
          return {
            ...t,
            id: t._id,
            emails: [
              {
                fromAddress: hit.email.fromAddress,
                fromName: hit.email.fromName,
                snippet: hit.email.snippet,
                receivedAt: hit.email.receivedAt,
                classification: hit.classification,
              },
            ],
            _count: { comments: comments.length },
            hasDraft: false,
          };
        }),
      );
      return {
        data,
        total,
        page: pageNum,
        limit: limitNum,
        hasMore: skip + limitNum < total,
      };
    }

    // Inbox-split / category fast path. The inbox tab bar passes args.category
    // ("client_work", "internal", "billing", etc — comma-separated when the
    // user combines several into one split). The generic candidate-fan-out
    // path would read every email body in every recent thread to filter by
    // classification, which trivially blows the 16MB read limit on a real
    // mailbox. Here we go directly to the classifications index instead.
    if (args.category && !searchTerm && !fromEmail) {
      const cats = args.category
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cats.length > 0) {
        const PER_CATEGORY_HITS = 200;
        const allClassifications: Doc<"emailClassifications">[] = [];
        for (const cat of cats) {
          const hits = await ctx.db
            .query("emailClassifications")
            .withIndex("by_category", (q) => q.eq("category", cat))
            .order("desc")
            .take(PER_CATEGORY_HITS);
          allClassifications.push(...hits);
        }
        const userAccountSet = new Set(accountIds.map((a) => String(a)));
        const threadLatest = new Map<
          Id<"threads">,
          {
            email: Doc<"emails">;
            classification: {
              category: string;
              confidence?: number;
              urgency?: string;
              summary?: string;
            };
          }
        >();
        for (const c of allClassifications) {
          const email = await ctx.db.get(c.emailId);
          if (!email) continue;
          if (!userAccountSet.has(String(email.accountId))) continue;
          const cur = threadLatest.get(email.threadId);
          if (!cur || email.receivedAt > cur.email.receivedAt) {
            threadLatest.set(email.threadId, {
              email,
              classification: {
                category: c.category,
                confidence: c.confidence,
                urgency: c.urgency,
                summary: c.summary,
              },
            });
          }
        }
        const sortedThreadIds = Array.from(threadLatest.entries())
          .sort((a, b) => b[1].email.receivedAt - a[1].email.receivedAt)
          .map(([id]) => id);
        const total = sortedThreadIds.length;
        const pagedIds = sortedThreadIds.slice(skip, skip + limitNum);
        const pagedThreads = (
          await Promise.all(pagedIds.map((id) => ctx.db.get(id)))
        ).filter(
          (t): t is Doc<"threads"> =>
            !!t && !t.isTrashed && !t.isArchived && !t.snoozedUntil,
        );
        const data = await Promise.all(
          pagedThreads.map(async (t) => {
            const hit = threadLatest.get(t._id)!;
            const comments = await ctx.db
              .query("threadComments")
              .withIndex("by_thread", (q) => q.eq("threadId", t._id))
              .collect();
            return {
              ...t,
              id: t._id,
              emails: [
                {
                  fromAddress: hit.email.fromAddress,
                  fromName: hit.email.fromName,
                  snippet: hit.email.snippet,
                  receivedAt: hit.email.receivedAt,
                  classification: hit.classification,
                },
              ],
              _count: { comments: comments.length },
              hasDraft: false,
            };
          }),
        );
        return {
          data,
          total,
          page: pageNum,
          limit: limitNum,
          hasMore: skip + limitNum < total,
        };
      }
    }

    // Pull threads. Default path: most recent N per account by lastMessageAt.
    // Search path: query the search indexes on threads.subject AND
    // emails.bodyText, then load the matching thread rows.
    let candidates: Doc<"threads">[];
    if (useSearchIndex) {
      // Email search hits load *whole* email docs (full HTML body) just so we
      // can read .threadId off them. With long histories that's tens of MB
      // and trips the 16MB read limit. Subject hits are thread docs, cheap.
      // We use a tighter cap on body hits since ranked-top-50 from BM25 is
      // already deep enough for a real result set; the user can scroll.
      const SUBJECT_HITS_PER_ACCOUNT = 200;
      const BODY_HITS_PER_ACCOUNT = 50;
      const subjectHitsArrays = await Promise.all(
        accountIds.map((aid) =>
          ctx.db
            .query("threads")
            .withSearchIndex("search_subject", (q) =>
              q.search("subject", freeText).eq("accountId", aid),
            )
            .take(SUBJECT_HITS_PER_ACCOUNT),
        ),
      );
      const bodyHitsArrays = await Promise.all(
        accountIds.map((aid) =>
          ctx.db
            .query("emails")
            .withSearchIndex("search_body", (q) =>
              q.search("bodyText", freeText).eq("accountId", aid),
            )
            .take(BODY_HITS_PER_ACCOUNT),
        ),
      );

      // Convex's search index uses BM25 ranking, which happily returns hits
      // that match only some of the query tokens (the user reported searching
      // "country lumber" and getting Google Merchant Center emails that only
      // had "country" in them). Tighten the contract to AND-of-all-tokens
      // here: require every non-trivial token from the query to literally
      // appear in the subject or in the body we already read from the index.
      // Phrase mode: if the user wrapped the query in double quotes we keep
      // the entire phrase as a single token so "country lumber" only matches
      // adjacent occurrences.
      const tokens = (() => {
        const t = freeText.trim();
        if (t.startsWith('"') && t.endsWith('"') && t.length >= 3) {
          return [t.slice(1, -1).toLowerCase()];
        }
        return t
          .toLowerCase()
          .split(/\s+/)
          .filter((s) => s.length >= 2);
      })();
      const allTokensIn = (haystack: string | undefined | null): boolean => {
        if (!haystack) return false;
        const lower = haystack.toLowerCase();
        return tokens.every((tok) => lower.includes(tok));
      };

      const threadIdSet = new Set<Id<"threads">>();
      const subjectMatches = subjectHitsArrays.flat();
      for (const t of subjectMatches) {
        if (allTokensIn(t.subject) || allTokensIn(t.snippet)) {
          threadIdSet.add(t._id);
        }
      }
      for (const e of bodyHitsArrays.flat()) {
        if (
          allTokensIn(e.subject) ||
          allTokensIn(e.bodyText) ||
          allTokensIn(e.fromAddress) ||
          allTokensIn(e.fromName)
        ) {
          threadIdSet.add(e.threadId);
        }
      }
      const merged = await Promise.all(
        Array.from(threadIdSet).map((id) => ctx.db.get(id)),
      );
      candidates = merged.filter((t): t is Doc<"threads"> => !!t);
    } else {
      // Pull threads from each account index (fan-out then merge — Convex doesn't support `IN`).
      // Non-search browse keeps a smaller window because the list has infinite scroll.
      const isFilterSearchMode = !!(fromEmail || args.category);
      const perAccountLimit = isFilterSearchMode ? 2500 : 500;
      const threadsArrays = await Promise.all(
        accountIds.map((aid) =>
          ctx.db
            .query("threads")
            .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", aid))
            .order("desc")
            .take(perAccountLimit),
        ),
      );
      candidates = threadsArrays.flat();
    }

    if (fromEmail && fromEmail.length > 0) {
      isFromFastPath = true;
      candidates = candidates.filter((t) => !t.isTrashed);
    } else if (parsed) {
      candidates = candidates.filter((t) => !t.isTrashed);
      if (parsed.isUnread) candidates = candidates.filter((t) => !t.isRead);
      if (parsed.isRead) candidates = candidates.filter((t) => t.isRead);
      if (parsed.isStarred) candidates = candidates.filter((t) => t.isStarred);
      if (parsed.label) {
        candidates = candidates.filter((t) => t.labels.includes(parsed!.label!));
      }
    } else {
      // Folder-based filtering
      switch (folder) {
        case "starred":
          candidates = candidates.filter(
            (t) => t.isStarred && !t.isTrashed && !t.isArchived,
          );
          break;
        case "sent":
          candidates = candidates.filter((t) => !t.isTrashed && !t.isArchived);
          break;
        case "drafts":
          candidates = candidates.filter((t) => !t.isTrashed);
          break;
        case "archive":
          candidates = candidates.filter((t) => t.isArchived && !t.isTrashed);
          break;
        case "trash":
          candidates = candidates.filter((t) => t.isTrashed);
          break;
        case "snoozed":
          candidates = candidates.filter((t) => !t.isTrashed && t.snoozedUntil);
          break;
        case "marketing":
        case "spam":
          candidates = candidates.filter(
            (t) => !t.isTrashed && t.labels.includes(`triage:${folder}`),
          );
          break;
        default:
          // Default = inbox: not trashed, not archived, not snoozed, and with
          // at least one received message. Use thread metadata instead of
          // loading every email in every thread.
          candidates = candidates.filter(
            (t) =>
              !t.isTrashed &&
              !t.isArchived &&
              !t.snoozedUntil &&
              (t.lastReceivedAt ?? 0) > 0,
          );
          // Optional triage exclusion
          {
            const triage = await ctx.db
              .query("triageSettings")
              .withIndex("by_user", (q) => q.eq("userId", userId))
              .unique();
            if (triage?.autoSortEnabled) {
              candidates = candidates.filter(
                (t) =>
                  !t.labels.includes("triage:marketing") &&
                  !t.labels.includes("triage:spam"),
              );
            }
          }
          break;
      }

      if (args.isRead !== undefined)
        candidates = candidates.filter((t) => t.isRead === args.isRead);
      if (args.isStarred !== undefined)
        candidates = candidates.filter((t) => t.isStarred === args.isStarred);
      if (args.isArchived !== undefined)
        candidates = candidates.filter((t) => t.isArchived === args.isArchived);
    }

    // The inbox "needs at least one received email" check used to fan out
    // every candidate's emails just to inspect from-addresses; with a fully
    // historically-synced mailbox that's tens of MB of body HTML on every
    // inbox open and trips the 16MB read limit. Sync workers denormalize
    // `lastReceivedAt` onto the thread — use that instead.
    const isInboxDefault =
      !searchTerm && !fromEmail && (!folder || folder === "inbox");
    if (isInboxDefault) {
      candidates = candidates.filter((t) => t.lastReceivedAt !== undefined);
    }

    // Folder-needs-emails lookups (sent, drafts, fast from filter,
    // operator filters, has:attachment): fan out emails per thread.
    // Note: a free-text-only search (parsed.text without operators) is fully
    // satisfied by the search index above — we deliberately skip the email
    // load there to avoid re-reading the bodies we just searched.
    const hasOperatorFilters = !!(
      parsed && (parsed.from || parsed.to ||
        parsed.before !== undefined || parsed.after !== undefined ||
        parsed.hasAttachment)
    );
    const needsEmails =
      isFromFastPath ||
      hasOperatorFilters ||
      folder === "sent" ||
      folder === "drafts";

    let filtered = candidates;
    if (needsEmails) {
      const enriched = await Promise.all(
        candidates.map(async (t) => {
          const emails = await ctx.db
            .query("emails")
            .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
            .order("desc")
            .take(10);
          return { thread: t, emails };
        }),
      );

      filtered = enriched
        .filter(({ thread, emails }) => {
          if (isFromFastPath) {
            return emails.some((e) => e.fromAddress === fromEmail);
          }
          if (parsed) {
            // Email-level operator filters
            const matchesEmailFilters = emails.some((e) => {
              if (parsed!.from) {
                const ok =
                  ciIncludes(e.fromAddress, parsed!.from) ||
                  ciIncludes(e.fromName, parsed!.from);
                if (!ok) return false;
              }
              if (parsed!.to) {
                // toAddresses is JSON; stringify and search.
                if (!ciIncludes(JSON.stringify(e.toAddresses ?? []), parsed!.to))
                  return false;
              }
              if (parsed!.cc) {
                // ccAddresses is JSON; stringify and search.
                if (!ciIncludes(JSON.stringify(e.ccAddresses ?? []), parsed!.cc))
                  return false;
              }
              if (parsed!.before !== undefined && e.receivedAt >= parsed!.before)
                return false;
              if (parsed!.after !== undefined && e.receivedAt <= parsed!.after)
                return false;
              if (parsed!.hasAttachment && !e.hasAttachments) return false;
              return true;
            });
            const hasOperatorFilters =
              !!parsed.from ||
              !!parsed.to ||
              !!parsed.cc ||
              parsed.before !== undefined ||
              parsed.after !== undefined ||
              !!parsed.hasAttachment;
            if (hasOperatorFilters && !matchesEmailFilters) return false;

            // Text-substring filter only runs when we DIDN'T use the search
            // index. The search index already ranked & filtered by relevance
            // (BM25-style), so applying a stricter substring match here would
            // drop legitimate fuzzy/stemmed hits.
            if (!useSearchIndex && parsed.text.length > 0) {
              const subjectHit = ciIncludes(thread.subject, parsed.text);
              const snippetHit = ciIncludes(thread.snippet ?? "", parsed.text);
              const emailHit = emails.some(
                (e) =>
                  ciIncludes(e.fromAddress, parsed!.text) ||
                  ciIncludes(e.fromName, parsed!.text) ||
                  ciIncludes(e.bodyText, parsed!.text) ||
                  ciIncludes(e.subject, parsed!.text),
              );
              if (!subjectHit && !snippetHit && !emailHit) return false;
            }
            return true;
          }

          // Folder-specific filters that need emails:
          if (folder === "sent") {
            return emails.some(
              (e) => isSelfAddress(allAccountEmails, e.fromAddress) && !e.isDraft,
            );
          }
          if (folder === "drafts") {
            return emails.some((e) => e.isDraft);
          }
          // Inbox-default's "must have a received email" check is handled
          // upfront with thread.lastReceivedAt — no need to inspect emails here.
          return true;
        })
        .map(({ thread }) => thread);
    }

    // Category filter (post-process: needs email classifications)
    if (args.category) {
      const cats = args.category
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cats.length > 0) {
        const cleared: Doc<"threads">[] = [];
        for (const t of filtered) {
          const emails = await ctx.db
            .query("emails")
            .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
            .order("desc")
            .take(10);
          let matched = false;
          for (const e of emails) {
            const cls = await ctx.db
              .query("emailClassifications")
              .withIndex("by_email", (q) => q.eq("emailId", e._id))
              .unique();
            if (cls && cats.includes(cls.category)) {
              matched = true;
              break;
            }
          }
          if (matched) cleared.push(t);
        }
        filtered = cleared;
      }
    }

    // Sort by latest thread activity. The inbox should stay conversation-like:
    // if you send the latest reply, that thread still belongs near the top
    // instead of being ranked by the older last inbound message.
    const sortBy = "lastMessageAt" as "lastMessageAt" | "lastReceivedAt";
    filtered.sort((a, b) => {
      const aV =
        sortBy === "lastReceivedAt"
          ? (a.lastReceivedAt ?? a.lastMessageAt)
          : a.lastMessageAt;
      const bV =
        sortBy === "lastReceivedAt"
          ? (b.lastReceivedAt ?? b.lastMessageAt)
          : b.lastMessageAt;
      return bV - aV;
    });

    const total = filtered.length;
    const paged = filtered.slice(skip, skip + limitNum);

    // Hydrate: latest email + comment count + hasDraft.
    // Keep this loop cheap — it runs once per visible row. Pulling 25 full
    // email docs (each with bodyHtml) per row was the dominant cost.
    const data = await Promise.all(
      paged.map(async (t) => {
        const emailsDesc = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
          .order("desc")
          .take(5);
        const isDraftsFolder = folder === "drafts";
        let primary = null;
        if (isDraftsFolder) {
          primary = emailsDesc.find((e) => e.isDraft) ?? null;
        } else {
          // Prefer the most recent non-self message for the row preview so
          // inbox cards don't read "From: yourself"; fall back to the latest
          // message if every message in the thread came from the user.
          primary =
            emailsDesc.find((e) => !isSelfAddress(allAccountEmails, e.fromAddress)) ??
            emailsDesc[0] ??
            null;
        }
        const comments = await ctx.db
          .query("threadComments")
          .withIndex("by_thread", (q) => q.eq("threadId", t._id))
          .take(15);
        const hasDraft = isDraftsFolder
          ? true
          : emailsDesc.some((e) => e.isDraft);

        let classification = null;
        if (primary) {
          const c = await ctx.db
            .query("emailClassifications")
            .withIndex("by_email", (q) => q.eq("emailId", primary._id))
            .unique();
          if (c) {
            classification = {
              category: c.category,
              confidence: c.confidence,
              urgency: c.urgency,
              summary: c.summary,
            };
          }
        }

        return {
          ...t,
          id: t._id,
          emails: primary
            ? [
                {
                  fromAddress: primary.fromAddress,
                  fromName: primary.fromName,
                  snippet: primary.snippet,
                  receivedAt: primary.receivedAt,
                  classification,
                },
              ]
            : [],
          _count: { comments: comments.length },
          hasDraft,
        };
      }),
    );

    return {
      data,
      total,
      page: pageNum,
      limit: limitNum,
      hasMore: skip + limitNum < total,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// get — single thread with all emails + comments + access
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");

    if (!(await userOwnsThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }

    // Cap how many emails we hydrate. Long marketing threads with image-embedded
    // bodies (20+ messages, 80–500 KB each) easily push past Convex's 16 MiB
    // read limit. UI shows the most recent K by default — Gmail/Spark style.
    const MAX_HYDRATED = 25;
    const allEmails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .order("asc")
      .collect();
    const totalCount = allEmails.length;
    const emails =
      totalCount > MAX_HYDRATED
        ? allEmails.slice(totalCount - MAX_HYDRATED)
        : allEmails;
    const olderHidden = totalCount - emails.length;

    // Even within the kept tail, a single email can be huge (base64-inlined
    // image, kitchen-sink HTML signature). Strip bodies on any single message
    // > 1 MB, but keep the latest 3 untouched so reply context never breaks.
    const PER_EMAIL_MAX = 1 * 1024 * 1024;
    const KEEP_FULL_NEWEST = 3;
    for (let i = 0; i < emails.length; i++) {
      const allowFull = i >= emails.length - KEEP_FULL_NEWEST;
      const bytes = (emails[i].bodyHtml?.length ?? 0) + (emails[i].bodyText?.length ?? 0);
      if (!allowFull && bytes > PER_EMAIL_MAX) {
        const stripped = emails[i] as Record<string, unknown>;
        stripped.bodyHtml = undefined;
        stripped.bodyText = undefined;
        (stripped as { bodyTruncated?: boolean }).bodyTruncated = true;
      }
    }

    const emailsHydrated = await Promise.all(
      emails.map(async (e) => {
        // Bodies live in a sibling table so list/scan reads stay tiny. We pull
        // them here, alongside attachments + classification. If a row exists
        // both on the legacy `emails.bodyHtml` *and* the new `emailBodies`
        // table during the migration, prefer the sibling row.
        const [attachmentRows, body, cls] = await Promise.all([
          ctx.db
            .query("attachments")
            .withIndex("by_email", (q) => q.eq("emailId", e._id))
            .collect(),
          ctx.db
            .query("emailBodies")
            .withIndex("by_email", (q) => q.eq("emailId", e._id))
            .unique(),
          ctx.db
            .query("emailClassifications")
            .withIndex("by_email", (q) => q.eq("emailId", e._id))
            .unique(),
        ]);
        const attachments = await Promise.all(
          attachmentRows.map(async (a) => ({
            ...a,
            url: a.storageId ? await ctx.storage.getUrl(a.storageId) : null,
          })),
        );
        // Strip the raw bodyHtml/bodyText — those can each be MBs, and on
        // heavy threads (15+ marketing-style emails) reading them all in one
        // query trips Convex's 16 MiB byte cap, leaving the viewer stuck on
        // the spinner. The viewer renders from bodyHtmlClean/bodyHtmlTrimmed
        // (small, sanitized) by default. The View-history fallback that
        // wanted raw bodyHtml is now serviced by `emails.getRawBody` per
        // email on demand.
        const { bodyHtml: _rawHtml, bodyText: _rawText, ...rest } = e;
        // Prefer the preprocessed copies. Fall back to raw bodyHtml only
        // when preprocess has nothing to show; cap the fallback so a single
        // huge raw body can't blow the response budget.
        const RAW_FALLBACK_CAP = 200_000;
        const cleanFromBody = body?.bodyHtmlClean ?? e.bodyHtmlClean;
        const trimmedFromBody = body?.bodyHtmlTrimmed ?? e.bodyHtmlTrimmed;
        const rawHtml = body?.bodyHtml ?? e.bodyHtml;
        const fallbackHtml =
          !cleanFromBody && rawHtml && rawHtml.length <= RAW_FALLBACK_CAP
            ? rawHtml
            : undefined;
        const fallbackText =
          !cleanFromBody && !rawHtml ? body?.bodyText ?? e.bodyText : undefined;
        return {
          ...rest,
          // Ship the raw body only when there's nothing better. This keeps the
          // response small for the common case (preprocessed) but doesn't
          // strand users on edge-case rows that never got reprocessed.
          bodyHtml: fallbackHtml,
          bodyText: fallbackText,
          bodyHtmlClean: cleanFromBody,
          bodyHtmlTrimmed: trimmedFromBody,
          hasQuotedHistory:
            body?.hasQuotedHistory ?? e.hasQuotedHistory ?? false,
          isForwarded: body?.isForwarded ?? e.isForwarded ?? false,
          id: e._id,
          toAddresses: normalizeAddressList(e.toAddresses),
          ccAddresses: normalizeAddressList(e.ccAddresses),
          bccAddresses: normalizeAddressList(e.bccAddresses),
          attachments: attachments.map((a) => ({ ...a, id: a._id })),
          classification: cls
            ? {
                category: cls.category,
                confidence: cls.confidence,
                urgency: cls.urgency,
                summary: cls.summary,
              }
            : null,
        };
      }),
    );

    // Expose how many older messages we omitted so the UI can offer a
    // "Load older messages" affordance later. For now the viewer just
    // renders what it gets.
    const _olderHiddenForClient = olderHidden;

    const comments = await ctx.db
      .query("threadComments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("asc")
      .collect();

    const commentsHydrated = await Promise.all(
      comments.map(async (c) => {
        const mentions = await ctx.db
          .query("threadMentions")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId))
          .collect();
        const myMentions = mentions.filter((m) => m.commentId === c._id);
        const reactions = await ctx.db
          .query("commentReactions")
          .withIndex("by_comment", (q) => q.eq("commentId", c._id))
          .collect();
        return {
          ...c,
          id: c._id,
          author: {
            id: c.authorId,
            name: c.authorName,
            avatarUrl: c.authorAvatarUrl,
          },
          mentions: myMentions,
          reactions,
        };
      }),
    );

    const access = await ctx.db
      .query("threadAccess")
      .withIndex("by_thread_user", (q) => q.eq("threadId", threadId))
      .collect();

    return {
      data: {
        ...thread,
        id: thread._id,
        emails: emailsHydrated,
        comments: commentsHydrated,
        access,
        olderHiddenCount: _olderHiddenForClient,
        totalMessageCount: totalCount,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// markRead (used by frontend explicitly; `get` also marks read in source —
// we expose this as a mutation to keep `get` a pure query).
// ─────────────────────────────────────────────────────────────────────────────

export const markRead = mutation({
  args: { threadId: v.id("threads"), isRead: v.optional(v.boolean()) },
  handler: async (ctx, { threadId, isRead }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }
    const newIsRead = isRead ?? true;
    await ctx.db.patch(threadId, {
      isRead: newIsRead,
      readStateLocalAt: Date.now(),
    });
    await scheduleProviderReadStatePush(ctx, thread.accountId, thread.providerThreadId, newIsRead);
    return { ok: true };
  },
});

// Helper: schedule the appropriate provider action to mirror our local
// read-state change. If the user owns multiple accounts on different
// providers, only the thread's own account is touched.
async function scheduleProviderReadStatePush(
  ctx: { db: any; scheduler: any },
  accountId: Id<"mailAccounts">,
  providerThreadId: string,
  isRead: boolean,
): Promise<void> {
  const account = await ctx.db.get(accountId);
  if (!account) return;
  const provider = (account as Doc<"mailAccounts">).provider;
  if (provider === "GMAIL") {
    await ctx.scheduler.runAfter(0, internal.sync.gmail._pushThreadReadState, {
      accountId,
      providerThreadId,
      isRead,
    });
  } else if (provider === "MICROSOFT") {
    await ctx.scheduler.runAfter(0, internal.sync.microsoft._pushThreadReadState, {
      accountId,
      providerThreadId,
      isRead,
    });
  }
}

// Generic update — used for star/archive/trash/labels (mirror PATCH /api/threads/:id)
export const update = mutation({
  args: {
    threadId: v.id("threads"),
    isRead: v.optional(v.boolean()),
    isStarred: v.optional(v.boolean()),
    isArchived: v.optional(v.boolean()),
    isTrashed: v.optional(v.boolean()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const { threadId, ...rest } = args;
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }
    const patch: Record<string, unknown> = {};
    if (rest.isRead !== undefined) {
      patch.isRead = rest.isRead;
      patch.readStateLocalAt = Date.now();
    }
    if (rest.isStarred !== undefined) patch.isStarred = rest.isStarred;
    if (rest.isArchived !== undefined) {
      patch.isArchived = rest.isArchived;
      if (rest.labels === undefined) {
        patch.labels = rest.isArchived
          ? thread.labels.filter((label) => label !== "INBOX")
          : Array.from(new Set([...thread.labels, "INBOX"]));
      }
    }
    if (rest.isTrashed !== undefined) patch.isTrashed = rest.isTrashed;
    if (rest.labels !== undefined) patch.labels = rest.labels;
    await ctx.db.patch(threadId, patch);
    // Archiving or trashing resolves any open "Needs Response" signal on
    // this thread — the user has decided they don't owe a reply.
    if (rest.isArchived === true || rest.isTrashed === true) {
      await ctx.scheduler.runAfter(
        0,
        internal.ai.needsResponseData._dismissOpenSignalsForThread,
        { threadId, kind: "archived" },
      );
    }
    if (rest.isRead !== undefined) {
      await scheduleProviderReadStatePush(
        ctx,
        thread.accountId,
        thread.providerThreadId,
        rest.isRead,
      );
    }
    const updated = await ctx.db.get(threadId);
    return { data: updated };
  },
});

export const markStarred = mutation({
  args: { threadId: v.id("threads"), isStarred: v.boolean() },
  handler: async (ctx, { threadId, isStarred }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }
    await ctx.db.patch(threadId, { isStarred });
    return { ok: true };
  },
});

export const markArchived = mutation({
  args: { threadId: v.id("threads"), isArchived: v.boolean() },
  handler: async (ctx, { threadId, isArchived }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }
    const labels = isArchived
      ? thread.labels.filter((label) => label !== "INBOX")
      : Array.from(new Set([...thread.labels, "INBOX"]));
    await ctx.db.patch(threadId, { isArchived, labels });
    if (isArchived) {
      await ctx.scheduler.runAfter(
        0,
        internal.ai.needsResponseData._dismissOpenSignalsForThread,
        { threadId, kind: "archived" },
      );
    }
    return { ok: true };
  },
});

export const updateLabels = mutation({
  args: { threadId: v.id("threads"), labels: v.array(v.string()) },
  handler: async (ctx, { threadId, labels }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    if (!(await userOwnsThread(ctx, userId, thread))) {
      throw new Error("Access denied");
    }
    await ctx.db.patch(threadId, { labels });
    return { ok: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Snooze / Unsnooze — uses scheduler.runAt + internal unsnooze mutation
// ─────────────────────────────────────────────────────────────────────────────

export const snooze = mutation({
  args: { threadId: v.id("threads"), snoozedUntil: v.number() },
  handler: async (ctx, { threadId, snoozedUntil }) => {
    const userId = await requireUser(ctx);
    if (!Number.isFinite(snoozedUntil) || snoozedUntil <= Date.now()) {
      throw new Error("snoozedUntil must be a future timestamp (ms)");
    }
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");

    const account = await ctx.db.get(thread.accountId);
    if (!account || (account as Doc<"mailAccounts">).userId !== userId) {
      throw new Error("Access denied");
    }
    await ctx.db.patch(threadId, { snoozedUntil });
    await ctx.scheduler.runAt(snoozedUntil, internal.threads.unsnooze, {
      threadId,
    });
    return { ok: true };
  },
});

export const unsnoozeNow = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    const account = await ctx.db.get(thread.accountId);
    if (!account || (account as Doc<"mailAccounts">).userId !== userId) {
      throw new Error("Access denied");
    }
    await ctx.db.patch(threadId, { snoozedUntil: undefined });
    return { ok: true };
  },
});

// Internal: scheduler-invoked unsnooze (no auth — runs as system).
export const unsnooze = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return;
    // Only clear if still snoozed (idempotent — user may have unsnoozed already).
    if (thread.snoozedUntil && thread.snoozedUntil <= Date.now()) {
      await ctx.db.patch(threadId, { snoozedUntil: undefined });
    }
  },
});

// Count of unread inbox threads, capped at 100 so the badge query is cheap
// no matter the mailbox size. Bell UI shows "99+" past that.
export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const MAX_BADGE = 100;
    const accts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let total = 0;
    for (const a of accts) {
      // Walk recent threads per account; stop as soon as we hit MAX_BADGE.
      const remaining = MAX_BADGE - total;
      if (remaining <= 0) break;
      const recent = await ctx.db
        .query("threads")
        .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", a._id))
        .order("desc")
        .take(remaining * 3); // small over-fetch so unread density doesn't starve
      for (const t of recent) {
        if (
          !t.isRead &&
          !t.isTrashed &&
          !t.isArchived &&
          !t.snoozedUntil &&
          !t.labels.includes("SPAM") &&
          t.lastReceivedAt !== undefined
        ) {
          total++;
          if (total >= MAX_BADGE) break;
        }
      }
    }
    return { count: total };
  },
});

