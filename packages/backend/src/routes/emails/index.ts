import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { addPendingSendJob, removePendingSendJob } from '../../queues/pending-send.queue.js';
import { addSendJob } from '../../queues/email-send.queue.js';
import { downloadGmailAttachment } from '../../services/gmail/gmail-sync.js';
import { downloadMicrosoftAttachment } from '../../services/microsoft/microsoft-sync.js';
import { emitThreadsUpdated } from '../../services/socket-events.js';

const MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB Gmail limit

interface UploadedFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

async function parseComposeMultipart(request: FastifyRequest) {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      files.push({ filename: part.filename, mimeType: part.mimetype, buffer });
    } else {
      fields[part.fieldname] = part.value as string;
    }
  }

  // Validate total attachment size
  const totalSize = files.reduce((sum, f) => sum + f.buffer.length, 0);
  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    throw new Error(`Total attachment size (${Math.round(totalSize / 1024 / 1024)}MB) exceeds 25MB limit`);
  }

  return {
    fields: {
      accountId: fields.accountId,
      to: fields.to ? JSON.parse(fields.to) : undefined,
      cc: fields.cc ? JSON.parse(fields.cc) : undefined,
      bcc: fields.bcc ? JSON.parse(fields.bcc) : undefined,
      subject: fields.subject,
      bodyHtml: fields.bodyHtml,
      bodyText: fields.bodyText,
      undoWindowSeconds: fields.undoWindowSeconds ? Number(fields.undoWindowSeconds) : undefined,
      replyAll: fields.replyAll === 'true',
    },
    files,
  };
}

function isMultipart(request: FastifyRequest): boolean {
  const ct = request.headers['content-type'] || '';
  return ct.includes('multipart/form-data');
}

