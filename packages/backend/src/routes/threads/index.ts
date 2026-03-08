import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function threadRoutes(app: FastifyInstance) {
  // List threads
  app.get('/api/threads', { preHandler: [authenticate] }, async (request) => {
    const {
      accountId,
      folder,
      isRead,
      isStarred,
      isArchived,
      page = '1',
      limit = '50',
    } = request.query as {
      accountId?: string;
      folder?: string;
      isRead?: string;
      isStarred?: string;
      isArchived?: string;
      page?: string;
      limit?: string;
    };

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);
    const skip = (pageNum - 1) * limitNum;

    // Get user's account IDs
    const accounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: { id: true },
    });
    const accountIds = accountId ? [accountId] : accounts.map((a) => a.id);

    const where: any = {
      accountId: { in: accountIds },
      isTrashed: false,
    };

    if (isRead !== undefined) where.isRead = isRead === 'true';
    if (isStarred !== undefined) where.isStarred = isStarred === 'true';
    if (isArchived !== undefined) where.isArchived = isArchived === 'true';
    else where.isArchived = false;

    const [threads, total] = await Promise.all([
      app.prisma.thread.findMany({
        where,
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
      }),
      app.prisma.thread.count({ where }),
    ]);

    return {
      data: threads,
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
