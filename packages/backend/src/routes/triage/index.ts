import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { EmailClassifier, isTriageCategory } from '../../services/ai/email-classifier.js';

export default async function triageRoutes(app: FastifyInstance) {
  // ─── Triage Settings ──────────────────────────────────────

  app.get('/api/triage/settings', { preHandler: [authenticate] }, async (request) => {
    const settings = await app.prisma.triageSettings.findUnique({
      where: { userId: request.user.userId },
    });

    return {
      data: settings ?? {
        autoSortEnabled: false,
        confidenceThreshold: 0.85,
      },
    };
  });

  app.put('/api/triage/settings', { preHandler: [authenticate] }, async (request) => {
    const { autoSortEnabled, confidenceThreshold } = request.body as {
      autoSortEnabled?: boolean;
      confidenceThreshold?: number;
    };

    const settings = await app.prisma.triageSettings.upsert({
      where: { userId: request.user.userId },
      update: {
        ...(autoSortEnabled !== undefined && { autoSortEnabled }),
        ...(confidenceThreshold !== undefined && {
          confidenceThreshold: Math.max(0.5, Math.min(0.95, confidenceThreshold)),
        }),
      },
      create: {
        userId: request.user.userId,
        autoSortEnabled: autoSortEnabled ?? false,
        confidenceThreshold: confidenceThreshold ?? 0.85,
      },
    });

    return { data: settings };
  });

  // ─── Triage Suggestion ────────────────────────────────────

  app.get('/api/triage/suggestion/:threadId', { preHandler: [authenticate] }, async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const userId = request.user.userId;

    // Get the latest email in the thread
    const latestEmail = await app.prisma.email.findFirst({
      where: { threadId },
      orderBy: { receivedAt: 'desc' },
      select: { id: true },
    });

    if (!latestEmail) {
      return reply.status(404).send({ error: 'No emails in thread' });
    }

    // Check if already has a triage label on the thread
    const thread = await app.prisma.thread.findUnique({
      where: { id: threadId },
      select: { labels: true },
    });

    const existingTriageLabel = thread?.labels?.find((l: string) => l.startsWith('triage:'));
    if (existingTriageLabel) {
      const category = existingTriageLabel.replace('triage:', '');
      return {
        data: {
          category,
          confidence: 1.0,
          isTriageCategory: true,
          alreadyFiled: true,
        },
      };
    }

    // Classify with user context
    const classifier = new EmailClassifier(app.prisma);
    const result = await classifier.classifyWithContext(latestEmail.id, userId);

    // Get user's triage settings for threshold
    const settings = await app.prisma.triageSettings.findUnique({
      where: { userId },
    });

    const threshold = settings?.confidenceThreshold ?? 0.85;

    return {
      data: {
        category: result.classification.category,
        confidence: result.classification.confidence,
        summary: result.classification.summary,
        isTriageCategory: result.isTriageCategory,
        meetsThreshold: result.classification.confidence >= threshold,
        alreadyFiled: false,
      },
    };
  });

  // ─── Triage Feedback ──────────────────────────────────────

  app.post('/api/triage/feedback', { preHandler: [authenticate] }, async (request) => {
    const userId = request.user.userId;
    const { emailId, threadId, suggestedCategory, finalCategory, wasConfirmed, senderAddress: manualSender } = request.body as {
      emailId?: string;
      threadId?: string;
      suggestedCategory: string;
      finalCategory: string;
      wasConfirmed: boolean;
      senderAddress?: string;
    };

    let senderAddress = manualSender ?? '';
    let subjectSnippet = '';

    if (emailId) {
      // Get email info for denormalized fields
      const email = await app.prisma.email.findUnique({
        where: { id: emailId },
        select: { fromAddress: true, subject: true },
      });
      senderAddress = email?.fromAddress ?? senderAddress;
      subjectSnippet = (email?.subject ?? '').slice(0, 100);
    } else {
      subjectSnippet = '(manual rule)';
    }

    // Create feedback record
    await app.prisma.triageFeedback.create({
      data: {
        userId,
        emailId: emailId ?? null,
        threadId: threadId ?? null,
        suggestedCategory,
        finalCategory,
        wasConfirmed,
        senderAddress,
        subjectSnippet,
      },
    });

    // Update classification if it differs
    if (emailId && suggestedCategory !== finalCategory) {
      await app.prisma.emailClassification.updateMany({
        where: { emailId },
        data: {
          category: finalCategory,
          manualOverride: true,
          overriddenBy: userId,
        },
      });
    }

    // Add triage label to thread if it's a triage category
    if (threadId && isTriageCategory(finalCategory)) {
      const thread = await app.prisma.thread.findUnique({
        where: { id: threadId },
        select: { labels: true },
      });

      const labels = (thread?.labels ?? []) as string[];
      // Remove any existing triage labels and add the new one
      const filtered = labels.filter((l: string) => !l.startsWith('triage:'));
      filtered.push(`triage:${finalCategory}`);

      await app.prisma.thread.update({
        where: { id: threadId },
        data: { labels: filtered },
      });
    }

    // Get feedback count for stats
    const feedbackCount = await app.prisma.triageFeedback.count({
      where: { userId },
    });

    return { data: { success: true, feedbackCount } };
  });

  // ─── Triage Stats ─────────────────────────────────────────

  app.get('/api/triage/stats', { preHandler: [authenticate] }, async (request) => {
    const userId = request.user.userId;

    const feedbackCount = await app.prisma.triageFeedback.count({
      where: { userId },
    });

    return { data: { feedbackCount } };
  });

  // ─── Triage Feedback List ─────────────────────────────────

  app.get('/api/triage/feedback', { preHandler: [authenticate] }, async (request) => {
    const userId = request.user.userId;
    const { page = '1', limit = '20' } = request.query as { page?: string; limit?: string };
    const take = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const [data, total] = await Promise.all([
      app.prisma.triageFeedback.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      app.prisma.triageFeedback.count({ where: { userId } }),
    ]);

    return {
      data,
      meta: { total, page: Math.max(parseInt(page, 10) || 1, 1), limit: take, totalPages: Math.ceil(total / take) },
    };
  });

  // ─── Update Triage Feedback ───────────────────────────────

  app.patch('/api/triage/feedback/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };
    const { finalCategory } = request.body as { finalCategory: string };

    const existing = await app.prisma.triageFeedback.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Feedback not found' });
    }

    const updated = await app.prisma.triageFeedback.update({
      where: { id },
      data: { finalCategory },
    });

    // Update linked classification if there is one
    if (existing.emailId) {
      await app.prisma.emailClassification.updateMany({
        where: { emailId: existing.emailId },
        data: { category: finalCategory, manualOverride: true, overriddenBy: userId },
      });
    }

    return { data: updated };
  });

  // ─── Delete Triage Feedback ───────────────────────────────

  app.delete('/api/triage/feedback/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };

    const existing = await app.prisma.triageFeedback.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Feedback not found' });
    }

    await app.prisma.triageFeedback.delete({ where: { id } });
    return { data: { success: true } };
  });
}
