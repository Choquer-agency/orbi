import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { emitThreadsUpdated } from '../../services/socket-events.js';
import { addSnoozeJob, removeSnoozeJob } from '../../queues/snooze.queue.js';

/** Recognised search operators and whatever free-text remains. */
interface ParsedSearch {
  text: string;           // remaining free-text after stripping operators
  from?: string;          // from:address
  to?: string;            // to:address
  before?: Date;          // before:YYYY-MM-DD
  after?: Date;           // after:YYYY-MM-DD
  hasAttachment?: boolean; // has:attachment
  isUnread?: boolean;     // is:unread
  isStarred?: boolean;    // is:starred
  isRead?: boolean;       // is:read
  label?: string;         // label:xyz
}

const OPERATOR_RE = /(?:^|\s)(from|to|before|after|has|is|label):(\S+)/gi;

function parseSearchOperators(raw: string): ParsedSearch {
  const result: ParsedSearch = { text: '' };
  let remaining = raw;

  for (const match of raw.matchAll(OPERATOR_RE)) {
    const op = match[1].toLowerCase();
    const val = match[2];

    switch (op) {
      case 'from':
        result.from = val;
        break;
      case 'to':
        result.to = val;
        break;
      case 'before': {
        const d = new Date(val);
        if (!isNaN(d.getTime())) result.before = d;
        break;
      }
      case 'after': {
        const d = new Date(val);
        if (!isNaN(d.getTime())) result.after = d;
        break;
      }
      case 'has':
        if (val.toLowerCase() === 'attachment') result.hasAttachment = true;
        break;
      case 'is':
        if (val.toLowerCase() === 'unread') result.isUnread = true;
        else if (val.toLowerCase() === 'starred') result.isStarred = true;
        else if (val.toLowerCase() === 'read') result.isRead = true;
        break;
      case 'label':
        result.label = val;
        break;
    }

    remaining = remaining.replace(match[0], ' ');
  }

  result.text = remaining.replace(/\s+/g, ' ').trim();
  return result;
}

