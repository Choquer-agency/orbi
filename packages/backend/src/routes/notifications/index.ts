import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function notificationRoutes(app: FastifyInstance) {
  // List notifications
  app.get('/api/notifications', { preHandler: [authenticate] }, async (request) => {
    const { page = '1', limit = '20' } = request.query as { page?: string; limit?: string };
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 50);
    const skip = (pageNum - 1) * limitNum;

    const [notifications, total, unreadCount] = await Promise.all([
      app.prisma.notification.findMany({
        where: { userId: request.user.userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      app.prisma.notification.count({ where: { userId: request.user.userId } }),
      app.prisma.notification.count({
        where: { userId: request.user.userId, isRead: false },
      }),
    ]);

    return {
      data: notifications,
      total,
      unreadCount,
      page: pageNum,
      limit: limitNum,
      hasMore: skip + limitNum < total,
    };
  });

  // Mark notification as read
  app.patch(
    '/api/notifications/:id/read',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const notification = await app.prisma.notification.findFirst({
        where: { id, userId: request.user.userId },
      });

      if (!notification) {
        return reply.status(404).send({ error: 'Notification not found' });
      }

      const updated = await app.prisma.notification.update({
        where: { id },
        data: { isRead: true },
      });

      return { data: updated };
    },
  );

  // Mark all as read
  app.post(
    '/api/notifications/read-all',
    { preHandler: [authenticate] },
    async (request) => {
      await app.prisma.notification.updateMany({
        where: { userId: request.user.userId, isRead: false },
        data: { isRead: true },
      });

      return { data: { success: true } };
    },
  );

  // Get unread count
  app.get(
    '/api/notifications/unread-count',
    { preHandler: [authenticate] },
    async (request) => {
      const count = await app.prisma.notification.count({
        where: { userId: request.user.userId, isRead: false },
      });

      return { data: { count } };
    },
  );
}