export default async function emailRoutes(app: FastifyInstance) {
  /** Verify the email belongs to an account owned by the requesting user */
  async function verifyEmailOwnership(
    emailId: string,
    userId: string,
    include?: Record<string, any>,
  ) {
    const email = await app.prisma.email.findUnique({
      where: { id: emailId },
      include: { account: { select: { userId: true } }, ...include },
    });
    if (!email || email.account.userId !== userId) return null;
    return email;
  }

  // Get single email
  app.get('/api/emails/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const email = await verifyEmailOwnership(id, request.user.userId, { attachments: true });

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    return { data: email };
  });

  // Update a pending email (for editing during undo window)
  app.patch('/api/emails/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      bodyText?: string;
      bodyHtml?: string;
      snippet?: string;
      subject?: string;
      toAddresses?: any;
    };

    const email = await verifyEmailOwnership(id, request.user.userId);
    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    // Only allow editing if still in PENDING_SEND
    if (email.sendStatus !== 'PENDING_SEND') {
      return reply.status(400).send({ error: 'Can only edit emails that are pending send' });
    }

    const updated = await app.prisma.email.update({
      where: { id },
      data: updates,
    });

    return { data: updated };
  });

  // Send new email (always with undo window)
  app.post('/api/emails/send', { preHandler: [authenticate] }, async (request, reply) => {
    let accountId: string, to: any[], cc: any[] | undefined, bcc: any[] | undefined;
    let subject: string, bodyHtml: string, bodyText: string, undoWindowSeconds: number;
    let uploadedFiles: UploadedFile[] = [];

    if (isMultipart(request)) {
      const { fields, files } = await parseComposeMultipart(request);
      accountId = fields.accountId;
      to = fields.to;
      cc = fields.cc;
      bcc = fields.bcc;
      subject = fields.subject;
      bodyHtml = fields.bodyHtml;
      bodyText = fields.bodyText;
      undoWindowSeconds = fields.undoWindowSeconds ?? 60;
      uploadedFiles = files;
    } else {
      const body = request.body as any;
      accountId = body.accountId;
      to = body.to;
      cc = body.cc;
      bcc = body.bcc;
      subject = body.subject;
      bodyHtml = body.bodyHtml;
      bodyText = body.bodyText;
      undoWindowSeconds = body.undoWindowSeconds ?? 60;
    }

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, userId: request.user.userId },
    });

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    const now = new Date();
    const undoDeadlineAt = new Date(now.getTime() + undoWindowSeconds * 1000);

    // Create thread + email + attachments atomically
    const { email } = await app.prisma.$transaction(async (tx) => {
      const thread = await tx.thread.create({
        data: {
          accountId: account.id,
          providerThreadId: `local-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          subject,
          snippet: (bodyText || '').slice(0, 200),
          isRead: true,
          labels: ['SENT'],
          participantEmails: [account.email, ...to.map((a: any) => a.email)],
          messageCount: 1,
          lastMessageAt: now,
        },
      });

      const email = await tx.email.create({
        data: {
          accountId: account.id,
          threadId: thread.id,
          providerMessageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fromAddress: account.email,
          fromName: account.displayName || account.email.split('@')[0],
          toAddresses: to,
          ccAddresses: cc || [],
          bccAddresses: bcc || [],
          subject,
          bodyText,
          bodyHtml,
          snippet: (bodyText || '').slice(0, 200),
          isRead: true,
          labels: ['SENT'],
          receivedAt: now,
          sentAt: now,
          sendStatus: 'PENDING_SEND',
          undoDeadlineAt,
          hasAttachments: uploadedFiles.length > 0,
        },
      });

      // Create attachment records with file content
      for (const file of uploadedFiles) {
        await tx.attachment.create({
          data: {
            emailId: email.id,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.buffer.length,
            content: new Uint8Array(file.buffer),
          },
        });
      }

      return { thread, email };
    });

    // Delayed send — goes through pending-send worker after undo window
    try {
      await addPendingSendJob(email.id, account.id, undoWindowSeconds * 1000);
    } catch (err) {
      await app.prisma.email.update({
        where: { id: email.id },
        data: { sendStatus: 'FAILED', sendError: 'Failed to queue email for sending' },
      });
      return reply.status(503).send({ error: 'Email saved but failed to queue for sending. Please retry.' });
    }

    emitThreadsUpdated(app.io, request.user.userId);

    return { data: email };
  });

  // Reply to email
  app.post('/api/emails/:id/reply', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let accountId: string, bodyHtml: string, bodyText: string;
    let cc: any[] | undefined, bcc: any[] | undefined, undoWindowSeconds: number | undefined;
    let uploadedFiles: UploadedFile[] = [];

    if (isMultipart(request)) {
      const { fields, files } = await parseComposeMultipart(request);
      accountId = fields.accountId;
      bodyHtml = fields.bodyHtml;
      bodyText = fields.bodyText;
      cc = fields.cc;
      bcc = fields.bcc;
      undoWindowSeconds = fields.undoWindowSeconds;
      uploadedFiles = files;
    } else {
      const body = request.body as any;
      accountId = body.accountId;
      bodyHtml = body.bodyHtml;
      bodyText = body.bodyText;
      cc = body.cc;
      bcc = body.bcc;
      undoWindowSeconds = body.undoWindowSeconds;
    }

    const parentEmail = await app.prisma.email.findUnique({
      where: { id },
      include: { thread: true },
    });

    if (!parentEmail) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    // Look up the sending account
    const account = await app.prisma.account.findFirst({
      where: { id: accountId, userId: request.user.userId },
    });
    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    // Build recipient list (reply to sender of parent email)
    const toAddresses = [{ email: parentEmail.fromAddress, name: parentEmail.fromName || undefined }];

    const now = new Date();
    const useUndo = undoWindowSeconds && undoWindowSeconds > 0;
    const undoDeadlineAt = useUndo
      ? new Date(now.getTime() + undoWindowSeconds! * 1000)
      : null;

    // Create the reply email record + attachments in a transaction
    const replyEmail = await app.prisma.$transaction(async (tx) => {
      const replyEmail = await tx.email.create({
        data: {
          accountId: account.id,
          threadId: parentEmail.threadId,
          providerMessageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          inReplyTo: parentEmail.internetMessageId || parentEmail.providerMessageId,
          fromAddress: account.email,
          fromName: account.displayName || account.email.split('@')[0],
          toAddresses,
          ccAddresses: cc || [],
          bccAddresses: bcc || [],
          subject: parentEmail.subject.startsWith('Re:')
            ? parentEmail.subject
            : `Re: ${parentEmail.subject}`,
          bodyText,
          bodyHtml: bodyHtml || `<p>${bodyText.replace(/\n/g, '<br/>')}</p>`,
          snippet: (bodyText || '').slice(0, 200),
          isRead: true,
          labels: ['SENT'],
          receivedAt: now,
          sentAt: now,
          sendStatus: useUndo ? 'PENDING_SEND' : 'SENDING',
          undoDeadlineAt,
          hasAttachments: uploadedFiles.length > 0,
        },
        include: { attachments: true },
      });

      for (const file of uploadedFiles) {
        await tx.attachment.create({
          data: {
            emailId: replyEmail.id,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.buffer.length,
            content: new Uint8Array(file.buffer),
          },
        });
      }

      return replyEmail;
    });

    // Update thread snippet to reflect the latest message
    await app.prisma.thread.update({
      where: { id: parentEmail.threadId },
      data: { snippet: (bodyText || '').slice(0, 200) },
    });

    // If undo enabled, enqueue a delayed job; otherwise send immediately
    try {
      if (useUndo) {
        await addPendingSendJob(replyEmail.id, account.id, undoWindowSeconds! * 1000);
      } else {
        await addSendJob({ emailId: replyEmail.id, accountId: account.id });
      }
    } catch (err) {
      await app.prisma.email.update({
        where: { id: replyEmail.id },
        data: { sendStatus: 'FAILED', sendError: 'Failed to queue email for sending' },
      });
      return reply.status(503).send({ error: 'Reply saved but failed to queue for sending. Please retry.' });
    }

    emitThreadsUpdated(app.io, request.user.userId, [parentEmail.threadId]);

    return { data: replyEmail };
  });

  // Undo a sent email (only during the undo window)
  app.post('/api/emails/:id/undo', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const email = await verifyEmailOwnership(id, request.user.userId);

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    if (email.sendStatus !== 'PENDING_SEND') {
      return reply.status(400).send({ error: 'Email cannot be undone — already sent or not pending' });
    }

    if (email.undoDeadlineAt && new Date() > email.undoDeadlineAt) {
      return reply.status(400).send({ error: 'Undo window has expired' });
    }

    // Remove the pending send job from the queue
    await removePendingSendJob(id);

    // Mark as undone
    const undoneEmail = await app.prisma.email.update({
      where: { id },
      data: {
        sendStatus: 'UNDONE',
        undoneAt: new Date(),
      },
    });

    return { data: undoneEmail };
  });

  // Send now — skip the undo window and send immediately
  app.post('/api/emails/:id/send-now', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const email = await verifyEmailOwnership(id, request.user.userId);

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    if (email.sendStatus !== 'PENDING_SEND') {
      return reply.status(400).send({ error: 'Email is not pending — cannot send now' });
    }

    // Remove the delayed pending-send job
    await removePendingSendJob(id);

    // Mark as SENT and clear the undo deadline
    await app.prisma.email.update({
      where: { id },
      data: { sendStatus: 'SENT', undoDeadlineAt: null },
    });

    // Queue for immediate send
    await addSendJob({ emailId: id, accountId: email.accountId });

    emitThreadsUpdated(app.io, request.user.userId, [email.threadId]);

    return { data: { success: true } };
  });

  // Forward email
  app.post('/api/emails/:id/forward', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let accountId: string, to: any[], bodyHtml: string, bodyText: string;
    let uploadedFiles: UploadedFile[] = [];

    if (isMultipart(request)) {
      const { fields, files } = await parseComposeMultipart(request);
      accountId = fields.accountId;
      to = fields.to;
      bodyHtml = fields.bodyHtml;
      bodyText = fields.bodyText;
      uploadedFiles = files;
    } else {
      const body = request.body as any;
      accountId = body.accountId;
      to = body.to;
      bodyHtml = body.bodyHtml;
      bodyText = body.bodyText;
    }

    const email = await verifyEmailOwnership(id, request.user.userId);

    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, userId: request.user.userId },
    });
    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    const undoWindowSeconds = 60;
    const now = new Date();
    const undoDeadlineAt = new Date(now.getTime() + undoWindowSeconds * 1000);

    const fwdEmail = await app.prisma.$transaction(async (tx) => {
      const fwdEmail = await tx.email.create({
        data: {
          accountId: account.id,
          threadId: email.threadId,
          providerMessageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          inReplyTo: email.internetMessageId || email.providerMessageId,
          fromAddress: account.email,
          fromName: account.displayName || account.email.split('@')[0],
          toAddresses: to,
          subject: email.subject.startsWith('Fwd:') ? email.subject : `Fwd: ${email.subject}`,
          bodyText,
          bodyHtml,
          snippet: (bodyText || '').slice(0, 200),
          isRead: true,
          labels: ['SENT'],
          receivedAt: now,
          sentAt: now,
          sendStatus: 'PENDING_SEND',
          undoDeadlineAt,
          hasAttachments: uploadedFiles.length > 0,
        },
      });

      for (const file of uploadedFiles) {
        await tx.attachment.create({
          data: {
            emailId: fwdEmail.id,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.buffer.length,
            content: new Uint8Array(file.buffer),
          },
        });
      }

      return fwdEmail;
    });

    try {
      await addPendingSendJob(fwdEmail.id, account.id, undoWindowSeconds * 1000);
    } catch (err) {
      await app.prisma.email.update({
        where: { id: fwdEmail.id },
        data: { sendStatus: 'FAILED', sendError: 'Failed to queue email for sending' },
      });
      return reply.status(503).send({ error: 'Forward saved but failed to queue for sending. Please retry.' });
    }

    emitThreadsUpdated(app.io, request.user.userId, [email.threadId]);

    return { data: fwdEmail };
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

      // Find the email's account to determine provider — verify ownership
      const email = await verifyEmailOwnership(emailId, request.user.userId);
      if (!email) {
        return reply.status(404).send({ error: 'Email not found' });
      }

      const account = await app.prisma.account.findUnique({ where: { id: email.accountId } });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      // Outgoing attachments stored locally (pre-send or unsent)
      if (attachment.content) {
        return reply
          .header('Content-Type', attachment.mimeType)
          .header('Content-Disposition', `attachment; filename="${attachment.filename}"`)
          .send(attachment.content);
      }

      if (account.provider === 'GMAIL' && attachment.providerAttachmentId) {
        const data = await downloadGmailAttachment(
          app.prisma,
          account.id,
          email.providerMessageId,
          attachment.providerAttachmentId,
        );
        return reply
          .header('Content-Type', attachment.mimeType)
          .header('Content-Disposition', `attachment; filename="${attachment.filename}"`)
          .send(data);
      }

      if (account.provider === 'MICROSOFT' && attachment.providerAttachmentId) {
        const data = await downloadMicrosoftAttachment(
          app.prisma,
          account.id,
          email.providerMessageId,
          attachment.providerAttachmentId,
        );
        return reply
          .header('Content-Type', attachment.mimeType)
          .header('Content-Disposition', `attachment; filename="${attachment.filename}"`)
          .send(data);
      }

      return reply.status(501).send({ error: 'Attachment download not implemented for this provider' });
    },
  );

  // Retry a failed email send
  app.post('/api/emails/:id/retry', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const email = await verifyEmailOwnership(id, request.user.userId);
    if (!email) {
      return reply.status(404).send({ error: 'Email not found' });
    }

    if (email.sendStatus !== 'FAILED') {
      return reply.status(400).send({ error: `Cannot retry — email status is ${email.sendStatus}` });
    }

    // Reset status and attempt count for a fresh retry
    await app.prisma.email.update({
      where: { id },
      data: {
        sendStatus: 'SENDING',
        sendError: null,
        sendAttempts: 0,
      },
    });

    await addSendJob({ emailId: id, accountId: email.accountId });

    return { data: { message: 'Retry queued' } };
  });

  // Get failed emails for the current user (for monitoring)
  app.get('/api/emails/failed', { preHandler: [authenticate] }, async (request) => {
    const accounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: { id: true },
    });

    const failed = await app.prisma.email.findMany({
      where: {
        accountId: { in: accounts.map((a) => a.id) },
        sendStatus: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        subject: true,
        toAddresses: true,
        sendError: true,
        sendAttempts: true,
        createdAt: true,
        threadId: true,
      },
    });

    return { data: failed };
  });
}