export default async function threadRoutes(app: FastifyInstance) {
  // List threads
  app.get('/api/threads', { preHandler: [authenticate] }, async (request) => {
    const {
      accountId,
      folder,
      isRead,
      isStarred,
      isArchived,
      search,
      from,
      category,
      page = '1',
      limit = '50',
    } = request.query as {
      accountId?: string;
      folder?: string;
      isRead?: string;
      isStarred?: string;
      isArchived?: string;
      search?: string;
      from?: string;
      category?: string;
      page?: string;
      limit?: string;
    };

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    const skip = (pageNum - 1) * limitNum;

    // Get user's account IDs
    const accounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: { id: true, email: true },
    });
    const accountIds = accountId ? [accountId] : accounts.map((a) => a.id);

    const allAccountEmails = accounts.map((a) => a.email).filter(Boolean);
    // Get account emails for "sent" folder filtering
    const accountEmails = folder === 'sent' ? allAccountEmails : [];

    const where: any = {
      accountId: { in: accountIds },
    };

    const searchTerm = search?.trim();
    const fromEmail = from?.trim();

    if (fromEmail && fromEmail.length > 0) {
      // Fast path: exact email match (used when clicking a contact suggestion)
      where.isTrashed = false;
      where.emails = { some: { fromAddress: fromEmail } };
    } else if (searchTerm && searchTerm.length > 0) {
      // Parse advanced search operators (from:, to:, before:, after:, has:attachment, is:unread, etc.)
      const parsed = parseSearchOperators(searchTerm);

      // Global search: exclude only trashed threads, ignore folder
      where.isTrashed = false;

      // Build email-level filters from operators
      const emailFilters: any[] = [];

      if (parsed.from) {
        emailFilters.push({
          OR: [
            { fromAddress: { contains: parsed.from, mode: 'insensitive' } },
            { fromName: { contains: parsed.from, mode: 'insensitive' } },
          ],
        });
      }
      if (parsed.to) {
        // toAddresses is a Json field — use string_contains for partial match
        emailFilters.push({
          toAddresses: { string_contains: parsed.to },
        });
      }
      if (parsed.before) {
        emailFilters.push({ receivedAt: { lt: parsed.before } });
      }
      if (parsed.after) {
        emailFilters.push({ receivedAt: { gt: parsed.after } });
      }
      if (parsed.hasAttachment) {
        emailFilters.push({ hasAttachments: true });
      }

      // Thread-level boolean filters
      if (parsed.isUnread) where.isRead = false;
      if (parsed.isRead) where.isRead = true;
      if (parsed.isStarred) where.isStarred = true;
      if (parsed.label) where.labels = { has: parsed.label };

      // Apply email-level operator filters
      if (emailFilters.length > 0) {
        where.emails = { some: { AND: emailFilters } };
      }

      // Free-text portion: search subject/snippet/from fields
      if (parsed.text.length > 0) {
        where.OR = [
          { subject: { contains: parsed.text, mode: 'insensitive' } },
          { snippet: { contains: parsed.text, mode: 'insensitive' } },
          {
            emails: {
              some: {
                ...(emailFilters.length > 0 ? { AND: emailFilters } : {}),
                OR: [
                  { fromAddress: { contains: parsed.text, mode: 'insensitive' } },
                  { fromName: { contains: parsed.text, mode: 'insensitive' } },
                ],
              },
            },
          },
        ];
        // If we have both operator email filters and free-text, remove the standalone emails filter
        // since it's now embedded in the OR clause
        if (emailFilters.length > 0) {
          delete where.emails;
        }
      }
    } else {
      // Folder-based filtering
      switch (folder) {
        case 'starred':
          where.isStarred = true;
          where.isTrashed = false;
          where.isArchived = false;
          break;
        case 'sent':
          where.isTrashed = false;
          where.isArchived = false;
          where.emails = { some: { fromAddress: { in: accountEmails } } };
          break;
        case 'drafts':
          where.isTrashed = false;
          where.emails = { some: { isDraft: true } };
          break;
        case 'archive':
          where.isArchived = true;
          where.isTrashed = false;
          break;
        case 'trash':
          where.isTrashed = true;
          break;
        case 'snoozed':
          where.isTrashed = false;
          where.snoozedUntil = { not: null };
          break;
        case 'marketing':
        case 'spam':
          where.isTrashed = false;
          where.labels = { has: `triage:${folder}` };
          break;
        default: {
          // inbox (default) — exclude triage-labeled threads when auto-sort is on
          // Also exclude sent-only threads (no replies received yet)
          where.isTrashed = false;
          where.isArchived = false;
          where.snoozedUntil = null;

          // Must have at least one email NOT from the user (i.e. received mail)
          where.emails = {
            ...where.emails,
            some: {
              ...(where.emails?.some || {}),
              fromAddress: { notIn: allAccountEmails.length > 0 ? allAccountEmails : ['__none__'] },
            },
          };

          const triageSettings = await app.prisma.triageSettings.findUnique({
            where: { userId: request.user.userId },
          });
          if (triageSettings?.autoSortEnabled) {
            where.NOT = {
              labels: {
                hasSome: [
                  'triage:marketing',
                  'triage:spam',
                ],
              },
            };
          }
          break;
        }
      }

      // Additional filters
      if (isRead !== undefined) where.isRead = isRead === 'true';
      if (isStarred !== undefined) where.isStarred = isStarred === 'true';
      if (isArchived !== undefined) where.isArchived = isArchived === 'true';

      // Category filter (inbox splits)
      if (category) {
        const categories = category.split(',').map((c: string) => c.trim()).filter(Boolean);
        if (categories.length > 0) {
          where.emails = {
            ...where.emails,
            some: {
              ...(where.emails?.some || {}),
              classification: {
                category: { in: categories },
              },
            },
          };
        }
      }
    }

    const [threads, total] = await Promise.all([
      app.prisma.thread.findMany({
        where,
        orderBy: (folder === 'sent' || folder === 'drafts') ? { lastMessageAt: 'desc' } : { lastReceivedAt: 'desc' },
        skip,
        take: limitNum,
        include: {
          emails: {
            where: folder === 'drafts'
              ? { isDraft: true }
              : folder === 'sent' ? undefined : {
                fromAddress: { notIn: allAccountEmails.length > 0 ? allAccountEmails : ['__none__'] },
              },
            orderBy: { receivedAt: 'desc' },
            take: 1,
            select: {
              fromAddress: true,
              fromName: true,
              snippet: true,
              receivedAt: true,
              classification: {
                select: { category: true, confidence: true, urgency: true, summary: true },
              },
            },
          },
          _count: { select: { comments: true } },
        },
      }),
      app.prisma.thread.count({ where }),
    ]);

    // Add hasDraft flag (skip for drafts folder — all have drafts by definition)
    let threadsWithDrafts = threads as any[];
    if (folder !== 'drafts' && threads.length > 0) {
      const threadIds = threads.map((t) => t.id);
      const draftCounts = await app.prisma.email.groupBy({
        by: ['threadId'],
        where: { threadId: { in: threadIds }, isDraft: true },
        _count: true,
      });
      const draftSet = new Set(draftCounts.map((d) => d.threadId));
      threadsWithDrafts = threads.map((t) => ({
        ...t,
        hasDraft: draftSet.has(t.id),
      }));
    } else if (folder === 'drafts') {
      threadsWithDrafts = threads.map((t) => ({ ...t, hasDraft: true }));
    }

    return {
      data: threadsWithDrafts,
      total,
      page: pageNum,
      limit: limitNum,
      hasMore: skip + limitNum < total,
    };
  });

  // Get thread with all emails
  app.get('/api/threads/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const thread = await app.prisma.thread.findUnique({
      where: { id },
      include: {
        emails: {
          orderBy: { receivedAt: 'asc' },
          include: {
            attachments: true,
            classification: {
              select: { category: true, confidence: true, urgency: true, summary: true },
            },
          },
        },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            author: { select: { id: true, name: true, avatarUrl: true } },
            mentions: {
              include: {
                mentionedUser: { select: { id: true, name: true, avatarUrl: true } },
              },
            },
            reactions: {
              include: {
                user: { select: { id: true, name: true } },
              },
            },
          },
        },
        access: true,
      },
    });

    if (!thread) {
      return reply.status(404).send({ error: 'Thread not found' });
    }

    // Verify user has access
    const account = await app.prisma.account.findFirst({
      where: { id: thread.accountId, userId: request.user.userId },
    });
    const hasAccess = await app.prisma.threadAccess.findFirst({
      where: { threadId: id, userId: request.user.userId },
    });

    if (!account && !hasAccess) {
      return reply.status(403).send({ error: 'Access denied' });
    }

    // Mark as read
    if (!thread.isRead) {
      await app.prisma.thread.update({
        where: { id },
        data: { isRead: true },
      });
    }

    return { data: thread };
  });

  // Update thread
  app.patch('/api/threads/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      isRead?: boolean;
      isStarred?: boolean;
      isArchived?: boolean;
      isTrashed?: boolean;
      labels?: string[];
    };

    const thread = await app.prisma.thread.findUnique({ where: { id } });
    if (!thread) {
      return reply.status(404).send({ error: 'Thread not found' });
    }

    const updated = await app.prisma.thread.update({
      where: { id },
      data: updates,
    });

    emitThreadsUpdated(app.io, request.user.userId, [id]);

    return { data: updated };
  });

  // Snooze a thread
  app.patch('/api/threads/:id/snooze', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { snoozedUntil } = request.body as { snoozedUntil: string };

    const snoozeDate = new Date(snoozedUntil);
    if (isNaN(snoozeDate.getTime()) || snoozeDate.getTime() <= Date.now()) {
      return reply.status(400).send({ error: 'snoozedUntil must be a valid future date' });
    }

    const thread = await app.prisma.thread.findUnique({ where: { id } });
    if (!thread) {
      return reply.status(404).send({ error: 'Thread not found' });
    }

    // Verify ownership
    const account = await app.prisma.account.findFirst({
      where: { id: thread.accountId, userId: request.user.userId },
    });
    if (!account) {
      return reply.status(403).send({ error: 'Access denied' });
    }

    const updated = await app.prisma.thread.update({
      where: { id },
      data: { snoozedUntil: snoozeDate },
    });

    const delay = snoozeDate.getTime() - Date.now();
    await addSnoozeJob(id, request.user.userId, delay);

    emitThreadsUpdated(app.io, request.user.userId, [id]);

    return { data: updated };
  });

  // Unsnooze a thread
  app.delete('/api/threads/:id/snooze', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const thread = await app.prisma.thread.findUnique({ where: { id } });
    if (!thread) {
      return reply.status(404).send({ error: 'Thread not found' });
    }

    const account = await app.prisma.account.findFirst({
      where: { id: thread.accountId, userId: request.user.userId },
    });
    if (!account) {
      return reply.status(403).send({ error: 'Access denied' });
    }

    const updated = await app.prisma.thread.update({
      where: { id },
      data: { snoozedUntil: null },
    });

    await removeSnoozeJob(id);

    emitThreadsUpdated(app.io, request.user.userId, [id]);

    return { data: updated };
  });

  // Get shared threads ("Shared With Me" smart folder)
  app.get('/api/threads/shared', { preHandler: [authenticate] }, async (request) => {
    const { filter = 'all', page = '1', limit = '50' } = request.query as {
      filter?: 'all' | 'needs_input' | 'resolved';
      page?: string;
      limit?: string;
    };

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    const skip = (pageNum - 1) * limitNum;

    const accessRecords = await app.prisma.threadAccess.findMany({
      where: { userId: request.user.userId },
      select: { threadId: true },
    });

    const threadIds = accessRecords.map((a) => a.threadId);

    const threads = await app.prisma.thread.findMany({
      where: { id: { in: threadIds } },
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: limitNum,
      include: {
        emails: {
          orderBy: { receivedAt: 'desc' },
          take: 1,
          select: {
            fromAddress: true,
            fromName: true,
            snippet: true,
            receivedAt: true,
          },
        },
        _count: { select: { comments: true } },
      },
    });

    return { data: threads, total: threadIds.length, page: pageNum, limit: limitNum };
  });
}
