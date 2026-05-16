// ─────────────────────────────────────────────────────────────────────────────
// lib/personMerge.ts — port of services/contacts/person-merge.ts.
//
// Pure heuristics for matching contacts to a Person (exact name match + email
// local-part similarity across non-generic domains). Convex DB ops are passed
// in via a small `db` interface so the same logic can run from a query (the
// lookup half) or a mutation (the create+link half).
// ─────────────────────────────────────────────────────────────────────────────

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "mail.com", "protonmail.com", "proton.me", "zoho.com",
  "yandex.com", "fastmail.com", "tutanota.com",
]);

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function emailPrefix(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local.replace(/[.\-_+0-9]/g, "").toLowerCase();
}

function emailDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() || "";
}

/**
 * Pick the best display name from a list. Prefers more words, then longest.
 */
function isLikelySharedOrBrandAddress(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() || "";
  return /^(billing|hello|hi|support|contact|info|team|news|newsletter|updates?|marketing|sales|events?|community|noreply|no-reply|donotreply|notifications?)$/.test(local);
}

export function bestDisplayName(names: (string | null | undefined)[]): string {
  const valid = names.filter(
    (n): n is string => !!n && n.trim().length > 0,
  );
  if (valid.length === 0) return "Unknown";
  valid.sort((a, b) => {
    const aWords = a.trim().split(/\s+/).length;
    const bWords = b.trim().split(/\s+/).length;
    if (bWords !== aWords) return bWords - aWords;
    return b.length - a.length;
  });
  return valid[0];
}

/**
 * Find an existing Person whose linked contacts plausibly identify the same
 * human as the given (email, name) pair. Returns the Person doc or null.
 */
export async function findMatchingPerson(
  ctx: MutationCtx,
  userId: Id<"users">,
  contact: { email: string; name?: string | null },
): Promise<Doc<"persons"> | null> {
  // Strategy 1: exact normalized-name match against any other contact already
  // linked to a Person. Do not merge shared/brand/newsletter addresses by
  // display name; many companies send from generic aliases and stale ESP names
  // can otherwise leak across unrelated senders.
  const sharedOrBrand = isLikelySharedOrBrandAddress(contact.email);
  if (!sharedOrBrand && contact.name && contact.name.trim().length > 0) {
    const normalized = normalizeName(contact.name);
    const candidates = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q) => q.eq("userId", userId))
      .collect();
    for (const c of candidates) {
      if (!c.personId) continue;
      if (c.email === contact.email) continue;
      if (c.name && normalizeName(c.name) === normalized) {
        const p = await ctx.db.get(c.personId);
        if (p) return p;
      }
    }
  }

  // Strategy 2: email local-part similarity (≥6 chars) on non-generic domains.
  const prefix = emailPrefix(contact.email);
  const domain = emailDomain(contact.email);
  if (!sharedOrBrand && prefix.length >= 6 && !GENERIC_DOMAINS.has(domain)) {
    const candidates = await ctx.db
      .query("contacts")
      .withIndex("by_user_email", (q) => q.eq("userId", userId))
      .collect();
    for (const c of candidates) {
      if (!c.personId) continue;
      if (c.email === contact.email) continue;
      const otherPrefix = emailPrefix(c.email);
      const otherDomain = emailDomain(c.email);
      if (
        otherPrefix.length >= 6 &&
        !GENERIC_DOMAINS.has(otherDomain) &&
        prefix === otherPrefix
      ) {
        const p = await ctx.db.get(c.personId);
        if (p) return p;
      }
    }
  }
  return null;
}

/**
 * After a Contact is upserted, ensure it's linked to a Person (find an existing
 * one or create new). Returns the personId.
 *
 * Touches `persons.updatedAt` on any mutation so the contacts list (sorted by
 * updatedAt desc) reflects recent activity.
 */
export async function assignOrCreatePerson(
  ctx: MutationCtx,
  userId: Id<"users">,
  contactId: Id<"contacts">,
  contactEmail: string,
  contactName: string | null,
): Promise<Id<"persons">> {
  const contact = await ctx.db.get(contactId);
  if (!contact) throw new Error("Contact not found");
  if (contact.personId) return contact.personId;

  const matchingPerson = await findMatchingPerson(ctx, userId, {
    email: contactEmail,
    name: contactName,
  });

  const now = Date.now();

  if (matchingPerson) {
    await ctx.db.patch(contactId, { personId: matchingPerson._id });

    // Update display name if this contact has a "better" one.
    if (contactName && contactName.trim().length > 0) {
      const linked = await ctx.db
        .query("contacts")
        .withIndex("by_person", (q) => q.eq("personId", matchingPerson._id))
        .collect();
      const best = bestDisplayName(linked.map((c) => c.name));
      const patch: Partial<Doc<"persons">> = { updatedAt: now };
      if (best !== matchingPerson.displayName) patch.displayName = best;
      await ctx.db.patch(matchingPerson._id, patch);
    } else {
      await ctx.db.patch(matchingPerson._id, { updatedAt: now });
    }
    return matchingPerson._id;
  }

  const displayName =
    contactName?.trim() || contactEmail.split("@")[0] || "Unknown";
  const personId = await ctx.db.insert("persons", {
    userId,
    displayName,
    updatedAt: now,
  });
  await ctx.db.patch(contactId, { personId });
  return personId;
}

/**
 * Backfill: ensure every Contact has a personId. Groups orphans by normalized
 * name and creates one Person per group; unnamed orphans get one solo Person
 * each. Returns the number of Person rows created.
 */
export async function backfillPersons(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<number> {
  const all = await ctx.db
    .query("contacts")
    .withIndex("by_user_email", (q) => q.eq("userId", userId))
    .collect();
  const orphans = all.filter((c) => !c.personId);
  if (orphans.length === 0) return 0;

  orphans.sort((a, b) => b.emailCount - a.emailCount);

  const nameGroups = new Map<string, Doc<"contacts">[]>();
  const unnamed: Doc<"contacts">[] = [];

  for (const c of orphans) {
    if (c.name && c.name.trim().length > 0) {
      const key = normalizeName(c.name);
      const arr = nameGroups.get(key) ?? [];
      arr.push(c);
      nameGroups.set(key, arr);
    } else {
      unnamed.push(c);
    }
  }

  const now = Date.now();
  let created = 0;

  for (const [, group] of nameGroups) {
    const displayName = bestDisplayName(group.map((c) => c.name));
    const company = group.find((c) => c.company)?.company;
    const title = group.find((c) => c.title)?.title;
    const phone = group.find((c) => c.phone)?.phone;
    const personId = await ctx.db.insert("persons", {
      userId,
      displayName,
      company,
      title,
      phone,
      updatedAt: now,
    });
    for (const c of group) {
      await ctx.db.patch(c._id, { personId });
    }
    created++;
  }

  for (const c of unnamed) {
    const displayName = c.email.split("@")[0] || "Unknown";
    const personId = await ctx.db.insert("persons", {
      userId,
      displayName,
      company: c.company,
      title: c.title,
      phone: c.phone,
      updatedAt: now,
    });
    await ctx.db.patch(c._id, { personId });
    created++;
  }

  return created;
}
