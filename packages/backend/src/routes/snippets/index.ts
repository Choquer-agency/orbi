import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function snippetRoutes(app: FastifyInstance) {
  app.get('/api/snippets', { preHandler: [authenticate] }, async (request) => {
    const snippets = await app.prisma.snippet.findMany({
      where: { userId: request.user.userId },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return { data: snippets };
  });

  app.post('/api/snippets', { preHandler: [authenticate] }, async (request) => {
    const { name, bodyHtml, bodyText, category, variables } = request.body as {
      name: string;
      bodyHtml: string;
      bodyText: string;
      category?: string;
      variables?: string[];
    };

    const snippet = await app.prisma.snippet.create({
      data: {
        userId: request.user.userId,
        name,
        bodyHtml,
        bodyText,
        category: category || null,
        variables: variables || [],
      },
    });

    return { data: snippet };
  });

  app.patch('/api/snippets/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      name?: string;
      bodyHtml?: string;
      bodyText?: string;
      category?: string;
      variables?: string[];
    };

    const snippet = await app.prisma.snippet.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!snippet) {
      return reply.status(404).send({ error: 'Snippet not found' });
    }

    const updated = await app.prisma.snippet.update({
      where: { id },
      data: updates,
    });

    return { data: updated };
  });

  app.delete('/api/snippets/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const snippet = await app.prisma.snippet.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!snippet) {
      return reply.status(404).send({ error: 'Snippet not found' });
    }

    await app.prisma.snippet.delete({ where: { id } });
    return { data: { success: true } };
  });
}
