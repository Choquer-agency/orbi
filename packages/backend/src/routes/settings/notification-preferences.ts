import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function notificationPreferencesRoutes(app: FastifyInstance) {
  app.get('/api/settings/notification-preferences', { preHandler: [authenticate] }, async (request) => {
    let prefs = await app.prisma.notificationPreferences.findUnique({
      where: { userId: request.user.userId },
    });

    if (!prefs) {
      prefs = await app.prisma.notificationPreferences.create({
        data: { userId: request.user.userId },
      });
    }

    return { data: prefs };
  });

  app.put('/api/settings/notification-preferences', { preHandler: [authenticate] }, async (request) => {
    const body = request.body as {
      enableNewEmail?: boolean;
      enableMention?: boolean;
      enableComment?: boolean;
      enableAssignment?: boolean;
      enableSlaWarning?: boolean;
      enableSlaBreach?: boolean;
      desktopEnabled?: boolean;
      soundEnabled?: boolean;
    };

    const prefs = await app.prisma.notificationPreferences.upsert({
      where: { userId: request.user.userId },
      update: body,
      create: { userId: request.user.userId, ...body },
    });

    return { data: prefs };
  });
}
