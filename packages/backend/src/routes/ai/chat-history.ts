import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function chatHistoryRoutes(app: FastifyInstance) {
  // List conversations (most recent first)
  app.get(
    '/api/ai/conversations',
    { preHandler: [authenticate] },
    async (request) => {
      const conversations = await app.prisma.chatConversation.findMany({
        where: { userId: request.user.userId },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { content: true, role: true },
          },
        },
      });

      return {
        data: conversations.map((c) => ({
          id: c.id,
          title:
            c.title ||
            c.messages[0]?.content.slice(0, 80) ||
            'New conversation',
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      };
    },
  );

  // Get a specific conversation with all messages
  app.get(
    '/api/ai/conversations/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const conversation = await app.prisma.chatConversation.findFirst({
        where: { id, userId: request.user.userId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              role: true,
              content: true,
              metadata: true,
              createdAt: true,
            },
          },
        },
      });

      if (!conversation) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      return {
        data: {
          id: conversation.id,
          title: conversation.title,
          messages: conversation.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            ...(m.metadata as Record<string, unknown> || {}),
            createdAt: m.createdAt,
          })),
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
      };
    },
  );

  // Create a new conversation
  app.post(
    '/api/ai/conversations',
    { preHandler: [authenticate] },
    async (request) => {
      const { title } = (request.body as { title?: string }) || {};

      const conversation = await app.prisma.chatConversation.create({
        data: {
          userId: request.user.userId,
          title: title || null,
        },
      });

      return { data: { id: conversation.id } };
    },
  );

  // Save a message to a conversation
  app.post(
    '/api/ai/conversations/:id/messages',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { role, content, metadata } = request.body as {
        role: string;
        content: string;
        metadata?: Record<string, unknown>;
      };

      // Verify ownership
      const conversation = await app.prisma.chatConversation.findFirst({
        where: { id, userId: request.user.userId },
      });

      if (!conversation) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      const message = await app.prisma.chatMessage.create({
        data: {
          conversationId: id,
          role,
          content,
          metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
        },
      });

      // Auto-set title from first user message if not set
      if (!conversation.title && role === 'user') {
        await app.prisma.chatConversation.update({
          where: { id },
          data: { title: content.slice(0, 80) },
        });
      }

      // Touch updatedAt
      await app.prisma.chatConversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      return { data: { id: message.id } };
    },
  );

  // Delete a conversation
  app.delete(
    '/api/ai/conversations/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const conversation = await app.prisma.chatConversation.findFirst({
        where: { id, userId: request.user.userId },
      });

      if (!conversation) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      await app.prisma.chatConversation.delete({ where: { id } });

      return { data: { success: true } };
    },
  );
}
