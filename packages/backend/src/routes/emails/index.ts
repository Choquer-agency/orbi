import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

export default async function emailRoutes(app: FastifyInstance) {
  // Get single email
  app.get('/api/emails/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const email = await app.prisma.email.findUnique({
      where: { id },
      include: { attachments: true },
    });

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    return { data: email };
  });

  // Send new email
  app.post('/api/emails/send', { preHandler: [authenticate] }, async (request, reply) => {
    const { accountId, to, cc, bcc, subject, bodyHtml, bodyText } = request.body as {
      accountId: string;
      to: { email: string; name?: string }[];
      cc?: { email: string; name?: string }[];
      bcc?: { email: string; name?: string }[];
      subject: string;
      bodyHtml: string;
      bodyText: string;
    };

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, userId: request.user.userId },
    });

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    // TODO: Send via provider API (Gmail API / Graph API / SMTP)
    // For now, return a placeholder
    return { data: { message: 'Email sending will be implemented with provider integration' } };
  });

  // Reply to email
  app.post('/api/emails/:id/reply', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId, bodyHtml, bodyText, replyAll } = request.body as {
      accountId: string;
      bodyHtml: string;
      bodyText: string;
      replyAll?: boolean;
    };

    const email = await app.prisma.email.findUnique({
      where: { id },
      include: { thread: true },
    });

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    // TODO: Send reply via provider API
    return { data: { message: 'Reply will be implemented with provider integration' } };
  });

  // Forward email
  app.post('/api/emails/:id/forward', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { accountId, to, bodyHtml, bodyText } = request.body as {
      accountId: string;
      to: { email: string; name?: string }[];
      bodyHtml: string;
      bodyText: string;
    };

    const email = await app.prisma.email.findUnique({ where: { id } });

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    // TODO: Forward via provider API
    return { data: { message: 'Forward will be implemented with provider integration' } };
  });

  // Download attachment
  app.get(
    '/api/emails/:emailId/attachments/:attachmentId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { emailId, attachmentId } = request.params as {
        emailId: string;
        attachmentId: string;
      };

      const attachment = await app.prisma.attachment.findFirst({
        where: { id: attachmentId, emailId },
      });

      if (!attachment) {
        return reply.status(404).send({ error: 'Attachment not found' });
      }

      // TODO: Download from provider API on-demand
      return { data: { message: 'Attachment download will be implemented with provider integration' } };
    },
  );
}
