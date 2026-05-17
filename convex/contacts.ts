// ─────────────────────────────────────────────────────────────────────────────
// contacts.ts — port of routes/contacts.
//
// Public:
//   - list({ q, page, limit }) — search by name/email/company, exclude self.
//   - get({ id })
//   - update({ id, ... }) — manual edits clear isAutoLearned.
//   - threadsForContact({ id }) — recent threads where this contact is a
//     participant (across all the user's mail accounts).
//   - autocomplete({ q })
//   - nameMap() — { lowercaseEmail: displayName } (prefers Person displayName).
//
// Internal:
//   - upsertFromEmail({ userId, email, name, ... }) — called by sync workers
//     to auto-learn contacts and link them to a Person.
//
// AI-driven enrichment (Anthropic) is NOT ported here; that's owned by Agent C.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { assignOrCreatePerson } from "./lib/personMerge";
import {
  extractNameFromBody,
  looksLikeEmailLocalPart,
} from "./lib/nameExtraction";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getUserOwnEmails(
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
      .map((a: Doc<"mailAccounts">) => a.email.toLowerCase())
      .filter(Boolean),
  };
}

function ciIncludes(haystack: string | undefined | null, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Public queries / mutations
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    q: v.optional(v.string()),
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const limitNum = Math.min(args.limit ?? 50, 200);
    const pageNum = Math.max(args.page ?? 1, 1);
    const skip = (pageNum - 1) * limitNum;
    const term = (args.q ?? "").trim();

    const { emails: userEmails } = await getUserOwnEmails(ctx, userId);
    const userEmailSet = new Set(userEmails);

    const all = await ctx.db
      .query("contacts")
      .withIndex("by_user_lastEmailed", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    const filtered = all.filter((c) => {
      if (userEmailSet.has(c.email.toLowerCase())) return false;
      if (!term) return true;
      return (
        ciIncludes(c.name, term) ||
        ciIncludes(c.email, term) ||
        ciIncludes(c.company, term)
      );
    });

    const total = filtered.length;
    const data = filtered.slice(skip, skip + limitNum);
    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  },
});

export const get = query({
  args: { id: v.id("contacts") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const contact = await ctx.db.get(id);
    if (!contact || contact.userId !== userId) {
      throw new Error("Contact not found");
    }
    return contact;
  },
});

export const update = mutation({
  args: {
    id: v.id("contacts"),
    name: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.union(v.string(), v.null())),
    phone: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const contact = await ctx.db.get(args.id);
    if (!contact || contact.userId !== userId) {
      throw new Error("Contact not found");
    }
    const updates: Partial<Doc<"contacts">> = {};
    if (args.name !== undefined) updates.name = args.name ?? undefined;
    if (args.company !== undefined) updates.company = args.company ?? undefined;
    if (args.title !== undefined) updates.title = args.title ?? undefined;
    if (args.phone !== undefined) updates.phone = args.phone ?? undefined;
    if (args.notes !== undefined) updates.notes = args.notes ?? undefined;

    if (Object.keys(updates).length > 0) {
      updates.isAutoLearned = false; // user has manually edited
    }
    await ctx.db.patch(args.id, updates);
    return await ctx.db.get(args.id);
  },
});

/**
 * GET /api/contacts/:id/threads — recent threads containing this contact's
 * email in `participantEmails`, across the user's accounts.
 */
export const threadsForContact = query({
  args: { id: v.id("contacts"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const contact = await ctx.db.get(args.id);
    if (!contact || contact.userId !== userId) {
      throw new Error("Contact not found");
    }
    const cap = Math.min(args.limit ?? 50, 100);
    const { ids: accountIds } = await getUserOwnEmails(ctx, userId);
    if (accountIds.length === 0) return [];

    // Per-account fan-out then filter in memory (Convex has no array-contains
    // index on `participantEmails`).
    const target = contact.email.toLowerCase();
    const fanOut = await Promise.all(
      accountIds.map((aid) =>
        ctx.db
          .query("threads")
          .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", aid))
          .order("desc")
          .take(500),
      ),
    );
    const all = fanOut.flat();
    const matching = all.filter((t) =>
      t.participantEmails.some((e) => e.toLowerCase() === target),
    );
    matching.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return matching.slice(0, cap);
  },
});

export const autocomplete = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const userId = await requireUser(ctx);
    const term = q.trim();
    if (!term) return [];

    const all = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q2) => q2.eq("userId", userId))
      .collect();

    const matching = all.filter(
      (c) =>
        ciIncludes(c.name, term) ||
        ciIncludes(c.email, term) ||
        ciIncludes(c.company, term),
    );
    matching.sort((a, b) => b.emailCount - a.emailCount);
    return matching.slice(0, 10).map((c) => ({
      id: c._id,
      email: c.email,
      name: c.name ?? null,
      company: c.company ?? null,
      title: c.title ?? null,
    }));
  },
});

