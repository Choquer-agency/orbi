import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function userRoutes(app: FastifyInstance) {
  app.get('/api/users', { preHandler: [authenticate] }, async (request) => {
    const { search } = request.query as { search?: string };

    const users = await app.prisma.user.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        role: true,
      },
      orderBy: { name: 'asc' },
    });

    return { data: users };
  });

  // Update current user's profile (name, avatar)
  app.patch('/api/users/me', { preHandler: [authenticate] }, async (request, reply) => {
    const { name, avatarUrl } = request.body as { name?: string; avatarUrl?: string };

    const updates: Record<string, string> = {};

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return reply.status(400).send({ error: 'Name cannot be empty' });
      }
      updates.name = trimmed;
    }

    if (avatarUrl !== undefined) {
      if (avatarUrl !== null && avatarUrl !== '') {
        if (!avatarUrl.startsWith('data:image/')) {
          return reply.status(400).send({ error: 'Avatar must be a data:image URL' });
        }
        if (avatarUrl.length > 512_000) {
          return reply.status(400).send({ error: 'Avatar too large (max ~500KB)' });
        }
        updates.avatarUrl = avatarUrl;
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No valid fields to update' });
    }

    const user = await app.prisma.user.update({
      where: { id: request.user.userId },
      data: updates,
      select: { id: true, name: true, email: true, role: true, avatarUrl: true },
    });

    return { data: user };
  });
}
