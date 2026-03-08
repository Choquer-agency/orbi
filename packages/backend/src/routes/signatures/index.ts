import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function signatureRoutes(app: FastifyInstance) {
  app.get('/api/signatures', { preHandler: [authenticate] }, async (request) => {
    const signatures = await app.prisma.signature.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'asc' },
    });
    return { data: signatures };
  });

  app.post('/api/signatures', { preHandler: [authenticate] }, async (request) => {
    const { name, bodyHtml, isDefault } = request.body as {
      name: string;
      bodyHtml: string;
      isDefault?: boolean;
    };

    if (isDefault) {
      await app.prisma.signature.updateMany({
        where: { userId: request.user.userId },
        data: { isDefault: false },
      });
    }

    const signature = await app.prisma.signature.create({
      data: {
        userId: request.user.userId,
        name,
        bodyHtml,
        isDefault: isDefault || false,
      },
    });

    return { data: signature };
  });

  app.patch('/api/signatures/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as { name?: string; bodyHtml?: string; isDefault?: boolean };

    const signature = await app.prisma.signature.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!signature) {
      return reply.status(404).send({ error: 'Signature not found' });
    }

    if (updates.isDefault) {
      await app.prisma.signature.updateMany({
        where: { userId: request.user.userId },
        data: { isDefault: false },
      });
    }

    const updated = await app.prisma.signature.update({
      where: { id },
      data: updates,
    });

    return { data: updated };
  });

  app.delete('/api/signatures/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const signature = await app.prisma.signature.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!signature) {
      return reply.status(404).send({ error: 'Signature not found' });
    }

    await app.prisma.signature.delete({ where: { id } });
    return { data: { success: true } };
  });
}
