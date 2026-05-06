import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function followUpRoutes(app: FastifyInstance) {
  // Create a follow-up watch
  app.post('/api/follow-ups', { preHandler: [authenticate] }, async (request) => {
    const { threadId, emailId, contactEmail, intervals } = request.body as {
      threadId: string;
      emailId: string;
      contactEmail: string;
      intervals?: number[];
    };

    const defaultIntervals = intervals || [3, 7, 14];
    const nextCheckAt = new Date(Date.now() + defaultIntervals[0] * 24 * 60 * 60 * 1000);

    const watch = await app.prisma.followUpWatch.create({
      data: {
        userId: request.user.userId,
        threadId,
        emailId,
        contactEmail,
        intervals: defaultIntervals,
        nextCheckAt,
      },
    });

    return { data: watch };
  });

  // List active follow-up watches
  app.get('/api/follow-ups', { preHandler: [authenticate] }, async (request) => {
    const { status } = request.query as { status?: string };

    const where: any = { userId: request.user.userId };
    if (status) {
      where.status = status;
    }

    const watches = await app.prisma.followUpWatch.findMany({
      where,
      orderBy: { nextCheckAt: 'asc' },
      include: {
        thread: { select: { subject: true, snippet: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });

    return { data: watches };
  });

  // Get a single follow-up watch with events
  app.get('/api/follow-ups/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const watch = await app.prisma.followUpWatch.findFirst({
      where: { id, userId: request.user.userId },
      include: {
        thread: { select: { subject: true, snippet: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!watch) {
      return reply.status(404).send({ error: 'Follow-up watch not found' });
    }

    return { data: watch };
  });

  // Cancel a follow-up watch
  app.delete('/api/follow-ups/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const watch = await app.prisma.followUpWatch.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!watch) {
      return reply.status(404).send({ error: 'Follow-up watch not found' });
    }

    const updated = await app.prisma.followUpWatch.update({
      where: { id },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    });

    return { data: updated };
  });

  // Approve and send a drafted follow-up
  app.post('/api/follow-ups/:id/send', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { eventId } = request.body as { eventId: string };

    const event = await app.prisma.followUpEvent.findUnique({
      where: { id: eventId },
      include: { watch: { include: { thread: { include: { emails: { take: 1, orderBy: { receivedAt: 'desc' } } } } } } },
    });

    if (!event || event.watch.userId !== request.user.userId) {
      return reply.status(404).send({ error: 'Follow-up event not found' });
    }

    if (!event.draftBody) {
      return reply.status(400).send({ error: 'No draft to send' });
    }

    // Mark the event as sent
    await app.prisma.followUpEvent.create({
      data: {
        watchId: id,
        type: 'follow_up_sent',
        draftBody: event.draftBody,
        draftTone: event.draftTone,
      },
    });

    return { data: { message: 'Follow-up marked as sent', draftBody: event.draftBody } };
  });
}
