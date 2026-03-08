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
}
