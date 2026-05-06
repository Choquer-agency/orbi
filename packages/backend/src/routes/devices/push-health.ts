import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { isApnsConfigured } from '../../services/push/apns-provider.js';

export default async function pushHealthRoutes(app: FastifyInstance) {
  // Push notification health check — admin only
  app.get('/api/admin/push-health', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Admin access required' });
    }

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [deliveryStats, activeTokens, invalidatedTokens] = await Promise.all([
      // Delivery stats in last 24h
      app.prisma.$queryRaw<Array<{ status: string; count: bigint }>>`
        SELECT status, COUNT(*) as count
        FROM "PushDeliveryLog"
        WHERE "createdAt" > ${oneDayAgo}
        GROUP BY status
      `,
      // Active device token count
      app.prisma.deviceToken.count(),
      // Tokens invalidated in last 24h
      app.prisma.pushDeliveryLog.count({
        where: {
          status: 'token_invalid',
          createdAt: { gte: oneDayAgo },
        },
      }),
    ]);

    const stats = Object.fromEntries(
      deliveryStats.map((row) => [row.status, Number(row.count)]),
    );

    const totalSent = (stats.sent || 0) + (stats.failed || 0) + (stats.token_invalid || 0) + (stats.rate_limited || 0);
    const successRate = totalSent > 0 ? ((stats.sent || 0) / totalSent * 100).toFixed(1) : 'N/A';

    return reply.send({
      data: {
        apnsConfigured: isApnsConfigured(),
        last24h: {
          total: totalSent,
          sent: stats.sent || 0,
          failed: stats.failed || 0,
          tokenInvalid: stats.token_invalid || 0,
          rateLimited: stats.rate_limited || 0,
          successRate: `${successRate}%`,
        },
        activeDeviceTokens: activeTokens,
        tokensInvalidated24h: invalidatedTokens,
      },
    });
  });
}
