// ─────────────────────────────────────────────────────────────────────────────
// persons.ts — port of routes/persons.
//
// Person = grouped identity over multiple Contact (email) rows. Sorted by
// `updatedAt desc` (using `by_user_updatedAt`). All mutations refresh
// `updatedAt` so recent activity (merge, edit, unlink, contact link) bubbles.
//
// Merge winner: the person whose linked contacts have the highest summed
// emailCount (preserves source behavior in routes/persons/index.ts:156-160).
// Display name picked across all merged persons by word-count then length.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { backfillPersons, bestDisplayName } from "./lib/personMerge";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getContactsForPerson(
  ctx: { db: any },
  personId: Id<"persons">,
): Promise<Doc<"contacts">[]> {
  const contacts = await ctx.db
    .query("contacts")
    .withIndex("by_person", (q: any) => q.eq("personId", personId))
    .collect();
  contacts.sort(
    (a: Doc<"contacts">, b: Doc<"contacts">) => b.emailCount - a.emailCount,
  );
  return contacts;
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

    // updatedAt desc — required ordering.
    const all = await ctx.db
      .query("persons")
      .withIndex("by_user_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    let candidates = all;
    if (term) {
      const userContacts = await ctx.db
        .query("contacts")
        .withIndex("by_user_email", (q) => q.eq("userId", userId))
        .collect();
      const matchingPersonIds = new Set<Id<"persons">>();
      for (const c of userContacts) {
        if (c.personId && ciIncludes(c.email, term)) {
          matchingPersonIds.add(c.personId);
        }
      }
      candidates = all.filter(
        (p) =>
          ciIncludes(p.displayName, term) ||
          ciIncludes(p.company, term) ||
          matchingPersonIds.has(p._id),
      );
    }

    const total = candidates.length;
    const slice = candidates.slice(skip, skip + limitNum);

    const data = await Promise.all(
      slice.map(async (p) => {
        const contacts = await getContactsForPerson(ctx, p._id);
        const totalEmailCount = contacts.reduce(
          (sum, c) => sum + c.emailCount,
          0,
        );
        const lastEmailed = contacts.reduce<number | null>((latest, c) => {
          if (!c.lastEmailed) return latest;
          if (!latest) return c.lastEmailed;
          return c.lastEmailed > latest ? c.lastEmailed : latest;
        }, null);
        return {
          ...p,
          contacts: contacts.map((c) => ({
            id: c._id,
            email: c.email,
            name: c.name ?? null,
            company: c.company ?? null,
            title: c.title ?? null,
            phone: c.phone ?? null,
            emailCount: c.emailCount,
            lastEmailed: c.lastEmailed ?? null,
          })),
          totalEmailCount,
          lastEmailed,
          primaryEmail: contacts[0]?.email ?? null,
        };
      }),
    );

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
  args: { id: v.id("persons") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const person = await ctx.db.get(id);
    if (!person || person.userId !== userId) {
      throw new Error("Person not found");
    }
    const contacts = await getContactsForPerson(ctx, id);
    return { ...person, contacts };
  },
});

/**
 * GET /api/persons/:id/threads — returns recent threads where ANY of this
 * person's email addresses appears in `participantEmails`.
 */
export const threadsForPerson = query({
  args: { id: v.id("persons"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const person = await ctx.db.get(args.id);
    if (!person || person.userId !== userId) {
      throw new Error("Person not found");
    }
    const cap = Math.min(args.limit ?? 50, 100);
    const contacts = await getContactsForPerson(ctx, args.id);
    const emails = new Set(contacts.map((c) => c.email.toLowerCase()));
    if (emails.size === 0) return [];

    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (accounts.length === 0) return [];

    const fanOut = await Promise.all(
      accounts.map((a) =>
        ctx.db
          .query("threads")
          .withIndex("by_account_lastMessageAt", (q) =>
            q.eq("accountId", a._id),
          )
          .order("desc")
          .take(500),
      ),
    );
    const all = fanOut.flat();
    const matching = all.filter((t) =>
      t.participantEmails.some((e) => emails.has(e.toLowerCase())),
    );
    matching.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return matching.slice(0, cap);
  },
});

export const update = mutation({
  args: {
    id: v.id("persons"),
    displayName: v.optional(v.string()),
    company: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.union(v.string(), v.null())),
    phone: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const person = await ctx.db.get(args.id);
    if (!person || person.userId !== userId) {
      throw new Error("Person not found");
    }
    const patch: Partial<Doc<"persons">> = { updatedAt: Date.now() };
    if (args.displayName !== undefined) patch.displayName = args.displayName;
    if (args.company !== undefined) patch.company = args.company ?? undefined;
    if (args.title !== undefined) patch.title = args.title ?? undefined;
    if (args.phone !== undefined) patch.phone = args.phone ?? undefined;
    if (args.notes !== undefined) patch.notes = args.notes ?? undefined;
    if (args.avatarUrl !== undefined) patch.avatarUrl = args.avatarUrl ?? undefined;
    await ctx.db.patch(args.id, patch);
    const fresh = await ctx.db.get(args.id);
    if (!fresh) return null;
    const contacts = await getContactsForPerson(ctx, args.id);
    return { ...fresh, contacts };
  },
});

/**
 * Merge ≥2 persons into one. Winner = highest summed emailCount across linked
 * contacts. All loser contacts get reassigned to the winner; losers are
 * deleted; winner gets the best displayName / company / title / phone.
 */
