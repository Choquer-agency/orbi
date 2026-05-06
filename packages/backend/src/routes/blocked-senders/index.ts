import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function blockedSenderRoutes(app: FastifyInstance) {
  app.get('/api/blocked-senders', { preHandler: [authenticate] }, async (request) => {
    const senders = await app.prisma.blockedSender.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: senders };
  });

  app.post('/api/blocked-senders', { preHandler: [authenticate] }, async (request, reply) => {
    const { emailAddress, domain, reason } = request.body as {
      emailAddress?: string;
      domain?: string;
      reason?: string;
    };

    if (!emailAddress && !domain) {
      return reply.status(400).send({ error: 'Provide emailAddress or domain' });
    }

    const data: any = {
      userId: request.user.userId,
      reason: reason || null,
    };

    if (emailAddress) {
      data.emailAddress = emailAddress.toLowerCase().trim();
    } else if (domain) {
      data.domain = domain.toLowerCase().trim().replace(/^@/, '');
    }

    try {
      const blocked = await app.prisma.blockedSender.create({ data });
      return { data: blocked };
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: 'Already blocked' });
      }
      throw err;
    }
  });

  app.delete('/api/blocked-senders/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const blocked = await app.prisma.blockedSender.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!blocked) {
      return reply.status(404).send({ error: 'Not found' });
    }

    await app.prisma.blockedSender.delete({ where: { id } });
    return { data: { success: true } };
  });
}
