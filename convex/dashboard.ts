import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard queries — ported from packages/backend/src/routes/dashboard
// and packages/backend/src/services/dashboard/metrics.ts.
//
// Per Phase 3 audit, the source pending-comments OR query is split into
// two indexed queries merged in JS — Convex does not support OR across
// indexes in a single query.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** GET /api/dashboard/metrics */
export const metrics = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);

    const accounts = (
      await ctx.db
        .query("mailAccounts")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).map((a) => ({ id: a._id, email: a.email.toLowerCase() }));

    if (accounts.length === 0) {
      return { averageMinutes: 0, medianMinutes: 0, totalReplies: 0 };
    }

    const userEmails = new Set(accounts.map((a) => a.email));
    const accountIds = accounts.map((a) => a.id);

    // Fetch tracking exclusions (one per user).
    const exclusions = await ctx.db
      .query("trackingExclusions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const excludedSet = new Set(
      exclusions.map((e) => e.emailAddress.toLowerCase()),
    );

    // Pull non-archived/non-trashed threads per account, then gather emails.
    const deltas: number[] = [];

    for (const accountId of accountIds) {
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_account_isArchived_isTrashed", (q) =>
          q.eq("accountId", accountId).eq("isArchived", false).eq("isTrashed", false),
        )
        .collect();

      for (const thread of threads) {
        const emails = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) =>
            q.eq("threadId", thread._id),
          )
          .order("asc")
          .collect();

        for (let i = 0; i < emails.length - 1; i++) {
          const incoming = emails[i];
          const next = emails[i + 1];
          if (excludedSet.has(incoming.fromAddress.toLowerCase())) continue;

          const isIncoming = !userEmails.has(incoming.fromAddress.toLowerCase());
          const isReply = userEmails.has(next.fromAddress.toLowerCase());

          if (isIncoming && isReply) {
            const deltaMs = next.receivedAt - incoming.receivedAt;
            if (deltaMs > 0) deltas.push(deltaMs / MINUTE_MS);
          }
        }
      }
    }

    if (deltas.length === 0) {
      return { averageMinutes: 0, medianMinutes: 0, totalReplies: 0 };
    }

    const sorted = [...deltas].sort((a, b) => a - b);
    const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const median = sorted[Math.floor(sorted.length / 2)];

    return {
      averageMinutes: Math.round(avg),
      medianMinutes: Math.round(median),
      totalReplies: deltas.length,
    };
  },
});

/** GET /api/dashboard/needs-reply — top 10 contacts waiting for a reply */
export const needsReply = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);

    const accounts = (
      await ctx.db
        .query("mailAccounts")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).map((a) => ({ id: a._id, email: a.email.toLowerCase() }));

    if (accounts.length === 0) return [];

    const userEmails = new Set(accounts.map((a) => a.email));
    const accountIds = accounts.map((a) => a.id);

    const exclusions = await ctx.db
      .query("trackingExclusions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const excludedSet = new Set(
      exclusions.map((e) => e.emailAddress.toLowerCase()),
    );

    const now = Date.now();
    const out: {
      contactEmail: string;
      contactName: string | null;
      threadId: string;
      threadSubject: string;
      waitingHours: number;
      lastMessageAt: number;
    }[] = [];

    for (const accountId of accountIds) {
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_account_isArchived_isTrashed", (q) =>
          q.eq("accountId", accountId).eq("isArchived", false).eq("isTrashed", false),
        )
        .collect();

      // Sort by lastMessageAt desc to roughly mirror Prisma orderBy.
      threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

      for (const thread of threads) {
        const lastEmail = await ctx.db
          .query("emails")
          .withIndex("by_thread_receivedAt", (q) =>
            q.eq("threadId", thread._id),
          )
          .order("desc")
          .first();

        if (!lastEmail) continue;
        if (userEmails.has(lastEmail.fromAddress.toLowerCase())) continue;
        if (excludedSet.has(lastEmail.fromAddress.toLowerCase())) continue;

        const waitingMs = now - lastEmail.receivedAt;
        out.push({
          contactEmail: lastEmail.fromAddress,
          contactName: lastEmail.fromName ?? null,
          threadId: thread._id,
          threadSubject: thread.subject,
          waitingHours: Math.round(waitingMs / HOUR_MS),
          lastMessageAt: lastEmail.receivedAt,
        });
      }
    }

    out.sort((a, b) => b.waitingHours - a.waitingHours);
    return out.slice(0, 10);
  },
});

