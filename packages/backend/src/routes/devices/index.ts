import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function deviceRoutes(app: FastifyInstance) {
  // Register or update a device token for push notifications
  app.post<{
    Body: {
      token: string;
      platform: 'IOS' | 'ANDROID';
      sandbox?: boolean;
      appVersion?: string;
    };
  }>('/api/devices/register', { preHandler: [authenticate] }, async (request, reply) => {
    const { token, platform, sandbox, appVersion } = request.body;

    if (!token || !platform) {
      return reply.status(400).send({ message: 'token and platform are required' });
    }

    if (!['IOS', 'ANDROID'].includes(platform)) {
      return reply.status(400).send({ message: 'platform must be IOS or ANDROID' });
    }

    // Upsert by token — handles device re-registration and account switching.
    // If the token already exists for a different user, it gets reassigned to the
    // current user (the device physically belongs to whoever is logged in now).
    const deviceToken = await app.prisma.deviceToken.upsert({
      where: { token },
      create: {
        userId: request.user.userId,
        token,
        platform,
        sandbox: sandbox ?? false,
        appVersion: appVersion ?? null,
      },
      update: {
        userId: request.user.userId,
        platform,
        sandbox: sandbox ?? false,
        appVersion: appVersion ?? null,
        lastUsedAt: new Date(),
      },
    });

    return reply.send({ data: { id: deviceToken.id, token: deviceToken.token, platform: deviceToken.platform } });
  });

  // Unregister a specific device token (e.g., on logout)
  app.delete<{
    Body: { token: string };
  }>('/api/devices/unregister', { preHandler: [authenticate] }, async (request, reply) => {
    const { token } = request.body;

    if (token) {
      await app.prisma.deviceToken.deleteMany({
        where: { token, userId: request.user.userId },
      });
    }

    return reply.status(204).send();
  });

  // Unregister ALL device tokens for current user (password change, force sign-out)
  app.delete('/api/devices/unregister-all', { preHandler: [authenticate] }, async (request, reply) => {
    await app.prisma.deviceToken.deleteMany({
      where: { userId: request.user.userId },
    });

    return reply.status(204).send();
  });
}