export const merge = mutation({
  args: { personIds: v.array(v.id("persons")) },
  handler: async (ctx, { personIds }) => {
    const userId = await requireUser(ctx);
    if (personIds.length < 2) {
      throw new Error("At least 2 person IDs required");
    }

    const persons: Doc<"persons">[] = [];
    for (const id of personIds) {
      const p = await ctx.db.get(id);
      if (p && p.userId === userId) persons.push(p);
    }
    if (persons.length < 2) {
      throw new Error("Could not find at least 2 persons to merge");
    }

    // Compute total emailCount per person to pick the winner.
    const byTotal: { person: Doc<"persons">; total: number }[] = [];
    for (const p of persons) {
      const contacts = await getContactsForPerson(ctx, p._id);
      const total = contacts.reduce((sum, c) => sum + c.emailCount, 0);
      byTotal.push({ person: p, total });
    }
    byTotal.sort((a, b) => b.total - a.total);

    const winner = byTotal[0].person;
    const losers = byTotal.slice(1).map((x) => x.person);
    const loserIds = new Set(losers.map((l) => l._id));

    // Move all loser contacts to the winner.
    for (const loser of losers) {
      const contacts = await getContactsForPerson(ctx, loser._id);
      for (const c of contacts) {
        await ctx.db.patch(c._id, { personId: winner._id });
      }
    }

    // Pick best displayName across all merged persons.
    const allNames = persons.map((p) => p.displayName);
    const bestName = bestDisplayName(allNames) || winner.displayName;
    const mergedCompany =
      winner.company ||
      losers.find((p) => p.company)?.company ||
      undefined;
    const mergedTitle =
      winner.title || losers.find((p) => p.title)?.title || undefined;
    const mergedPhone =
      winner.phone || losers.find((p) => p.phone)?.phone || undefined;

    await ctx.db.patch(winner._id, {
      displayName: bestName,
      company: mergedCompany,
      title: mergedTitle,
      phone: mergedPhone,
      updatedAt: Date.now(),
    });

    for (const id of loserIds) {
      await ctx.db.delete(id);
    }

    const fresh = await ctx.db.get(winner._id);
    if (!fresh) return null;
    const contacts = await getContactsForPerson(ctx, winner._id);
    return { ...fresh, contacts };
  },
});

/**
 * Unlink a single contact from this person. The contact gets a fresh solo
 * Person to call its own.
 */
export const unlink = mutation({
  args: { id: v.id("persons"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const person = await ctx.db.get(args.id);
    if (!person || person.userId !== userId) {
      throw new Error("Person not found");
    }
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.personId !== args.id) {
      throw new Error("Contact not in this person");
    }

    const newPersonId = await ctx.db.insert("persons", {
      userId,
      displayName: contact.name?.trim() || contact.email.split("@")[0] || "Unknown",
      company: contact.company,
      title: contact.title,
      phone: contact.phone,
      updatedAt: Date.now(),
    });

    await ctx.db.patch(args.contactId, { personId: newPersonId });
    await ctx.db.patch(args.id, { updatedAt: Date.now() });

    return { unlinked: args.contactId, newPersonId };
  },
});

export const backfill = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const created = await backfillPersons(ctx, userId);
    return { personsCreated: created };
  },
});

/**
 * Compose autocomplete: returns persons whose displayName / company / contact
 * email matches `q`, with their full email list. Sorted by total emailCount.
 */
export const autocomplete = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const userId = await requireUser(ctx);
    const term = q.trim();
    if (!term) return [];

    // Pull all contacts for this user (used both for matching by email and for
    // building each person's email list).
    const allContacts = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q2) => q2.eq("userId", userId))
      .collect();

    const matchingPersonIds = new Set<Id<"persons">>();
    for (const c of allContacts) {
      if (c.personId && ciIncludes(c.email, term)) {
        matchingPersonIds.add(c.personId);
      }
    }

    const all = await ctx.db
      .query("persons")
      .withIndex("by_user_updatedAt", (q2) => q2.eq("userId", userId))
      .order("desc")
      .collect();

    const matchingPersons = all.filter(
      (p) =>
        ciIncludes(p.displayName, term) ||
        ciIncludes(p.company, term) ||
        matchingPersonIds.has(p._id),
    );

    // Group contacts by personId for fast lookup.
    const contactsByPerson = new Map<Id<"persons">, Doc<"contacts">[]>();
    for (const c of allContacts) {
      if (!c.personId) continue;
      const arr = contactsByPerson.get(c.personId) ?? [];
      arr.push(c);
      contactsByPerson.set(c.personId, arr);
    }

    const enriched = matchingPersons.map((p) => {
      const contacts = (contactsByPerson.get(p._id) ?? []).sort(
        (a, b) => b.emailCount - a.emailCount,
      );
      return {
        type: "person" as const,
        id: p._id,
        name: p.displayName,
        displayName: p.displayName,
        company: p.company ?? null,
        title: p.title ?? null,
        emails: contacts.map((c) => c.email),
        primaryEmail: contacts[0]?.email ?? null,
        contacts: contacts.map((c) => ({
          id: c._id,
          email: c.email,
          name: c.name ?? null,
          company: c.company ?? null,
          title: c.title ?? null,
          emailCount: c.emailCount,
        })),
        totalEmailCount: contacts.reduce((s, c) => s + c.emailCount, 0),
      };
    });

    enriched.sort((a, b) => b.totalEmailCount - a.totalEmailCount);
    return enriched.slice(0, 10);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal — touch updatedAt without going through a public mutation
// ─────────────────────────────────────────────────────────────────────────────

export const touchUpdatedAt = internalMutation({
  args: { id: v.id("persons") },
  handler: async (ctx, { id }) => {
    const p = await ctx.db.get(id);
    if (!p) return;
    await ctx.db.patch(id, { updatedAt: Date.now() });
  },
});
