import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { createNotificationIfAllowed } from '../../services/notifications.js';
import { emitThreadsUpdated } from '../../services/socket-events.js';

export default async function handoffRoutes(app: FastifyInstance) {
  // Create a thread handoff
  app.post('/api/threads/:threadId/handoff', { preHandler: [authenticate] }, async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const { toUserId, note, transferSla, transferFollowUps } = request.body as {
      toUserId: string;
      note?: string;
      transferSla?: boolean;
      transferFollowUps?: boolean;
    };

    const thread = await app.prisma.thread.findUnique({ where: { id: threadId } });
    if (!thread) {
      return reply.status(404).send({ error: 'Thread not found' });
    }

    const toUser = await app.prisma.user.findUnique({ where: { id: toUserId } });
    if (!toUser) {
      return reply.status(404).send({ error: 'Target user not found' });
    }

    // Create the handoff
    const handoff = await app.prisma.threadHandoff.create({
      data: {
        threadId,
        fromUserId: request.user.userId,
        toUserId,
        note: note || null,
        transferSla: transferSla || false,
        transferFollowUps: transferFollowUps || false,
      },
    });

    // Grant thread access to the recipient
    await app.prisma.threadAccess.upsert({
      where: { threadId_userId: { threadId, userId: toUserId } },
      update: { accessLevel: 'COLLABORATOR' },
      create: { threadId, userId: toUserId, accessLevel: 'COLLABORATOR' },
    });

    // Create an internal comment for audit trail
    const fromUser = await app.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { name: true },
    });

    await app.prisma.threadComment.create({
      data: {
        threadId,
        authorId: request.user.userId,
        bodyHtml: `<p>Thread handed off to ${toUser.name}${note ? `: "${note}"` : ''}</p>`,
        bodyText: `Thread handed off to ${toUser.name}${note ? `: "${note}"` : ''}`,
      },
    });

    // Send notification with real-time push
    await createNotificationIfAllowed(
      app.prisma,
      {
        userId: toUserId,
        type: 'ASSIGNMENT',
        title: `Thread handed off to you`,
        body: note || `${fromUser?.name || 'A teammate'} handed off: ${thread.subject}`,
        data: { threadId, handoffId: handoff.id },
      },
      app.io,
    );

    emitThreadsUpdated(app.io, [request.user.userId, toUserId], [threadId]);

    // Transfer follow-up watches if requested
    if (transferFollowUps) {
      await app.prisma.followUpWatch.updateMany({
        where: { threadId, userId: request.user.userId, status: 'WATCHING' },
        data: { userId: toUserId },
      });
    }

    return { data: handoff };
  });

  // List handoffs to the current user
  app.get('/api/handoffs', { preHandler: [authenticate] }, async (request) => {
    const { status } = request.query as { status?: string };

    const where: any = { toUserId: request.user.userId };
    if (status) where.status = status;

    const handoffs = await app.prisma.threadHandoff.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        thread: { select: { id: true, subject: true, snippet: true, lastMessageAt: true } },
        fromUser: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    return { data: handoffs };
  });

  // Accept or decline a handoff
  app.patch('/api/handoffs/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { action } = request.body as { action: 'accept' | 'decline' };

    const handoff = await app.prisma.threadHandoff.findFirst({
      where: { id, toUserId: request.user.userId },
    });

    if (!handoff) {
      return reply.status(404).send({ error: 'Handoff not found' });
    }

    if (handoff.status !== 'PENDING') {
      return reply.status(400).send({ error: 'Handoff already processed' });
    }

    const updated = await app.prisma.threadHandoff.update({
      where: { id },
      data: {
        status: action === 'accept' ? 'ACCEPTED' : 'DECLINED',
        acceptedAt: action === 'accept' ? new Date() : null,
      },
    });

    // If declined, revoke thread access
    if (action === 'decline') {
      await app.prisma.threadAccess.deleteMany({
        where: { threadId: handoff.threadId, userId: request.user.userId },
      });
    }

    emitThreadsUpdated(app.io, [handoff.fromUserId, request.user.userId], [handoff.threadId]);

    return { data: updated };
  });

  // Return a thread to original owner
  app.post('/api/handoffs/:id/return', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const handoff = await app.prisma.threadHandoff.findFirst({
      where: { id, toUserId: request.user.userId, status: 'ACCEPTED' },
    });

    if (!handoff) {
      return reply.status(404).send({ error: 'Handoff not found or not accepted' });
    }

    const updated = await app.prisma.threadHandoff.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    // Notify original owner with real-time push
    await createNotificationIfAllowed(
      app.prisma,
      {
        userId: handoff.fromUserId,
        type: 'ASSIGNMENT',
        title: 'Thread returned to you',
        body: `The thread you handed off has been returned.`,
        data: { threadId: handoff.threadId, handoffId: id },
      },
      app.io,
    );

    emitThreadsUpdated(app.io, [handoff.fromUserId, request.user.userId], [handoff.threadId]);

    return { data: updated };
  });
}
