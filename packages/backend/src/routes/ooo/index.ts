import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function oooRoutes(app: FastifyInstance) {
  // Set up OOO delegation
  app.post('/api/ooo/delegation', { preHandler: [authenticate] }, async (request) => {
    const { delegateId, startAt, endAt, autoReplyEnabled, autoReplyBody, autoReplySubject, autoReplyScope, categories } =
      request.body as {
        delegateId: string;
        startAt: string;
        endAt: string;
        autoReplyEnabled?: boolean;
        autoReplyBody?: string;
        autoReplySubject?: string;
        autoReplyScope?: string;
        categories?: string[];
      };

    const delegation = await app.prisma.outOfOfficeDelegation.create({
      data: {
        userId: request.user.userId,
        delegateId,
        startAt: new Date(startAt),
        endAt: new Date(endAt),
        autoReplyEnabled: autoReplyEnabled || false,
        autoReplyBody: autoReplyBody || null,
        autoReplySubject: autoReplySubject || null,
        autoReplyScope: autoReplyScope || 'all',
        categories: categories || [],
      },
    });

    // Notify the delegate
    const user = await app.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { name: true },
    });

    await app.prisma.notification.create({
      data: {
        userId: delegateId,
        type: 'ASSIGNMENT',
        title: 'You have been set as an OOO delegate',
        body: `${user?.name || 'A teammate'} has set you as their delegate from ${new Date(startAt).toLocaleDateString()} to ${new Date(endAt).toLocaleDateString()}.`,
        data: { delegationId: delegation.id },
      },
    });

    return { data: delegation };
  });

  // Get current active delegation for the user
  app.get('/api/ooo/delegation', { preHandler: [authenticate] }, async (request) => {
    const delegation = await app.prisma.outOfOfficeDelegation.findFirst({
      where: {
        userId: request.user.userId,
        isActive: true,
      },
      include: {
        delegate: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    return { data: delegation };
  });

  // Update delegation
  app.patch('/api/ooo/delegation/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as Record<string, any>;

    const delegation = await app.prisma.outOfOfficeDelegation.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!delegation) {
      return reply.status(404).send({ error: 'Delegation not found' });
    }

    const data: any = {};
    if (updates.endAt) data.endAt = new Date(updates.endAt);
    if (updates.autoReplyEnabled !== undefined) data.autoReplyEnabled = updates.autoReplyEnabled;
    if (updates.autoReplyBody !== undefined) data.autoReplyBody = updates.autoReplyBody;
    if (updates.autoReplySubject !== undefined) data.autoReplySubject = updates.autoReplySubject;
    if (updates.autoReplyScope !== undefined) data.autoReplyScope = updates.autoReplyScope;
    if (updates.categories) data.categories = updates.categories;

    const updated = await app.prisma.outOfOfficeDelegation.update({
      where: { id },
      data,
    });

    return { data: updated };
  });

  // Cancel delegation
  app.delete('/api/ooo/delegation/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const delegation = await app.prisma.outOfOfficeDelegation.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!delegation) {
      return reply.status(404).send({ error: 'Delegation not found' });
    }

    const updated = await app.prisma.outOfOfficeDelegation.update({
      where: { id },
      data: { isActive: false },
    });

    return { data: updated };
  });
}
