import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

const DEFAULT_SPLITS = [
  { category: 'all', label: 'All', position: 0 },
  { category: 'revision_request,new_inquiry,feedback', label: 'Client Work', position: 1 },
  { category: 'internal', label: 'Internal', position: 2 },
  { category: 'billing', label: 'Billing', position: 3 },
  { category: 'project_update,notification', label: 'Updates', position: 4 },
];

export default async function inboxSplitRoutes(app: FastifyInstance) {
  app.get('/api/settings/inbox-splits', { preHandler: [authenticate] }, async (request) => {
    let splits = await app.prisma.inboxSplit.findMany({
      where: { userId: request.user.userId },
      orderBy: { position: 'asc' },
    });

    // Seed defaults if none exist
    if (splits.length === 0) {
      await app.prisma.inboxSplit.createMany({
        data: DEFAULT_SPLITS.map((s) => ({
          userId: request.user.userId,
          ...s,
          isEnabled: true,
        })),
      });
      splits = await app.prisma.inboxSplit.findMany({
        where: { userId: request.user.userId },
        orderBy: { position: 'asc' },
      });
    }

    return { data: splits };
  });

  app.put('/api/settings/inbox-splits', { preHandler: [authenticate] }, async (request) => {
    const splits = request.body as {
      category: string;
      label: string;
      position: number;
      isEnabled: boolean;
    }[];

    // Delete existing and recreate
    await app.prisma.inboxSplit.deleteMany({
      where: { userId: request.user.userId },
    });

    if (splits.length > 0) {
      await app.prisma.inboxSplit.createMany({
        data: splits.map((s) => ({
          userId: request.user.userId,
          category: s.category,
          label: s.label,
          position: s.position,
          isEnabled: s.isEnabled,
        })),
      });
    }

    const result = await app.prisma.inboxSplit.findMany({
      where: { userId: request.user.userId },
      orderBy: { position: 'asc' },
    });

    return { data: result };
  });
}
