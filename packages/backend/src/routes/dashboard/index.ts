import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { computeResponseTime, computeNeedsReply } from '../../services/dashboard/metrics.js';
import { extractTasks } from '../../services/ai/task-extractor.js';

export default async function dashboardRoutes(app: FastifyInstance) {
  // Response time metrics
  app.get('/api/dashboard/metrics', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;
    const metrics = await computeResponseTime(app.prisma, userId);
    return metrics;
  });

  // Top 10 contacts waiting for a reply
  app.get('/api/dashboard/needs-reply', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;
    const data = await computeNeedsReply(app.prisma, userId);
    return { data };
  });

  // Task list with optional status filter
  app.get('/api/dashboard/tasks', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;
    const { status = 'open', limit = '50', page = '1' } = request.query as Record<string, string>;

    const where: any = { userId };
    if (status === 'open') {
      where.status = 'OPEN';
    } else if (status === 'done') {
      where.status = { in: ['DONE', 'AUTO_RESOLVED'] };
    }
    // 'all' = no status filter

    const take = Math.min(parseInt(limit, 10) || 50, 100);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;

    const [tasks, total] = await Promise.all([
      app.prisma.task.findMany({
        where,
        orderBy: [
          { status: 'asc' }, // OPEN first (alphabetically before DONE)
          { deadline: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        include: {
          thread: { select: { subject: true } },
        },
        take,
        skip,
      }),
      app.prisma.task.count({ where }),
    ]);

    return { data: tasks, total, hasMore: skip + take < total };
  });

  // Toggle task status
  app.patch('/api/dashboard/tasks/:id', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: 'DONE' | 'OPEN' };

    const task = await app.prisma.task.findFirst({ where: { id, userId } });
    if (!task) {
      throw { statusCode: 404, message: 'Task not found' };
    }

    const updated = await app.prisma.task.update({
      where: { id },
      data: {
        status,
        resolvedAt: status === 'DONE' ? new Date() : null,
        resolvedBy: status === 'DONE' ? 'manual' : null,
      },
    });

    return updated;
  });

  // AI extract tasks from a thread
  app.post('/api/dashboard/tasks/extract', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;
    const { threadId } = request.body as { threadId: string };

    if (!threadId) {
      throw { statusCode: 400, message: 'threadId is required' };
    }

    const result = await extractTasks(app.prisma, threadId, userId);
    return result;
  });

  // Pending internal comments (unresolved mentions/comments)
  app.get('/api/dashboard/pending-comments', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;

    // Get accounts for this user to find their threads
    const accountIds = await app.prisma.account
      .findMany({ where: { userId }, select: { id: true } })
      .then((a) => a.map((x) => x.id));

    // Find unresolved comments on threads the user owns or is mentioned in
    const comments = await app.prisma.threadComment.findMany({
      where: {
        isResolved: false,
        authorId: { not: userId }, // Don't show own comments
        OR: [
          // Comments on threads the user owns
          { thread: { accountId: { in: accountIds } } },
          // Comments where the user is mentioned
          { mentions: { some: { mentionedUserId: userId } } },
        ],
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        thread: { select: { id: true, subject: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return { data: comments };
  });

  // Recent activity — last sent emails + resolved tasks
  app.get('/api/dashboard/activity', { preHandler: [authenticate] }, async (request) => {
    const { userId } = (request as any).user;

    const accounts = await app.prisma.account.findMany({
      where: { userId },
      select: { id: true, email: true },
    });
    const userEmails = accounts.map((a) => a.email.toLowerCase());
    const accountIds = accounts.map((a) => a.id);

    // Recent sent emails
    const sentEmails = await app.prisma.email.findMany({
      where: {
        accountId: { in: accountIds },
        fromAddress: { in: userEmails },
      },
      orderBy: { receivedAt: 'desc' },
      take: 10,
      include: {
        thread: { select: { id: true, subject: true } },
      },
    });

    // Recent received emails
    const receivedEmails = await app.prisma.email.findMany({
      where: {
        accountId: { in: accountIds },
        NOT: { fromAddress: { in: userEmails } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 5,
      include: {
        thread: { select: { id: true, subject: true } },
      },
    });

    // Recently resolved tasks
    const resolvedTasks = await app.prisma.task.findMany({
      where: {
        userId,
        status: { in: ['DONE', 'AUTO_RESOLVED'] },
        resolvedAt: { not: null },
      },
      orderBy: { resolvedAt: 'desc' },
      take: 5,
      include: {
        thread: { select: { id: true, subject: true } },
      },
    });

    type ActivityItem = {
      id: string;
      type: 'sent' | 'received' | 'resolved';
      subject: string;
      contactName: string | null;
      contactEmail: string;
      threadId: string;
      timestamp: string;
    };

    const items: ActivityItem[] = [
      ...sentEmails.map((e) => {
        const to = Array.isArray(e.toAddresses) ? (e.toAddresses as any[])[0] : null;
        return {
          id: `sent-${e.id}`,
          type: 'sent' as const,
          subject: e.thread.subject,
          contactName: to?.name || null,
          contactEmail: to?.email || '',
          threadId: e.thread.id,
          timestamp: e.receivedAt.toISOString(),
        };
      }),
      ...receivedEmails.map((e) => ({
        id: `recv-${e.id}`,
        type: 'received' as const,
        subject: e.thread.subject,
        contactName: e.fromName,
        contactEmail: e.fromAddress,
        threadId: e.thread.id,
        timestamp: e.receivedAt.toISOString(),
      })),
      ...resolvedTasks.map((t) => ({
        id: `task-${t.id}`,
        type: 'resolved' as const,
        subject: t.thread.subject,
        contactName: t.contactName,
        contactEmail: t.contactEmail || '',
        threadId: t.thread.id,
        timestamp: (t.resolvedAt ?? t.updatedAt).toISOString(),
      })),
    ];

    // Sort by timestamp descending, take 15
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { data: items.slice(0, 15) };
  });
}