/**
 * GET /api/dashboard/tasks — task list with status filter.
 * Mirrors `tasks.list` but kept here too because the dashboard surface
 * uses this URL. Implemented as a thin re-query.
 */
export const taskList = query({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
  },
  handler: async (ctx, { status = "open", limit = 50, page = 1 }) => {
    const userId = await requireUser(ctx);
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    let rows = (await ctx.db.query("tasks").collect()).filter(
      (t) => t.userId === userId,
    );

    if (status === "open") rows = rows.filter((t) => t.status === "OPEN");
    else if (status === "done")
      rows = rows.filter(
        (t) => t.status === "DONE" || t.status === "AUTO_RESOLVED",
      );

    rows.sort((a, b) => {
      if (a.status !== b.status) return a.status < b.status ? -1 : 1;
      const aDeadline = a.deadline ?? Number.POSITIVE_INFINITY;
      const bDeadline = b.deadline ?? Number.POSITIVE_INFINITY;
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      return b._creationTime - a._creationTime;
    });

    const total = rows.length;
    const slice = rows.slice(skip, skip + take);
    const threadIds = Array.from(new Set(slice.map((t) => t.threadId)));
    const threads = await Promise.all(threadIds.map((id) => ctx.db.get(id)));
    const threadMap = new Map(
      threads
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => [t._id, { subject: t.subject }]),
    );

    return {
      data: slice.map((t) => ({
        ...t,
        thread: threadMap.get(t.threadId) ?? null,
      })),
      total,
      hasMore: skip + take < total,
    };
  },
});

/**
 * GET /api/dashboard/pending-comments
 *
 * Source SQL:
 *   isResolved = false AND authorId != me AND
 *   (thread.accountId IN myAccounts  OR  mentions.mentionedUserId = me)
 *
 * Convex split per migration audit:
 *   1) `threadMentions.by_user` → comment ids where I'm mentioned
 *   2) For each account I own: scan threads → comments on those threads
 *   3) Merge & dedupe by comment id, drop my own + resolved.
 */
export const pendingComments = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);

    // (a) Comments where I'm mentioned.
    const myMentions = await ctx.db
      .query("threadMentions")
      .withIndex("by_user", (q) => q.eq("mentionedUserId", userId))
      .collect();
    const mentionCommentIds = new Set(myMentions.map((m) => m.commentId));

    // (b) Comments on threads owned by my accounts.
    const myAccounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const myAccountIds = new Set(myAccounts.map((a) => a._id));

    // Fetch unresolved comments and filter — schema has no isResolved index,
    // so we collect and filter in JS (small N — only unresolved comments).
    const allComments = await ctx.db.query("threadComments").collect();
    const unresolved = allComments.filter(
      (c) => !c.isResolved && c.authorId !== userId,
    );

    const matched: typeof unresolved = [];
    const seen = new Set<string>();
    for (const c of unresolved) {
      if (seen.has(c._id)) continue;
      let isMatch = mentionCommentIds.has(c._id);
      if (!isMatch) {
        const thread = await ctx.db.get(c.threadId);
        if (thread && myAccountIds.has(thread.accountId)) {
          isMatch = true;
        }
      }
      if (isMatch) {
        matched.push(c);
        seen.add(c._id);
      }
    }

    matched.sort((a, b) => b._creationTime - a._creationTime);
    const top = matched.slice(0, 20);

    // Hydrate author + thread (matches Prisma include shape).
    const result = await Promise.all(
      top.map(async (c) => {
        const author = await ctx.db.get(c.authorId);
        const thread = await ctx.db.get(c.threadId);
        return {
          ...c,
          author: author
            ? {
                id: author._id,
                name: author.name ?? null,
                avatarUrl: author.avatarUrl ?? null,
              }
            : null,
          thread: thread
            ? { id: thread._id, subject: thread.subject }
            : null,
        };
      }),
    );

    return result;
  },
});

