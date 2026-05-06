import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { addClassifyJob } from '../../queues/classify-email.queue.js';

const DEFAULT_CATEGORIES = [
  { id: 'revision_request', label: 'Revision Request', color: '#F97316' },
  { id: 'billing', label: 'Billing', color: '#10B981' },
  { id: 'new_inquiry', label: 'New Inquiry', color: '#3B82F6' },
  { id: 'project_update', label: 'Project Update', color: '#8B5CF6' },
  { id: 'meeting_scheduling', label: 'Meeting', color: '#14B8A6' },
  { id: 'feedback', label: 'Feedback', color: '#EAB308' },
  { id: 'support_request', label: 'Support', color: '#EF4444' },
  { id: 'internal', label: 'Internal', color: '#93C5FD' },
  { id: 'notification', label: 'Notification', color: '#60A5FA' },
  { id: 'marketing', label: 'Marketing', color: '#F472B6' },
  { id: 'spam', label: 'Spam', color: '#FB923C' },
  { id: 'other', label: 'Other', color: '#D1D5DB' },
];

export default async function classificationRoutes(app: FastifyInstance) {
  // Get available categories
  app.get('/api/classifications/categories', { preHandler: [authenticate] }, async () => {
    return { data: DEFAULT_CATEGORIES };
  });

  // Get classification for an email
  app.get('/api/emails/:id/classification', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const classification = await app.prisma.emailClassification.findUnique({
      where: { emailId: id },
    });

    if (!classification) {
      return reply.status(404).send({ error: 'No classification found' });
    }

    return { data: classification };
  });

  // Manually trigger classification for an email
  app.post('/api/emails/:id/classify', { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const jobId = await addClassifyJob(id);
    return { data: { jobId, message: 'Classification queued' } };
  });

  // Override classification
  app.patch('/api/emails/:id/classification', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { category } = request.body as { category: string };

    const existing = await app.prisma.emailClassification.findUnique({
      where: { emailId: id },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'No classification found' });
    }

    const updated = await app.prisma.emailClassification.update({
      where: { emailId: id },
      data: {
        category,
        manualOverride: true,
        overriddenBy: request.user.userId,
      },
    });

    return { data: updated };
  });

  // --- Routing Rules ---

  app.get('/api/routing-rules', { preHandler: [authenticate] }, async (request) => {
    const rules = await app.prisma.routingRule.findMany({
      where: { userId: request.user.userId },
      orderBy: { category: 'asc' },
    });
    return { data: rules };
  });

  app.post('/api/routing-rules', { preHandler: [authenticate] }, async (request) => {
    const { category, assignToUserId, priority } = request.body as {
      category: string;
      assignToUserId?: string;
      priority?: number;
    };

    const rule = await app.prisma.routingRule.create({
      data: {
        userId: request.user.userId,
        category,
        assignToUserId: assignToUserId || null,
        priority: priority || 0,
      },
    });

    return { data: rule };
  });

  app.patch('/api/routing-rules/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      assignToUserId?: string;
      isActive?: boolean;
      priority?: number;
    };

    const rule = await app.prisma.routingRule.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!rule) {
      return reply.status(404).send({ error: 'Routing rule not found' });
    }

    const updated = await app.prisma.routingRule.update({
      where: { id },
      data: updates,
    });

    return { data: updated };
  });

  app.delete('/api/routing-rules/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const rule = await app.prisma.routingRule.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!rule) {
      return reply.status(404).send({ error: 'Routing rule not found' });
    }

    await app.prisma.routingRule.delete({ where: { id } });
    return { data: { message: 'Deleted' } };
  });
}
