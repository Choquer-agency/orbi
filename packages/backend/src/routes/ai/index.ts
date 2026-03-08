import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { DraftAssistant } from '../../services/ai/draft-assistant.js';

export default async function aiRoutes(app: FastifyInstance) {
  const draftAssistant = new DraftAssistant(app.prisma);

  app.post('/api/ai/draft', { preHandler: [authenticate] }, async (request, reply) => {
    const { instruction, threadId, accountId } = request.body as {
      instruction: string;
      threadId: string | null;
      accountId: string;
    };

    if (!instruction || instruction.trim().length === 0) {
      return reply.status(400).send({ error: 'Instruction is required' });
    }

    const result = await draftAssistant.generateDraft({
      instruction,
      threadId,
      accountId,
    });

    return { data: result };
  });
}
