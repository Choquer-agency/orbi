import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { authenticate } from '../../middleware/authenticate.js';
import { extractAndUpsertContacts } from '../../services/contacts/extract-contacts.js';
import { env } from '../../config/env.js';

export default async function contactRoutes(app: FastifyInstance) {
  // List contacts with search
  app.get('/api/contacts', { preHandler: [authenticate] }, async (request) => {
    const { q = '', limit = '50', page = '1' } = request.query as Record<string, string>;
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const pageNum = parseInt(page, 10) || 1;
    const skip = (pageNum - 1) * limitNum;

    // Exclude the user's own email addresses from the contact list
    const userAccounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: { email: true },
    });
    const userEmails = userAccounts.map((a) => a.email.toLowerCase());

    const where: any = {
      userId: request.user.userId,
      ...(userEmails.length > 0 ? { email: { notIn: userEmails } } : {}),
    };

    if (q.trim()) {
      where.OR = [
        { name: { contains: q.trim(), mode: 'insensitive' } },
        { email: { contains: q.trim(), mode: 'insensitive' } },
        { company: { contains: q.trim(), mode: 'insensitive' } },
      ];
    }

    const [contacts, total] = await Promise.all([
      app.prisma.contact.findMany({
        where,
        orderBy: { lastEmailed: 'desc' },
        skip,
        take: limitNum,
      }),
      app.prisma.contact.count({ where }),
    ]);

    return {
      data: contacts,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    };
  });

  // Get a single contact
  app.get('/api/contacts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contact = await app.prisma.contact.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!contact) return reply.status(404).send({ error: 'Contact not found' });
    return { data: contact };
  });

  // Get all threads for a contact (by email)
  app.get('/api/contacts/:id/threads', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contact = await app.prisma.contact.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!contact) return reply.status(404).send({ error: 'Contact not found' });

    // Find all threads where this contact's email appears in participantEmails
    const threads = await app.prisma.thread.findMany({
      where: {
        account: { userId: request.user.userId },
        participantEmails: { has: contact.email },
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

  // Update a contact (manual edits)
  app.patch('/api/contacts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, any>;

    const existing = await app.prisma.contact.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!existing) return reply.status(404).send({ error: 'Contact not found' });

    const allowed = ['name', 'company', 'title', 'phone', 'notes'];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }
    if (Object.keys(updates).length > 0) {
      updates.isAutoLearned = false; // user has manually edited
    }

    const contact = await app.prisma.contact.update({
      where: { id },
      data: updates,
    });

    return { data: contact };
  });

  // Name map: returns {email: displayName} for all contacts (used for display name resolution)
  app.get('/api/contacts/name-map', { preHandler: [authenticate] }, async (request) => {
    const contacts = await app.prisma.contact.findMany({
      where: {
        userId: request.user.userId,
        name: { not: null },
      },
      select: { email: true, name: true, personId: true },
    });

    // Build map, preferring Person displayName when available
    const personIds = [...new Set(contacts.map((c) => c.personId).filter(Boolean))] as string[];
    const persons = personIds.length > 0
      ? await app.prisma.person.findMany({
          where: { id: { in: personIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const personMap = new Map(persons.map((p) => [p.id, p.displayName]));

    const nameMap: Record<string, string> = {};
    for (const c of contacts) {
      if (c.personId && personMap.has(c.personId)) {
        nameMap[c.email.toLowerCase()] = personMap.get(c.personId)!;
      } else if (c.name) {
        nameMap[c.email.toLowerCase()] = c.name;
      }
    }

    return { data: nameMap };
  });

  // Autocomplete endpoint (lightweight, for compose)
  app.get('/api/contacts/autocomplete', { preHandler: [authenticate] }, async (request) => {
    const { q = '' } = request.query as Record<string, string>;
    if (!q.trim()) return { data: [] };

    const contacts = await app.prisma.contact.findMany({
      where: {
        userId: request.user.userId,
        OR: [
          { name: { contains: q.trim(), mode: 'insensitive' } },
          { email: { contains: q.trim(), mode: 'insensitive' } },
          { company: { contains: q.trim(), mode: 'insensitive' } },
        ],
      },
      orderBy: { emailCount: 'desc' },
      take: 10,
      select: { id: true, email: true, name: true, company: true, title: true },
    });

    return { data: contacts };
  });

  // AI-enrich top N contacts: extract company from email domain + signatures
  app.post('/api/contacts/enrich', { preHandler: [authenticate] }, async (request) => {
    const { limit: limitParam = '25' } = request.body as Record<string, string>;
    const limitNum = Math.min(parseInt(limitParam, 10) || 25, 100);
    const userId = request.user.userId;

    // Get the user's account IDs
    const accounts = await app.prisma.account.findMany({
      where: { userId },
      select: { id: true, email: true },
    });
    const accountIds = accounts.map((a) => a.id);

    // Get top contacts by email count that are missing company
    const contacts = await app.prisma.contact.findMany({
      where: { userId, company: null },
      orderBy: { emailCount: 'desc' },
      take: limitNum,
    });

    if (contacts.length === 0) return { data: { enriched: 0 } };

    // For each contact, get their latest email (sent FROM them) for signature
    const enrichData: { id: string; email: string; name: string | null; signature: string | null }[] = [];

    for (const contact of contacts) {
      const latestEmail = await app.prisma.email.findFirst({
        where: {
          accountId: { in: accountIds },
          fromAddress: { equals: contact.email, mode: 'insensitive' },
        },
        orderBy: { receivedAt: 'desc' },
        select: { bodyText: true },
      });

      // Grab last 15 lines of email body as potential signature
      let signature: string | null = null;
      if (latestEmail?.bodyText) {
        const lines = latestEmail.bodyText.split('\n');
        // Strip quoted content
        const original: string[] = [];
        for (const line of lines) {
          if (/^On .+ wrote:$/i.test(line.trim())) break;
          if (/^>/.test(line.trim())) continue;
          original.push(line);
        }
        signature = original.slice(-15).join('\n').trim() || null;
      }

      enrichData.push({
        id: contact.id,
        email: contact.email,
        name: contact.name,
        signature,
      });
    }

    // Use Claude to extract company names in a single batch call
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    const contactLines = enrichData.map((c, i) => {
      const domain = c.email.split('@')[1] || '';
      return `${i + 1}. Email: ${c.email} | Domain: ${domain} | Name: ${c.name || 'Unknown'}${c.signature ? `\nSignature:\n${c.signature}` : ''}`;
    }).join('\n\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Extract the company name for each contact below. Use these signals:
1. The email domain (e.g. @choquercreative.com → Choquer Creative)
2. The email signature if provided
3. Common knowledge (e.g. @gmail.com, @yahoo.com → no company, return null)

Return ONLY a JSON array of objects: [{"index": 1, "company": "Company Name"}, ...].
For generic email providers (gmail, yahoo, hotmail, outlook, icloud, aol, protonmail, live, msn, me, mail) or if you cannot determine the company, set company to null.
For automated/marketing senders (noreply, notifications, etc.) set company to null.
Capitalize properly (e.g. "Choquer Creative" not "choquercreative").

Contacts:
${contactLines}`,
      }],
    });

    // Parse Claude's response
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    let results: { index: number; company: string | null }[] = [];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) results = JSON.parse(jsonMatch[0]);
    } catch {
      return { data: { enriched: 0, error: 'Failed to parse AI response' } };
    }

    // Update contacts with extracted companies
    let enriched = 0;
    for (const result of results) {
      if (!result.company) continue;
      const contact = enrichData[result.index - 1];
      if (!contact) continue;

      await app.prisma.contact.update({
        where: { id: contact.id },
        data: { company: result.company },
      });
      enriched++;
    }

    return { data: { enriched, total: contacts.length } };
  });

  // Reset auto-learned company/title/phone (clears garbage data from old parser)
  app.post('/api/contacts/reset-auto', { preHandler: [authenticate] }, async (request) => {
    const result = await app.prisma.contact.updateMany({
      where: { userId: request.user.userId, isAutoLearned: true },
      data: { company: null, title: null, phone: null },
    });
    return { data: { reset: result.count } };
  });

  // Backfill contacts from all existing emails in DB
  app.post('/api/contacts/backfill', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.user.userId;

    // Get all user's account emails to skip self
    const accounts = await app.prisma.account.findMany({
      where: { userId },
      select: { id: true, email: true },
    });
    const userEmails = accounts.map((a) => a.email.toLowerCase());
    const accountIds = accounts.map((a) => a.id);

    // Process emails in batches
    const batchSize = 200;
    let processed = 0;
    let offset = 0;

    while (true) {
      const emails = await app.prisma.email.findMany({
        where: { accountId: { in: accountIds } },
        select: {
          fromAddress: true,
          fromName: true,
          toAddresses: true,
          ccAddresses: true,
          bodyText: true,
          receivedAt: true,
        },
        orderBy: { receivedAt: 'desc' },
        skip: offset,
        take: batchSize,
      });

      if (emails.length === 0) break;

      for (const email of emails) {
        const participants: { email: string; name?: string }[] = [];

        // From
        if (email.fromAddress) {
          participants.push({ email: email.fromAddress, name: email.fromName || undefined });
        }

        // To
        const toArr = (email.toAddresses as any[]) ?? [];
        for (const addr of toArr) {
          if (addr.email) participants.push({ email: addr.email, name: addr.name });
        }

        // CC
        const ccArr = (email.ccAddresses as any[]) ?? [];
        for (const addr of ccArr) {
          if (addr.email) participants.push({ email: addr.email, name: addr.name });
        }

        const isOutbound = email.fromAddress ? userEmails.includes(email.fromAddress.toLowerCase()) : false;
        await extractAndUpsertContacts(
          app.prisma,
          userId,
          participants,
          email.bodyText,
          email.receivedAt,
          userEmails,
          email.fromAddress || undefined,
          isOutbound,
        );
        processed++;
      }

      offset += batchSize;
    }

    return { data: { processed, message: `Backfilled contacts from ${processed} emails` } };
  });
}
