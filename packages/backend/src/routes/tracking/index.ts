import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { TRANSPARENT_PNG } from '../../services/tracking/pixel.js';

export default async function trackingRoutes(app: FastifyInstance) {
  // Tracking pixel endpoint — NO authentication
  app.get('/p/:trackingId.png', async (request, reply) => {
    const { trackingId } = request.params as { trackingId: string };

    // Find the tracking record
    const tracking = await app.prisma.emailTracking.findUnique({
      where: { trackingId },
    });

    if (tracking && tracking.isEnabled) {
      // Record the open
      await app.prisma.emailOpen.create({
        data: {
          trackingId,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
        },
      });

      // Update counters
      await app.prisma.emailTracking.update({
        where: { trackingId },
        data: {
          openCount: { increment: 1 },
          lastOpenedAt: new Date(),
        },
      });
    }

    // Always return the pixel (even if tracking record not found)
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(TRANSPARENT_PNG);
  });

  // Link click tracking redirect — NO authentication
  app.get('/t/:trackingId/:linkIndex', async (request, reply) => {
    const { trackingId, linkIndex } = request.params as { trackingId: string; linkIndex: string };

    const tracking = await app.prisma.emailTracking.findUnique({
      where: { trackingId },
    });

    if (!tracking || !tracking.linkMap) {
      return reply.redirect('https://orbi.agency');
    }

    const linkMap = tracking.linkMap as Record<string, string>;
    const originalUrl = linkMap[linkIndex];

    if (!originalUrl) {
      return reply.redirect('https://orbi.agency');
    }

    // Record the click
    if (tracking.isEnabled) {
      await app.prisma.linkClick.create({
        data: {
          trackingId,
          originalUrl,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
        },
      });
    }

    return reply.redirect(originalUrl);
  });

  // Get tracking data for an email (includes opens + clicks)
  app.get('/api/emails/:id/tracking', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const tracking = await app.prisma.emailTracking.findUnique({
      where: { emailId: id },
      include: {
        opens: {
          orderBy: { openedAt: 'desc' },
          take: 50,
        },
        clicks: {
          orderBy: { clickedAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!tracking) {
      return reply.status(404).send({ error: 'No tracking data found' });
    }

    return { data: tracking };
  });

  // Toggle tracking for an email
  app.patch('/api/emails/:id/tracking', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { isEnabled } = request.body as { isEnabled: boolean };

    const tracking = await app.prisma.emailTracking.findUnique({
      where: { emailId: id },
    });

    if (!tracking) {
      return reply.status(404).send({ error: 'No tracking data found' });
    }

    const updated = await app.prisma.emailTracking.update({
      where: { emailId: id },
      data: { isEnabled },
    });

    return { data: updated };
  });
}
