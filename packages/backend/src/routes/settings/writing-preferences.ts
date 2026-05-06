import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function writingPreferencesRoutes(app: FastifyInstance) {
  // Get user's writing preferences
  app.get('/api/settings/writing-preferences', { preHandler: [authenticate] }, async (request) => {
    const prefs = await app.prisma.writingPreferences.findUnique({
      where: { userId: request.user.userId },
    });

    return { data: prefs };
  });

  // Update writing preferences
  app.put('/api/settings/writing-preferences', { preHandler: [authenticate] }, async (request) => {
    const { greetingStyle, signOffStyle, tone, verbosity, descriptors, customRules } =
      request.body as {
        greetingStyle?: string;
        signOffStyle?: string;
        tone?: number;
        verbosity?: number;
        descriptors?: string[];
        customRules?: string[];
      };

    const prefs = await app.prisma.writingPreferences.upsert({
      where: { userId: request.user.userId },
      create: {
        userId: request.user.userId,
        greetingStyle,
        signOffStyle,
        tone: tone ?? 3,
        verbosity: verbosity ?? 3,
        descriptors: descriptors ?? [],
        customRules: customRules ?? [],
      },
      update: {
        ...(greetingStyle !== undefined && { greetingStyle }),
        ...(signOffStyle !== undefined && { signOffStyle }),
        ...(tone !== undefined && { tone }),
        ...(verbosity !== undefined && { verbosity }),
        ...(descriptors !== undefined && { descriptors }),
        ...(customRules !== undefined && { customRules }),
      },
    });

    return { data: prefs };
  });

  // List learned contact styles
  app.get('/api/settings/contact-styles', { preHandler: [authenticate] }, async (request) => {
    const styles = await app.prisma.contactStyle.findMany({
      where: { userId: request.user.userId },
      orderBy: { updatedAt: 'desc' },
    });

    return { data: styles };
  });

  // Update or create a contact style override
  app.put(
    '/api/settings/contact-styles/:contactEmail',
    { preHandler: [authenticate] },
    async (request) => {
      const { contactEmail } = request.params as { contactEmail: string };
      const { contactName, tone, verbosity, greetingStyle, signOffStyle, notes } =
        request.body as {
          contactName?: string;
          tone?: number;
          verbosity?: number;
          greetingStyle?: string;
          signOffStyle?: string;
          notes?: string;
        };

      const style = await app.prisma.contactStyle.upsert({
        where: {
          userId_contactEmail: {
            userId: request.user.userId,
            contactEmail,
          },
        },
        create: {
          userId: request.user.userId,
          contactEmail,
          contactName,
          tone,
          verbosity,
          greetingStyle,
          signOffStyle,
          notes,
          isAutoLearned: false,
        },
        update: {
          ...(contactName !== undefined && { contactName }),
          ...(tone !== undefined && { tone }),
          ...(verbosity !== undefined && { verbosity }),
          ...(greetingStyle !== undefined && { greetingStyle }),
          ...(signOffStyle !== undefined && { signOffStyle }),
          ...(notes !== undefined && { notes }),
          isAutoLearned: false,
        },
      });

      return { data: style };
    },
  );

  // List learned style corrections
  app.get('/api/settings/style-corrections', { preHandler: [authenticate] }, async (request) => {
    const { limit = '20', offset = '0' } = request.query as { limit?: string; offset?: string };
    const take = Math.min(Number(limit) || 20, 100);
    const skip = Number(offset) || 0;

    const [corrections, totalCount] = await Promise.all([
      app.prisma.styleCorrection.findMany({
        where: { userId: request.user.userId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          category: true,
          summary: true,
          contactEmail: true,
          originalText: true,
          editedText: true,
          createdAt: true,
        },
      }),
      app.prisma.styleCorrection.count({
        where: { userId: request.user.userId },
      }),
    ]);

    // Truncate text fields for the list view
    const data = corrections.map((c) => ({
      ...c,
      originalText: c.originalText.slice(0, 200),
      editedText: c.editedText.slice(0, 200),
    }));

    return { data: { corrections: data, totalCount } };
  });

  // Delete a single style correction
  app.delete(
    '/api/settings/style-corrections/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const deleted = await app.prisma.styleCorrection.deleteMany({
        where: { id, userId: request.user.userId },
      });

      if (deleted.count === 0) {
        return reply.status(404).send({ error: 'Correction not found' });
      }

      return { data: { deleted: true } };
    },
  );

  // Delete a contact style
  app.delete(
    '/api/settings/contact-styles/:contactEmail',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { contactEmail } = request.params as { contactEmail: string };

      await app.prisma.contactStyle.deleteMany({
        where: {
          userId: request.user.userId,
          contactEmail,
        },
      });

      return reply.status(204).send();
    },
  );
}
