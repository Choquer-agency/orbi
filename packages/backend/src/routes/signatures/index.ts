import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';

type SignatureRow = {
  id: string;
  name: string;
  bodyHtml: string;
  isDefault: boolean;
  accountIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

async function shape(app: FastifyInstance, sig: SignatureRow) {
  const accountId = sig.accountIds[0] ?? null;
  const account = accountId
    ? await app.prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, email: true, displayName: true },
      })
    : null;
  return { ...sig, accountId, account };
}

export default async function signatureRoutes(app: FastifyInstance) {
  app.get('/api/signatures', { preHandler: [authenticate] }, async (request) => {
    const signatures = await app.prisma.signature.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'asc' },
    });
    const data = await Promise.all(signatures.map((s) => shape(app, s)));
    return { data };
  });

  app.post('/api/signatures', { preHandler: [authenticate] }, async (request) => {
    const { name, bodyHtml, isDefault, accountId } = request.body as {
      name: string;
      bodyHtml: string;
      isDefault?: boolean;
      accountId?: string | null;
    };

    const accountIds = accountId ? [accountId] : [];

    if (isDefault) {
      const peers = await app.prisma.signature.findMany({
        where: { userId: request.user.userId, isDefault: true },
        select: { id: true, accountIds: true },
      });
      const peerIds = peers
        .filter((p) =>
          accountId ? p.accountIds.includes(accountId) : p.accountIds.length === 0,
        )
        .map((p) => p.id);
      if (peerIds.length > 0) {
        await app.prisma.signature.updateMany({
          where: { id: { in: peerIds } },
          data: { isDefault: false },
        });
      }
    }

    const signature = await app.prisma.signature.create({
      data: {
        userId: request.user.userId,
        name,
        bodyHtml,
        isDefault: isDefault || false,
        accountIds,
      },
    });

    return { data: await shape(app, signature) };
  });

  app.patch('/api/signatures/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      name?: string;
      bodyHtml?: string;
      isDefault?: boolean;
      accountId?: string | null;
    };

    const signature = await app.prisma.signature.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!signature) {
      return reply.status(404).send({ error: 'Signature not found' });
    }

    const targetAccountId =
      updates.accountId !== undefined ? updates.accountId : signature.accountIds[0] ?? null;

    if (updates.isDefault) {
      const peers = await app.prisma.signature.findMany({
        where: { userId: request.user.userId, isDefault: true, NOT: { id } },
        select: { id: true, accountIds: true },
      });
      const peerIds = peers
        .filter((p) =>
          targetAccountId
            ? p.accountIds.includes(targetAccountId)
            : p.accountIds.length === 0,
        )
        .map((p) => p.id);
      if (peerIds.length > 0) {
        await app.prisma.signature.updateMany({
          where: { id: { in: peerIds } },
          data: { isDefault: false },
        });
      }
    }

    const { accountId: _accountId, ...rest } = updates;
    const updated = await app.prisma.signature.update({
      where: { id },
      data: {
        ...rest,
        ...(updates.accountId !== undefined && {
          accountIds: updates.accountId ? [updates.accountId] : [],
        }),
      },
    });

    return { data: await shape(app, updated) };
  });

  app.delete('/api/signatures/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const signature = await app.prisma.signature.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!signature) {
      return reply.status(404).send({ error: 'Signature not found' });
    }

    await app.prisma.signature.delete({ where: { id } });
    return { data: { success: true } };
  });
}
