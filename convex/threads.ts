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
    emails: accounts.map((a: Doc<"mailAccounts">) => a.email).filter(Boolean),
  };
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
    const limitNum = Math.min(args.limit ?? 80, 100);
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

    // Drafts can be selected directly from email metadata. Do this before the
    // generic thread fanout path; otherwise large accounts load every email in
    // hundreds of threads just to discover which threads contain drafts.
    if (folder === "drafts" && !searchTerm && !fromEmail && !args.category) {
      const draftArrays = await Promise.all(
        accountIds.map((aid) =>
          ctx.db
            .query("emails")
            .withIndex("by_account_isDraft_receivedAt", (q) =>
              q.eq("accountId", aid).eq("isDraft", true),
            )
            .order("desc")
            .take(skip + limitNum),
        ),
      );
      const drafts = draftArrays
        .flat()
        .sort((a, b) => b.receivedAt - a.receivedAt);

      const seenThreadIds = new Set<string>();
      const uniqueDrafts = drafts.filter((e) => {
        const key = String(e.threadId);
        if (seenThreadIds.has(key)) return false;
        seenThreadIds.add(key);
        return true;
      });
      const pagedDrafts = uniqueDrafts.slice(skip, skip + limitNum);
      const data = await Promise.all(
        pagedDrafts.map(async (draft) => {
          const thread = await ctx.db.get(draft.threadId);
          if (!thread) return null;
          const comments = await ctx.db
            .query("threadComments")
            .withIndex("by_thread", (q) => q.eq("threadId", draft.threadId))
            .take(50);
          return {
            ...thread,
            id: thread._id,
            emails: [
              {
                fromAddress: draft.fromAddress,
                fromName: draft.fromName,
                snippet: draft.snippet,
                receivedAt: draft.receivedAt,
                classification: null,
              },
            ],
            _count: { comments: comments.length },
            hasDraft: true,
          };
        }),
      );
      const rows = data.filter((row): row is NonNullable<typeof row> => row !== null);
      return {
        data: rows,
        total: uniqueDrafts.length,
        page: pageNum,
        limit: limitNum,
        hasMore: skip + limitNum < uniqueDrafts.length,
      };
    }

    // Pull threads from each account index (fan-out then merge — Convex doesn't support `IN`).
    // Keep thread list queries bounded. Thread-list screens should never fan out
    // through hundreds of full email bodies; detail view loads full threads.
    // Grow the per-account window with the requested page so deep scrolling still
    // surfaces older threads.
    const perAccountLimit = Math.min(
      Math.max(200, skip + limitNum * 2),
      500,
    );
    const threadsArrays = await Promise.all(
      accountIds.map((aid) =>
        ctx.db
          .query("threads")
          .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", aid))
          .order("desc")
          .take(perAccountLimit),
      ),
    );
    let candidates = threadsArrays.flat();

    let isFromFastPath = false;
    let parsed: ParsedSearch | null = null;

    if (fromEmail && fromEmail.length > 0) {
      isFromFastPath = true;
      candidates = candidates.filter((t) => !t.isTrashed);
    } else if (searchTerm && searchTerm.length > 0) {
      parsed = parseSearchOperators(searchTerm);
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

    // Folder/search lookups that need email metadata. Keep this set narrow and
    // bounded; category/tag filtering runs in a separate capped pass below.
    const needsEmails =
      isFromFastPath ||
      (parsed &&
        (parsed.text.length > 0 ||
          parsed.from ||
          parsed.to ||
          parsed.cc ||
          parsed.before !== undefined ||
          parsed.after !== undefined ||
          parsed.hasAttachment)) ||
      folder === "sent";

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

            if (parsed.text.length > 0) {
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
              (e) => allAccountEmails.includes(e.fromAddress) && !e.isDraft,
            );
          }
          if (folder === "drafts") {
            return emails.some((e) => e.isDraft);
          }
          if (!folder || folder === "inbox") {
            // Inbox: must have at least one received (non-self) email.
            const hasReceived = emails.some(
              (e) => !allAccountEmails.includes(e.fromAddress),
            );
            if (!hasReceived) return false;
          }
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
          // Show the latest message in the conversation row, regardless of
          // whether it was inbound or sent by the user. This keeps the inbox
          // preview aligned with the same latest-activity ordering above.
          primary = emailsDesc[0] ?? null;
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

    // Cap how many emails we hydrate. Some marketing threads have 20+
    // messages with 80–500 KB bodies each — reading every body row at once
    // trips Convex's 16 MiB byte cap and leaves the viewer stuck on the
    // spinner. The UI shows the most recent K messages by default, which
    // matches Gmail/Spark's collapsed-history behavior.
    const MAX_HYDRATED = 25;
    const allEmails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .order("asc")
      .collect();
    const totalCount = allEmails.length;
    // Keep the newest K — if the thread is shorter, that's everything.
    const emails =
      totalCount > MAX_HYDRATED
        ? allEmails.slice(totalCount - MAX_HYDRATED)
        : allEmails;
    const olderHidden = totalCount - emails.length;

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
    await ctx.db.patch(threadId, { isRead: isRead ?? true });
    return { ok: true };
  },
});

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
    if (rest.isRead !== undefined) patch.isRead = rest.isRead;
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared threads ("Shared With Me")
// ─────────────────────────────────────────────────────────────────────────────

export const listShared = query({
  args: {
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const pageNum = args.page ?? 1;
    const limitNum = Math.min(args.limit ?? 50, 100);
    const skip = (pageNum - 1) * limitNum;

    const accessRows = await ctx.db
      .query("threadAccess")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const threads = await Promise.all(
      accessRows.map((a) => ctx.db.get(a.threadId)),
    );
    const valid = threads.filter(
      (t): t is Doc<"threads"> => t !== null,
    );
    valid.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const paged = valid.slice(skip, skip + limitNum);

    const data = await Promise.all(
      paged.map(async (t) => {
        const emailsDesc = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
          .order("desc")
          .take(1);
        const comments = await ctx.db
          .query("threadComments")
          .withIndex("by_thread", (q) => q.eq("threadId", t._id))
          .collect();
        return {
          ...t,
          id: t._id,
          emails: emailsDesc.map((e) => ({
            fromAddress: e.fromAddress,
            fromName: e.fromName,
            snippet: e.snippet,
            receivedAt: e.receivedAt,
          })),
          _count: { comments: comments.length },
        };
      }),
    );

    return {
      data,
      total: valid.length,
      page: pageNum,
      limit: limitNum,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────────────────
// Lightweight unread badge count. Bounded by index + filter — we cap the
// scan per account so a power-user mailbox can't blow the read budget. The
// count is "good enough" for a sidebar badge; exact totals come from list.
// ───────────────────────────────────────────────────────────────────────────────────────

const UNREAD_COUNT_MAX_PER_ACCOUNT = 500;

export const unreadCount = query({
  args: { accountId: v.optional(v.id("mailAccounts")) },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const accountIds = accountId
      ? [accountId]
      : await getUserMailAccountIds(ctx, userId);
    if (accountIds.length === 0) return { count: 0 };

    let count = 0;
    let capped = false;
    for (const id of accountIds) {
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_account_isArchived_isTrashed", (q) =>
          q.eq("accountId", id).eq("isArchived", false).eq("isTrashed", false),
        )
        .take(UNREAD_COUNT_MAX_PER_ACCOUNT);
      if (threads.length === UNREAD_COUNT_MAX_PER_ACCOUNT) capped = true;
      for (const t of threads) if (!t.isRead) count += 1;
    }
    return { count, capped };
  },
});
