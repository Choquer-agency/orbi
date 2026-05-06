import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { TokenManager } from '../../services/oauth/token-manager.js';
import { getGmailAuthUrl, exchangeGmailCode } from '../../services/oauth/gmail-oauth.js';
import {
  getMicrosoftAuthUrl,
  exchangeMicrosoftCode,
} from '../../services/oauth/microsoft-oauth.js';
import { addGmailSyncJob } from '../../queues/gmail-sync.queue.js';
import { addGmailHistoricalSyncJob } from '../../queues/gmail-historical-sync.queue.js';
import { addMicrosoftSyncJob } from '../../queues/microsoft-sync.queue.js';
import { addMicrosoftHistoricalSyncJob } from '../../queues/microsoft-historical-sync.queue.js';
import { env } from '../../config/env.js';

export default async function accountRoutes(app: FastifyInstance) {
  const tokenManager = new TokenManager(app.prisma);

  // List connected accounts
  app.get('/api/accounts', { preHandler: [authenticate] }, async (request) => {
    const accounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: {
        id: true,
        provider: true,
        email: true,
        displayName: true,
        isActive: true,
        lastSyncAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { data: accounts };
  });

  // Gmail OAuth: initiate
  app.get('/api/accounts/oauth/gmail', { preHandler: [authenticate] }, async (request, reply) => {
    const { platform, desktop } = request.query as { platform?: string; desktop?: string };
    const resolvedPlatform = platform || (desktop === 'true' ? 'desktop' : 'web');
    const state = app.jwt.sign({
      userId: request.user.userId,
      platform: resolvedPlatform,
    } as any);
    const url = getGmailAuthUrl(state);
    return { data: { url } };
  });

  // Gmail OAuth: callback
  app.get('/api/accounts/oauth/gmail/callback', async (request, reply) => {
    const { code, state } = request.query as { code: string; state: string };

    let payload: { userId: string; platform: string; desktop?: boolean };
    try {
      payload = app.jwt.verify<{ userId: string; platform: string; desktop?: boolean }>(state);
    } catch {
      return reply.status(400).send({ error: 'Invalid state parameter' });
    }

    const result = await exchangeGmailCode(code);

    await app.prisma.account.upsert({
      where: {
        provider_email: { provider: 'GMAIL', email: result.email },
      },
      update: {
        accessToken: tokenManager.encryptToken(result.accessToken),
        refreshToken: result.refreshToken
          ? tokenManager.encryptToken(result.refreshToken)
          : undefined,
        tokenExpiry: result.tokenExpiry,
        displayName: result.displayName,
        isActive: true,
      },
      create: {
        userId: payload.userId,
        provider: 'GMAIL',
        email: result.email,
        displayName: result.displayName,
        accessToken: tokenManager.encryptToken(result.accessToken),
        refreshToken: result.refreshToken
          ? tokenManager.encryptToken(result.refreshToken)
          : null,
        tokenExpiry: result.tokenExpiry,
        scopes: result.scopes,
      },
    });

    // Trigger initial sync after connecting Gmail
    const connectedAccount = await app.prisma.account.findFirst({
      where: { provider: 'GMAIL', email: result.email },
      select: { id: true },
    });
    if (connectedAccount) {
      addGmailSyncJob({ accountId: connectedAccount.id, maxResults: 100 }).catch(() => {});
    }

    const plat = payload.platform || (payload.desktop ? 'desktop' : 'web');
    if (plat === 'desktop' || plat === 'capacitor') {
      return reply.redirect(`orbi-mail://oauth/callback?provider=gmail&success=true`);
    }
    return reply.redirect(`${env.FRONTEND_URL}/oauth/callback?provider=gmail&success=true`);
  });

  // Microsoft OAuth: initiate
  app.get(
    '/api/accounts/oauth/microsoft',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { platform, desktop } = request.query as { platform?: string; desktop?: string };
      const resolvedPlatform = platform || (desktop === 'true' ? 'desktop' : 'web');
      const state = app.jwt.sign({
        userId: request.user.userId,
        platform: resolvedPlatform,
      } as any);
      const url = getMicrosoftAuthUrl(state);
      return { data: { url } };
    },
  );

  // Microsoft OAuth: callback
  app.get('/api/accounts/oauth/microsoft/callback', async (request, reply) => {
    const { code, state } = request.query as { code: string; state: string };

    let payload: { userId: string; platform: string; desktop?: boolean };
    try {
      payload = app.jwt.verify<{ userId: string; platform: string; desktop?: boolean }>(state);
    } catch {
      return reply.status(400).send({ error: 'Invalid state parameter' });
    }

    const result = await exchangeMicrosoftCode(code);

    await app.prisma.account.upsert({
      where: {
        provider_email: { provider: 'MICROSOFT', email: result.email },
      },
      update: {
        accessToken: tokenManager.encryptToken(result.accessToken),
        refreshToken: result.refreshToken
          ? tokenManager.encryptToken(result.refreshToken)
          : undefined,
        tokenExpiry: result.tokenExpiry,
        displayName: result.displayName,
        isActive: true,
      },
      create: {
        userId: payload.userId,
        provider: 'MICROSOFT',
        email: result.email,
        displayName: result.displayName,
        accessToken: tokenManager.encryptToken(result.accessToken),
        refreshToken: result.refreshToken
          ? tokenManager.encryptToken(result.refreshToken)
          : null,
        tokenExpiry: result.tokenExpiry,
        scopes: result.scopes,
      },
    });

    // Trigger initial sync after connecting Microsoft
    const connectedMsAccount = await app.prisma.account.findFirst({
      where: { provider: 'MICROSOFT', email: result.email },
      select: { id: true },
    });
    if (connectedMsAccount) {
      addMicrosoftSyncJob({ accountId: connectedMsAccount.id, maxResults: 100 }).catch(() => {});
    }

    const msPlat = payload.platform || (payload.desktop ? 'desktop' : 'web');
    if (msPlat === 'desktop' || msPlat === 'capacitor') {
      return reply.redirect(`orbi-mail://oauth/callback?provider=microsoft&success=true`);
    }
    return reply.redirect(`${env.FRONTEND_URL}/oauth/callback?provider=microsoft&success=true`);
  });

  // IMAP account: manual setup
  app.post('/api/accounts/imap', { preHandler: [authenticate] }, async (request) => {
    const { email, displayName, host, port, username, password, smtpHost, smtpPort } =
      request.body as {
        email: string;
        displayName?: string;
        host: string;
        port: number;
        username: string;
        password: string;
        smtpHost: string;
        smtpPort: number;
      };

    const imapConfig = JSON.stringify({ host, port, username, smtpHost, smtpPort });

    const account = await app.prisma.account.create({
      data: {
        userId: request.user.userId,
        provider: 'APPLE_IMAP',
        email,
        displayName: displayName || null,
        accessToken: tokenManager.encryptToken(password),
        syncCursor: imapConfig, // store IMAP config in syncCursor for now
        scopes: [],
      },
    });

    return {
      data: {
        id: account.id,
        provider: account.provider,
        email: account.email,
        displayName: account.displayName,
      },
    };
  });

  // Update account (rename / set display name)
  app.patch('/api/accounts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { displayName } = request.body as { displayName?: string };

    const account = await app.prisma.account.findFirst({
      where: { id, userId: request.user.userId },
    });
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    const updated = await app.prisma.account.update({
      where: { id },
      data: { displayName: displayName || null },
      select: { id: true, provider: true, email: true, displayName: true, isActive: true },
    });

    return { data: updated };
  });

  // Delete account
  app.delete('/api/accounts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const account = await app.prisma.account.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    await app.prisma.account.delete({ where: { id } });
    return { data: { success: true } };
  });

  // Trigger manual sync
  app.post('/api/accounts/:id/sync', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const account = await app.prisma.account.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    if (account.provider === 'GMAIL') {
      await addGmailSyncJob({ accountId: account.id });
    } else if (account.provider === 'MICROSOFT') {
      await addMicrosoftSyncJob({ accountId: account.id });
    }
    return { data: { message: 'Sync queued', provider: account.provider } };
  });

  // Trigger full historical sync
  app.post(
    '/api/accounts/:id/historical-sync',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const account = await app.prisma.account.findFirst({
        where: { id, userId: request.user.userId },
      });

      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      if (account.provider !== 'GMAIL' && account.provider !== 'MICROSOFT') {
        return reply.status(400).send({ error: 'Historical sync is only supported for Gmail and Microsoft accounts' });
      }

      if (account.historicalSyncStatus === 'IN_PROGRESS') {
        return reply.status(409).send({ error: 'Historical sync already in progress' });
      }

      if (account.provider === 'GMAIL') {
        await addGmailHistoricalSyncJob({ accountId: account.id });
      } else {
        await addMicrosoftHistoricalSyncJob({ accountId: account.id });
      }
      return { data: { message: 'Historical sync started' } };
    },
  );

  // Get sync status for an account
  app.get(
    '/api/accounts/:id/sync-status',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const account = await app.prisma.account.findFirst({
        where: { id, userId: request.user.userId },
        select: {
          historicalSyncStatus: true,
          historicalSyncProgress: true,
          historicalSyncCompletedAt: true,
          lastSyncAt: true,
        },
      });

      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      return { data: account };
    },
  );
}
