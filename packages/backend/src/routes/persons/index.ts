import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { backfillPersons } from '../../services/contacts/person-merge.js';

export default async function personRoutes(app: FastifyInstance) {
  // List persons with search (primary contacts view)
  app.get('/api/persons', { preHandler: [authenticate] }, async (request) => {
    const { q = '', limit = '50', page = '1' } = request.query as Record<string, string>;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const pageNum = parseInt(page, 10) || 1;
    const skip = (pageNum - 1) * limitNum;
    const userId = request.user.userId;

    const where: any = { userId };

    if (q.trim()) {
      where.OR = [
        { displayName: { contains: q.trim(), mode: 'insensitive' } },
        { company: { contains: q.trim(), mode: 'insensitive' } },
        { contacts: { some: { email: { contains: q.trim(), mode: 'insensitive' } } } },
      ];
    }

    const [persons, total] = await Promise.all([
      app.prisma.person.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limitNum,
        include: {
          contacts: {
            select: {
              id: true,
              email: true,
              name: true,
              company: true,
              title: true,
              phone: true,
              emailCount: true,
              lastEmailed: true,
            },
            orderBy: { emailCount: 'desc' },
          },
        },
      }),
      app.prisma.person.count({ where }),
    ]);

    // Compute aggregates
    const data = persons.map((p) => ({
      ...p,
      totalEmailCount: p.contacts.reduce((sum, c) => sum + c.emailCount, 0),
      lastEmailed: p.contacts.reduce((latest: Date | null, c) => {
        if (!c.lastEmailed) return latest;
        if (!latest) return c.lastEmailed;
        return c.lastEmailed > latest ? c.lastEmailed : latest;
      }, null),
      primaryEmail: p.contacts[0]?.email || null,
    }));

    return {
      data,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    };
  });

  // Get a single person with all contacts
  app.get('/api/persons/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const person = await app.prisma.person.findFirst({
      where: { id, userId: request.user.userId },
      include: {
        contacts: {
          orderBy: { emailCount: 'desc' },
        },
      },
    });
    if (!person) return reply.status(404).send({ error: 'Person not found' });
    return { data: person };
  });

  // Get all threads for a person (across ALL their email addresses)
  app.get('/api/persons/:id/threads', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const person = await app.prisma.person.findFirst({
      where: { id, userId: request.user.userId },
      include: { contacts: { select: { email: true } } },
    });
    if (!person) return reply.status(404).send({ error: 'Person not found' });

    const emails = person.contacts.map((c) => c.email);
    if (emails.length === 0) return { data: [] };

    const threads = await app.prisma.thread.findMany({
      where: {
        account: { userId: request.user.userId },
        participantEmails: { hasSome: emails },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      include: {
        emails: {
          orderBy: { receivedAt: 'desc' },
          take: 1,
          select: { fromAddress: true, fromName: true, snippet: true, receivedAt: true },
        },
      },
    });

    return { data: threads };
  });

  // Update a person
  app.patch('/api/persons/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, any>;

    const existing = await app.prisma.person.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!existing) return reply.status(404).send({ error: 'Person not found' });

    const allowed = ['displayName', 'company', 'title', 'phone', 'notes', 'avatarUrl'];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }

    const person = await app.prisma.person.update({
      where: { id },
      data: updates,
      include: { contacts: { orderBy: { emailCount: 'desc' } } },
    });

    return { data: person };
  });

  // Merge multiple persons into one
  app.post('/api/persons/merge', { preHandler: [authenticate] }, async (request, reply) => {
    const { personIds } = request.body as { personIds: string[] };
    if (!personIds || personIds.length < 2) {
      return reply.status(400).send({ error: 'At least 2 person IDs required' });
    }

    const userId = request.user.userId;
    const persons = await app.prisma.person.findMany({
      where: { id: { in: personIds }, userId },
      include: { contacts: { orderBy: { emailCount: 'desc' } } },
    });

    if (persons.length < 2) {
      return reply.status(400).send({ error: 'Could not find at least 2 persons to merge' });
    }

    // Winner: the person with the most total emails
    persons.sort((a, b) => {
      const aTotal = a.contacts.reduce((s, c) => s + c.emailCount, 0);
      const bTotal = b.contacts.reduce((s, c) => s + c.emailCount, 0);
      return bTotal - aTotal;
    });

    const winner = persons[0];
    const losers = persons.slice(1);
    const loserIds = losers.map((p) => p.id);

    // Move all contacts from losers to winner
    await app.prisma.contact.updateMany({
      where: { personId: { in: loserIds } },
      data: { personId: winner.id },
    });

    // Pick best display name from all persons
    const allNames = persons.map((p) => p.displayName).filter(Boolean);
    const bestName = allNames.sort((a, b) => {
      const aWords = a.split(/\s+/).length;
      const bWords = b.split(/\s+/).length;
      if (bWords !== aWords) return bWords - aWords;
      return b.length - a.length;
    })[0] || winner.displayName;

    // Merge company/title/phone from losers if winner doesn't have them
    const mergedCompany = winner.company || losers.find((p) => p.company)?.company || null;
    const mergedTitle = winner.title || losers.find((p) => p.title)?.title || null;
    const mergedPhone = winner.phone || losers.find((p) => p.phone)?.phone || null;

    await app.prisma.person.update({
      where: { id: winner.id },
      data: {
        displayName: bestName,
        company: mergedCompany,
        title: mergedTitle,
        phone: mergedPhone,
      },
    });

    // Delete loser persons
    await app.prisma.person.deleteMany({
      where: { id: { in: loserIds } },
    });

    // Return the merged person
    const merged = await app.prisma.person.findUnique({
      where: { id: winner.id },
      include: { contacts: { orderBy: { emailCount: 'desc' } } },
    });

    return { data: merged };
  });

  // Unlink a contact from a person (creates a new solo person for it)
  app.post('/api/persons/:id/unlink', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { contactId } = request.body as { contactId: string };
    const userId = request.user.userId;

    const person = await app.prisma.person.findFirst({
      where: { id, userId },
      include: { contacts: true },
    });
    if (!person) return reply.status(404).send({ error: 'Person not found' });

    const contact = person.contacts.find((c) => c.id === contactId);
    if (!contact) return reply.status(400).send({ error: 'Contact not in this person' });

    // Create a new person for the unlinked contact
    const newPerson = await app.prisma.person.create({
      data: {
        userId,
        displayName: contact.name || contact.email.split('@')[0],
        company: contact.company,
        title: contact.title,
        phone: contact.phone,
      },
    });

    await app.prisma.contact.update({
      where: { id: contactId },
      data: { personId: newPerson.id },
    });

    return { data: { unlinked: contactId, newPersonId: newPerson.id } };
  });

  // Backfill: create Person records for existing contacts
  app.post('/api/persons/backfill', { preHandler: [authenticate] }, async (request) => {
    const created = await backfillPersons(app.prisma, request.user.userId);
    return { data: { personsCreated: created } };
  });

  // Autocomplete for compose — returns persons with their email addresses
  app.get('/api/persons/autocomplete', { preHandler: [authenticate] }, async (request) => {
    const { q = '' } = request.query as Record<string, string>;
    if (!q.trim()) return { data: [] };

    const persons = await app.prisma.person.findMany({
      where: {
        userId: request.user.userId,
        OR: [
          { displayName: { contains: q.trim(), mode: 'insensitive' } },
          { company: { contains: q.trim(), mode: 'insensitive' } },
          { contacts: { some: { email: { contains: q.trim(), mode: 'insensitive' } } } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: {
        contacts: {
          select: { id: true, email: true, name: true, company: true, title: true, emailCount: true },
          orderBy: { emailCount: 'desc' },
        },
      },
    });

    // Sort by total email count for relevance
    const sorted = persons
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        company: p.company,
        title: p.title,
        contacts: p.contacts,
        totalEmailCount: p.contacts.reduce((sum, c) => sum + c.emailCount, 0),
      }))
      .sort((a, b) => b.totalEmailCount - a.totalEmailCount);

    return { data: sorted };
  });
}