/** GET /api/dashboard/activity — last sent + received emails + resolved tasks */
export const activity = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);

    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const accountIds = accounts.map((a) => a._id);
    const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

    // Recent emails per account (use receivedAt index, then split sent vs recv).
    const recentEmails = (
      await Promise.all(
        accountIds.map((id) =>
          ctx.db
            .query("emails")
            .withIndex("by_account_receivedAt", (q) => q.eq("accountId", id))
            .order("desc")
            .take(20),
        ),
      )
    ).flat();
    recentEmails.sort((a, b) => b.receivedAt - a.receivedAt);

    const sentEmails = recentEmails
      .filter((e) => userEmails.has(e.fromAddress.toLowerCase()))
      .slice(0, 10);
    const receivedEmails = recentEmails
      .filter((e) => !userEmails.has(e.fromAddress.toLowerCase()))
      .slice(0, 5);

    // Recently resolved tasks
    const tasksAll = (await ctx.db.query("tasks").collect()).filter(
      (t) =>
        t.userId === userId &&
        (t.status === "DONE" || t.status === "AUTO_RESOLVED") &&
        t.resolvedAt !== undefined,
    );
    tasksAll.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    const resolvedTasks = tasksAll.slice(0, 5);

    type ThreadId = (typeof sentEmails)[number]["threadId"];
    const threadIdSet = new Set<ThreadId>();
    for (const e of sentEmails) threadIdSet.add(e.threadId);
    for (const e of receivedEmails) threadIdSet.add(e.threadId);
    for (const t of resolvedTasks) threadIdSet.add(t.threadId);
    const threadDocs = await Promise.all(
      Array.from(threadIdSet).map((id) => ctx.db.get(id)),
    );
    const threadMap = new Map(
      threadDocs
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => [t._id as ThreadId, t]),
    );

    type ActivityItem = {
      id: string;
      type: "sent" | "received" | "resolved";
      subject: string;
      contactName: string | null;
      contactEmail: string;
      threadId: string;
      timestamp: number;
    };

    const items: ActivityItem[] = [
      ...sentEmails.map((e): ActivityItem => {
        const to = Array.isArray(e.toAddresses)
          ? (e.toAddresses[0] as { email?: string; name?: string } | undefined)
          : null;
        const thread = threadMap.get(e.threadId);
        return {
          id: `sent-${e._id}`,
          type: "sent",
          subject: thread?.subject ?? e.subject,
          contactName: to?.name ?? null,
          contactEmail: to?.email ?? "",
          threadId: e.threadId,
          timestamp: e.receivedAt,
        };
      }),
      ...receivedEmails.map((e): ActivityItem => {
        const thread = threadMap.get(e.threadId);
        return {
          id: `recv-${e._id}`,
          type: "received",
          subject: thread?.subject ?? e.subject,
          contactName: e.fromName ?? null,
          contactEmail: e.fromAddress,
          threadId: e.threadId,
          timestamp: e.receivedAt,
        };
      }),
      ...resolvedTasks.map((t): ActivityItem => {
        const thread = threadMap.get(t.threadId);
        return {
          id: `task-${t._id}`,
          type: "resolved",
          subject: thread?.subject ?? "",
          contactName: t.contactName ?? null,
          contactEmail: t.contactEmail ?? "",
          threadId: t.threadId,
          timestamp: t.resolvedAt ?? t._creationTime,
        };
      }),
    ];

    items.sort((a, b) => b.timestamp - a.timestamp);
    return items.slice(0, 15);
  },
});
