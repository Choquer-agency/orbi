import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { DraftAssistant } from '../../services/ai/draft-assistant.js';
import { ChatAssistant } from '../../services/ai/chat-assistant.js';

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
      userId: request.user.userId,
    });

    return { data: result };
  });

  app.post('/api/ai/chat', { preHandler: [authenticate] }, async (request, reply) => {
    const { message, messages, threadId, accountId, scope, composeContext } = request.body as {
      message: string;
      messages?: { role: 'user' | 'assistant'; content: string }[];
      threadId?: string | null;
      accountId?: string | null;
      scope?: 'thread' | 'all';
      composeContext?: { to: string; subject: string; body: string; mode: string; threadId?: string };
    };

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    const chatAssistant = new ChatAssistant(app.prisma);
    const result = await chatAssistant.chat({
      messages: [...(messages || []), { role: 'user', content: message.trim() }],
      threadId: threadId || null,
      accountId: accountId || null,
      userId: request.user.userId,
      scope: scope || 'thread',
      composeContext,
    });

    return { data: result };
  });

  app.post('/api/ai/chat/stream', { preHandler: [authenticate] }, async (request, reply) => {
    const { message, messages, threadId, accountId, scope, composeContext } = request.body as {
      message: string;
      messages?: { role: 'user' | 'assistant'; content: string }[];
      threadId?: string | null;
      accountId?: string | null;
      scope?: 'thread' | 'all';
      composeContext?: { to: string; subject: string; body: string; mode: string; threadId?: string };
    };

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    const chatAssistant = new ChatAssistant(app.prisma);

    // Hijack the response so Fastify doesn't interfere with raw SSE writing
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const stream = chatAssistant.chatStream({
        messages: [...(messages || []), { role: 'user', content: message.trim() }],
        threadId: threadId || null,
        accountId: accountId || null,
        userId: request.user.userId,
        scope: scope || 'thread',
        composeContext,
      });

      for await (const event of stream) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      app.log.error(err, 'AI chat stream error');
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', data: { message: 'Stream error' } })}\n\n`);
    }

    reply.raw.end();
  });
}
