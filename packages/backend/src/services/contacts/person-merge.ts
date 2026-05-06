import type { PrismaClient, Contact, Person } from '@prisma/client';

// Generic email providers — same local-part across these doesn't imply same person
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'mail.com', 'protonmail.com', 'proton.me', 'zoho.com',
  'yandex.com', 'fastmail.com', 'tutanota.com',
]);

/**
 * Normalize a name for comparison: lowercase, trim, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Extract the local-part prefix from an email (before dots/numbers).
 * e.g., "john.smith123@example.com" → "johnsmith"
 */
function emailPrefix(email: string): string {
  const local = email.split('@')[0];
  return local.replace(/[.\-_+0-9]/g, '').toLowerCase();
}

/**
 * Get the domain from an email address.
 */
function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() || '';
}

/**
 * Find an existing Person that this contact likely belongs to.
 * Returns the person if a high-confidence match is found, null otherwise.
 */
export async function findMatchingPerson(
  prisma: PrismaClient,
  userId: string,
  contact: { email: string; name?: string | null },
): Promise<Person | null> {
  // Strategy 1: Exact name match (highest confidence)
  if (contact.name && contact.name.trim().length > 0) {
    const normalized = normalizeName(contact.name);
    // Find persons for this user where any linked contact has the same normalized name
    const matchingContacts = await prisma.contact.findMany({
      where: {
        userId,
        personId: { not: null },
        email: { not: contact.email },
      },
      select: { name: true, personId: true },
    });

    for (const c of matchingContacts) {
      if (c.name && c.personId && normalizeName(c.name) === normalized) {
        return prisma.person.findUnique({ where: { id: c.personId } });
      }
    }
  }

  // Strategy 2: Email local-part similarity across non-generic domains
  const prefix = emailPrefix(contact.email);
  const domain = emailDomain(contact.email);

  if (prefix.length >= 6 && !GENERIC_DOMAINS.has(domain)) {
    const userContacts = await prisma.contact.findMany({
      where: {
        userId,
        personId: { not: null },
        email: { not: contact.email },
      },
      select: { email: true, personId: true },
    });

    for (const c of userContacts) {
      if (!c.personId) continue;
      const otherPrefix = emailPrefix(c.email);
      const otherDomain = emailDomain(c.email);
      // Both must be non-generic domains and share a 6+ char prefix
      if (
        otherPrefix.length >= 6 &&
        !GENERIC_DOMAINS.has(otherDomain) &&
        prefix === otherPrefix
      ) {
        return prisma.person.findUnique({ where: { id: c.personId } });
      }
    }
  }

  return null;
}

/**
 * Pick the best display name from a list of contact names.
 * Prefers: longest proper name > name with most words > any non-null name.
 */
function bestDisplayName(names: (string | null)[]): string {
  const valid = names.filter((n): n is string => !!n && n.trim().length > 0);
  if (valid.length === 0) return 'Unknown';

  // Sort by word count desc, then length desc
  valid.sort((a, b) => {
    const aWords = a.trim().split(/\s+/).length;
    const bWords = b.trim().split(/\s+/).length;
    if (bWords !== aWords) return bWords - aWords;
    return b.length - a.length;
  });

  return valid[0];
}

/**
 * After a contact is upserted, assign it to an existing Person or create a new one.
 * Returns the personId.
 */
export async function assignOrCreatePerson(
  prisma: PrismaClient,
  userId: string,
  contactId: string,
  contactEmail: string,
  contactName: string | null,
): Promise<string> {
  // Check if already assigned
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { personId: true },
  });

  if (contact?.personId) return contact.personId;

  // Try to find a matching person
  const matchingPerson = await findMatchingPerson(prisma, userId, {
    email: contactEmail,
    name: contactName,
  });

  if (matchingPerson) {
    // Link contact to existing person
    await prisma.contact.update({
      where: { id: contactId },
      data: { personId: matchingPerson.id },
    });

    // Update person's display name if this contact has a better one
    if (contactName && contactName.trim().length > 0) {
      const allContacts = await prisma.contact.findMany({
        where: { personId: matchingPerson.id },
        select: { name: true },
      });
      const best = bestDisplayName(allContacts.map((c) => c.name));
      if (best !== matchingPerson.displayName) {
        await prisma.person.update({
          where: { id: matchingPerson.id },
          data: { displayName: best },
        });
      }
    }

    return matchingPerson.id;
  }

  // Create a new person
  const displayName = contactName?.trim() || contactEmail.split('@')[0];
  const person = await prisma.person.create({
    data: {
      userId,
      displayName,
    },
  });

  await prisma.contact.update({
    where: { id: contactId },
    data: { personId: person.id },
  });

  return person.id;
}

/**
 * Batch backfill: create Person records for all existing contacts that don't have one.
 * Groups contacts by normalized name, creates one Person per group.
 */
export async function backfillPersons(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const orphanContacts = await prisma.contact.findMany({
    where: { userId, personId: null },
    orderBy: { emailCount: 'desc' },
  });

  if (orphanContacts.length === 0) return 0;

  // Group by normalized name
  const nameGroups = new Map<string, Contact[]>();
  const unnamed: Contact[] = [];

  for (const contact of orphanContacts) {
    if (contact.name && contact.name.trim().length > 0) {
      const normalized = normalizeName(contact.name);
      const group = nameGroups.get(normalized) || [];
      group.push(contact);
      nameGroups.set(normalized, group);
    } else {
      unnamed.push(contact);
    }
  }

  let created = 0;

  // Create persons for named groups
  for (const [, contacts] of nameGroups) {
    const displayName = bestDisplayName(contacts.map((c) => c.name));
    // Pick best company/title/phone from the group
    const company = contacts.find((c) => c.company)?.company || null;
    const title = contacts.find((c) => c.title)?.title || null;
    const phone = contacts.find((c) => c.phone)?.phone || null;

    const person = await prisma.person.create({
      data: { userId, displayName, company, title, phone },
    });

    await prisma.contact.updateMany({
      where: { id: { in: contacts.map((c) => c.id) } },
      data: { personId: person.id },
    });

    created++;
  }

  // Create individual persons for unnamed contacts
  for (const contact of unnamed) {
    const displayName = contact.email.split('@')[0];
    const person = await prisma.person.create({
      data: {
        userId,
        displayName,
        company: contact.company,
        title: contact.title,
        phone: contact.phone,
      },
    });

    await prisma.contact.update({
      where: { id: contact.id },
      data: { personId: person.id },
    });

    created++;
  }

  return created;
}
