import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function meetingRoutes(app: FastifyInstance) {
  // Get meeting detection for a thread
  app.get('/api/threads/:threadId/meeting-detection', { preHandler: [authenticate] }, async (request, reply) => {
    const { threadId } = request.params as { threadId: string };

    const detections = await app.prisma.meetingDetection.findMany({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    return { data: detections };
  });

  // Get single meeting detection
  app.get('/api/meetings/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const detection = await app.prisma.meetingDetection.findUnique({
      where: { id },
    });

    if (!detection) {
      return reply.status(404).send({ error: 'Meeting detection not found' });
    }

    return { data: detection };
  });

  // Accept a meeting time
  app.post('/api/meetings/:id/accept', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { selectedTime } = request.body as { selectedTime: string };

    const detection = await app.prisma.meetingDetection.findUnique({
      where: { id },
    });

    if (!detection) {
      return reply.status(404).send({ error: 'Meeting detection not found' });
    }

    // TODO: Create calendar event via Google Calendar / Microsoft Graph
    // For now, just mark as accepted
    const updated = await app.prisma.meetingDetection.update({
      where: { id },
      data: {
        status: 'ACCEPTED',
        selectedTime: new Date(selectedTime),
      },
    });

    return { data: updated };
  });

  // Decline a meeting
  app.post('/api/meetings/:id/decline', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const detection = await app.prisma.meetingDetection.findUnique({
      where: { id },
    });

    if (!detection) {
      return reply.status(404).send({ error: 'Meeting detection not found' });
    }

    const updated = await app.prisma.meetingDetection.update({
      where: { id },
      data: { status: 'DECLINED' },
    });

    return { data: updated };
  });
}
