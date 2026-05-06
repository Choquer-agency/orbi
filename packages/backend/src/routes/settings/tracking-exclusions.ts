import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function trackingExclusionRoutes(app: FastifyInstance) {
  // List excluded addresses
  app.get('/api/settings/tracking-exclusions', { preHandler: [authenticate] }, async (request) => {
    const exclusions = await app.prisma.trackingExclusion.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: exclusions };
  });

  // Add an exclusion
  app.post('/api/settings/tracking-exclusions', { preHandler: [authenticate] }, async (request, reply) => {
    const { emailAddress, reason } = request.body as {
      emailAddress: string;
      reason?: string;
    };

    if (!emailAddress || !emailAddress.includes('@')) {
      return reply.status(400).send({ error: 'Valid email address required' });
    }

    const exclusion = await app.prisma.trackingExclusion.upsert({
      where: {
        userId_emailAddress: {
          userId: request.user.userId,
          emailAddress: emailAddress.toLowerCase(),
        },
      },
      update: { reason: reason ?? null },
      create: {
        userId: request.user.userId,
        emailAddress: emailAddress.toLowerCase(),
        reason: reason ?? null,
      },
    });

    return { data: exclusion };
  });

  // Remove an exclusion
  app.delete('/api/settings/tracking-exclusions/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const exclusion = await app.prisma.trackingExclusion.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!exclusion) {
      return reply.status(404).send({ error: 'Exclusion not found' });
    }

    await app.prisma.trackingExclusion.delete({ where: { id } });
    return { data: { message: 'Deleted' } };
  });
}
