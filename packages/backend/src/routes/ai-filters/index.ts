import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function aiFilterRoutes(app: FastifyInstance) {
  app.get('/api/ai-filters', { preHandler: [authenticate] }, async (request) => {
    const filters = await app.prisma.aiFilter.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: filters };
  });

  app.post('/api/ai-filters', { preHandler: [authenticate] }, async (request) => {
    const { name, description, conditions, actions } = request.body as {
      name: string;
      description: string;
      conditions: any;
      actions: any;
    };

    const filter = await app.prisma.aiFilter.create({
      data: {
        userId: request.user.userId,
        name,
        description,
        conditions,
        actions,
      },
    });

    return { data: filter };
  });

  app.patch('/api/ai-filters/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      name?: string;
      description?: string;
      conditions?: any;
      actions?: any;
      isActive?: boolean;
    };

    const filter = await app.prisma.aiFilter.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!filter) {
      return reply.status(404).send({ error: 'Filter not found' });
    }

    const updated = await app.prisma.aiFilter.update({
      where: { id },
      data: updates,
    });

    return { data: updated };
  });

  app.delete('/api/ai-filters/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const filter = await app.prisma.aiFilter.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!filter) {
      return reply.status(404).send({ error: 'Filter not found' });
    }

    await app.prisma.aiFilter.delete({ where: { id } });
    return { data: { success: true } };
  });
}
