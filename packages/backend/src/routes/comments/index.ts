import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { createNotificationIfAllowed } from '../../services/notifications.js';
import { emitCommentsUpdated } from '../../services/socket-events.js';

// Extract user IDs from TipTap mention markup
function extractMentionIds(html: string): string[] {
  const regex = /data-mention-id="([^"]+)"/g;
  const ids: string[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export default async function commentRoutes(app: FastifyInstance) {
  // List comments for a thread
  app.get('/api/threads/:threadId/comments', { preHandler: [authenticate] }, async (request) => {
    const { threadId } = request.params as { threadId: string };

    const comments = await app.prisma.threadComment.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        mentions: {
          include: {
            mentionedUser: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        reactions: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    return { data: comments };
  });

  // Add comment
  app.post(
    '/api/threads/:threadId/comments',
    { preHandler: [authenticate] },
    async (request) => {
      const { threadId } = request.params as { threadId: string };
      const { bodyHtml, bodyText } = request.body as { bodyHtml: string; bodyText: string };

      const mentionedUserIds = extractMentionIds(bodyHtml);

      const comment = await app.prisma.$transaction(async (tx) => {
        // Create the comment
        const newComment = await tx.threadComment.create({
          data: {
            threadId,
            authorId: request.user.userId,
            bodyHtml,
            bodyText,
          },
          include: {
            author: { select: { id: true, name: true, avatarUrl: true } },
          },
        });

        // Create mentions and grant thread access
        for (const userId of mentionedUserIds) {
          await tx.threadMention.create({
            data: {
              commentId: newComment.id,
              threadId,
              mentionedUserId: userId,
            },
          });

          // Grant access to the mentioned user
          await tx.threadAccess.upsert({
            where: {
              threadId_userId: { threadId, userId },
            },
            update: {},
            create: {
              threadId,
              userId,
              accessLevel: 'COLLABORATOR',
            },
          });

        }

        return newComment;
      });

      // Create notifications outside transaction (best-effort) with real-time push
      for (const userId of mentionedUserIds) {
        await createNotificationIfAllowed(
          app.prisma,
          {
            userId,
            type: 'MENTION',
            title: `${comment.author.name} mentioned you`,
            body: bodyText.slice(0, 200),
            data: { threadId, commentId: comment.id },
          },
          app.io,
        );
      }

      // Emit real-time comment update to author + mentioned users
      emitCommentsUpdated(app.io, [request.user.userId, ...mentionedUserIds], threadId);

      return { data: comment };
    },
  );

  // Edit comment
  app.patch('/api/comments/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { bodyHtml, bodyText } = request.body as { bodyHtml: string; bodyText: string };

    const comment = await app.prisma.threadComment.findFirst({
      where: { id, authorId: request.user.userId },
    });

    if (!comment) {
      return reply.status(404).send({ error: 'Comment not found' });
    }

    const updated = await app.prisma.threadComment.update({
      where: { id },
      data: { bodyHtml, bodyText, isEdited: true, editedAt: new Date() },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    emitCommentsUpdated(app.io, request.user.userId, comment.threadId);

    return { data: updated };
  });

  // Delete comment
  app.delete('/api/comments/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const comment = await app.prisma.threadComment.findFirst({
      where: { id, authorId: request.user.userId },
    });

    if (!comment) {
      return reply.status(404).send({ error: 'Comment not found' });
    }

    await app.prisma.threadComment.delete({ where: { id } });

    emitCommentsUpdated(app.io, request.user.userId, comment.threadId);

    return { data: { success: true } };
  });

  // Resolve comment
  app.post(
    '/api/comments/:id/resolve',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const comment = await app.prisma.threadComment.findUnique({ where: { id } });
      if (!comment) {
        return reply.status(404).send({ error: 'Comment not found' });
      }

      const updated = await app.prisma.threadComment.update({
        where: { id },
        data: {
          isResolved: !comment.isResolved,
          resolvedBy: comment.isResolved ? null : request.user.userId,
          resolvedAt: comment.isResolved ? null : new Date(),
        },
      });

      emitCommentsUpdated(app.io, request.user.userId, comment.threadId);

      return { data: updated };
    },
  );

  // Add reaction
  app.post(
    '/api/comments/:id/reactions',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { emoji } = request.body as { emoji: string };

      const comment = await app.prisma.threadComment.findUnique({ where: { id }, select: { threadId: true } });
      if (!comment) {
        return reply.status(404).send({ error: 'Comment not found' });
      }

      const reaction = await app.prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: id,
            userId: request.user.userId,
            emoji,
          },
        },
        update: {},
        create: {
          commentId: id,
          userId: request.user.userId,
          emoji,
        },
      });

      emitCommentsUpdated(app.io, request.user.userId, comment.threadId);

      return { data: reaction };
    },
  );

  // Remove reaction
  app.delete(
    '/api/comments/:id/reactions/:emoji',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id, emoji } = request.params as { id: string; emoji: string };

      const comment = await app.prisma.threadComment.findUnique({ where: { id }, select: { threadId: true } });

      await app.prisma.commentReaction.deleteMany({
        where: {
          commentId: id,
          userId: request.user.userId,
          emoji,
        },
      });

      if (comment) {
        emitCommentsUpdated(app.io, request.user.userId, comment.threadId);
      }

      return { data: { success: true } };
    },
  );
}