/**
 * Returns [lowercaseEmail, displayName] pairs for all the user's contacts that
 * have a name. Person displayName takes precedence when present. Returned as an
 * array (not an object) because Convex caps object field counts at 1024 and a
 * mailbox can easily exceed that.
 */
export const nameMap = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q) => q.eq("userId", userId))
      .collect();
    const named = contacts.filter((c) => c.name);

    const personIds = [
      ...new Set(named.map((c) => c.personId).filter(Boolean) as Id<"persons">[]),
    ];
    const persons = await Promise.all(personIds.map((id) => ctx.db.get(id)));
    const personMap = new Map<string, string>();
    for (const p of persons) {
      if (p) personMap.set(p._id, p.displayName);
    }

    const out: Array<[string, string]> = [];
    for (const c of named) {
      if (c.personId && personMap.has(c.personId)) {
        out.push([c.email.toLowerCase(), personMap.get(c.personId)!]);
      } else if (c.name) {
        out.push([c.email.toLowerCase(), c.name]);
      }
    }
    return out;
  },
});

/**
 * Reset auto-learned company/title/phone on all auto-learned contacts (to
 * clear noisy old-parser data). The frontend exposes this from settings.
 */
export const resetAuto = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const all = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q) => q.eq("userId", userId))
      .collect();
    let count = 0;
    for (const c of all) {
      if (!c.isAutoLearned) continue;
      await ctx.db.patch(c._id, {
        company: undefined,
        title: undefined,
        phone: undefined,
      });
      count++;
    }
    return { reset: count };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal — called by Gmail/Microsoft sync workers (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a contact from a single email participant, optionally extracting a
 * better name from the message body (sender only). Always ensures the contact
 * is linked to a Person.
 *
 * Caller should pass:
 *   - `email` lowercased+trimmed
 *   - `isSender` true if this participant is the From: address
 *   - `isOutbound` true if the user sent this email (counts toward emailCount)
 *   - `bodyText` if available (used for sender name extraction)
 */
export const upsertFromEmail = internalMutation({
  args: {
    userId: v.id("users"),
    email: v.string(),
    name: v.optional(v.union(v.string(), v.null())),
    isSender: v.boolean(),
    isOutbound: v.boolean(),
    bodyText: v.optional(v.union(v.string(), v.null())),
    receivedAt: v.number(),
    sigCompany: v.optional(v.union(v.string(), v.null())),
    sigTitle: v.optional(v.union(v.string(), v.null())),
    sigPhone: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();
    if (!email || !email.includes("@")) return null;
    if (/noreply|no-reply|donotreply|mailer-daemon|notifications?@|bounce/i.test(email)) {
      return null;
    }

    let participantName = args.name ?? null;
    if (
      args.isSender &&
      (!participantName || looksLikeEmailLocalPart(participantName)) &&
      args.bodyText
    ) {
      const extracted = extractNameFromBody(args.bodyText);
      if (extracted) participantName = extracted;
    }

    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q) =>
        q.eq("userId", args.userId).eq("email", email),
      )
      .unique();

    let contactId: Id<"contacts">;

    if (existing) {
      contactId = existing._id;
      const patch: Partial<Doc<"contacts">> = {};

      if (args.isOutbound) patch.emailCount = existing.emailCount + 1;
      if (!existing.lastEmailed || args.receivedAt > existing.lastEmailed) {
        patch.lastEmailed = args.receivedAt;
      }
      if (!existing.name && participantName) patch.name = participantName;
      if (
        existing.name &&
        existing.isAutoLearned &&
        looksLikeEmailLocalPart(existing.name) &&
        participantName &&
        !looksLikeEmailLocalPart(participantName)
      ) {
        patch.name = participantName;
      }
      if (existing.isAutoLearned && args.isSender) {
        if (!existing.company && args.sigCompany) patch.company = args.sigCompany;
        if (!existing.title && args.sigTitle) patch.title = args.sigTitle;
        if (!existing.phone && args.sigPhone) patch.phone = args.sigPhone;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
    } else {
      contactId = await ctx.db.insert("contacts", {
        userId: args.userId,
        email,
        name: participantName ?? undefined,
        company: args.isSender ? args.sigCompany ?? undefined : undefined,
        title: args.isSender ? args.sigTitle ?? undefined : undefined,
        phone: args.isSender ? args.sigPhone ?? undefined : undefined,
        lastEmailed: args.receivedAt,
        emailCount: args.isOutbound ? 1 : 0,
        isAutoLearned: true,
      });
    }

    try {
      await assignOrCreatePerson(
        ctx,
        args.userId,
        contactId,
        email,
        participantName,
      );
    } catch {
      // Non-critical — backfill can retry.
    }

    return contactId;
  },
});
