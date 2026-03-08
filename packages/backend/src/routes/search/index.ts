import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', { preHandler: [authenticate] }, async (request) => {
    const { q, accountId, page = '1', limit = '20' } = request.query as {
      q: string;
      accountId?: string;
      page?: string;
      limit?: string;
    };

    if (!q || q.trim().length === 0) {
      return { data: [], total: 0, page: 1, limit: 20, hasMore: false };
    }

    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 50);
    const skip = (pageNum - 1) * limitNum;

    // Get user's account IDs
    const accounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: { id: true },
    });
    const accountIds = accountId ? [accountId] : accounts.map((a) => a.id);

    const searchTerm = q.trim();

    const where: any = {
      accountId: { in: accountIds },
      OR: [
        { subject: { contains: searchTerm, mode: 'insensitive' } },
        { fromAddress: { contains: searchTerm, mode: 'insensitive' } },
        { fromName: { contains: searchTerm, mode: 'insensitive' } },
        { bodyText: { contains: searchTerm, mode: 'insensitive' } },
      ],
    };

    const [emails, total] = await Promise.all([
      app.prisma.email.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: limitNum,
        select: {
          id: true,
          threadId: true,
          subject: true,
          fromAddress: true,
          fromName: true,
          snippet: true,
          receivedAt: true,
          thread: {
            select: { id: true, subject: true, messageCount: true },
          },
        },
      }),
      app.prisma.email.count({ where }),
    ]);

    return {
      data: emails,
      total,
      page: pageNum,
      limit: limitNum,
      hasMore: skip + limitNum < total,
    };
  });
}
