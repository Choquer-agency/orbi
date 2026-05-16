import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

// Simple in-memory search across threads + emails.
// Trade-off: no full-text index in Convex by default — we scan recent threads/emails
// per account, then filter case-insensitively. Works fine for small/medium mailboxes.
// Phase 6 will revisit if we need a real search index (Convex has a search index API).

function ciIncludes(s: string | undefined | null, q: string): boolean {
  if (!s) return false;
  return s.toLowerCase().includes(q.toLowerCase());
}

export const searchThreads = query({
  args: {
    q: v.string(),
    accountId: v.optional(v.id("mailAccounts")),
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const term = args.q.trim();
    const pageNum = args.page ?? 1;
    const limitNum = Math.min(args.limit ?? 20, 50);
    const skip = (pageNum - 1) * limitNum;

    if (term.length === 0) {
      return {
        data: [],
        total: 0,
        page: pageNum,
        limit: limitNum,
        hasMore: false,
      };
    }

    // Get user's accounts
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const accountIds: Id<"mailAccounts">[] = args.accountId
      ? [args.accountId]
      : accounts.map((a) => a._id);

    if (accountIds.length === 0) {
      return {
        data: [],
        total: 0,
        page: pageNum,
        limit: limitNum,
        hasMore: false,
      };
    }

    // ── Person-aware expansion ─────────────────────────────────────────────
    // If the term matches a Person displayName, expand to all of that person's
    // contact email addresses, so we also match emails sent from those addresses.
    const allPersons = await ctx.db
      .query("persons")
      .withIndex("by_user_displayName", (q) => q.eq("userId", userId))
      .take(500);
    const matchedPersons = allPersons
      .filter((p) => ciIncludes(p.displayName, term))
      .slice(0, 5);
    const personEmails = new Set<string>();
    for (const p of matchedPersons) {
      const contacts = await ctx.db
        .query("contacts")
        .withIndex("by_person", (q) => q.eq("personId", p._id))
        .take(50);
      for (const c of contacts) personEmails.add(c.email.toLowerCase());
    }

    // ── Pull recent emails per account, filter in-memory ──────────────────
    const perAccountLimit = 200;
    const emailsArrays = await Promise.all(
      accountIds.map((aid) =>
        ctx.db
          .query("emails")
          .withIndex("by_account_receivedAt", (q) => q.eq("accountId", aid))
          .order("desc")
          .take(perAccountLimit),
      ),
    );
    const allEmails = emailsArrays.flat();

    const matched = allEmails.filter((e) => {
      if (
        ciIncludes(e.subject, term) ||
        ciIncludes(e.fromAddress, term) ||
        ciIncludes(e.fromName, term) ||
        ciIncludes(e.snippet, term)
      ) {
        return true;
      }
      // Person email expansion: include emails from any of the person's known addresses
      if (personEmails.has((e.fromAddress || "").toLowerCase())) return true;
      return false;
    });

    matched.sort((a, b) => b.receivedAt - a.receivedAt);

    const total = matched.length;
    const paged = matched.slice(skip, skip + limitNum);

    const data = await Promise.all(
      paged.map(async (e) => {
        const thread = (await ctx.db.get(e.threadId)) as Doc<"threads"> | null;
        return {
          id: e._id,
          threadId: e.threadId,
          subject: e.subject,
          fromAddress: e.fromAddress,
          fromName: e.fromName,
          snippet: e.snippet,
          receivedAt: e.receivedAt,
          thread: thread
            ? {
                id: thread._id,
                subject: thread.subject,
                messageCount: thread.messageCount,
              }
            : null,
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
