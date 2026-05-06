import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth/index.js';
import userRoutes from './routes/users/index.js';
import accountRoutes from './routes/accounts/index.js';
import threadRoutes from './routes/threads/index.js';
import emailRoutes from './routes/emails/index.js';
import commentRoutes from './routes/comments/index.js';
import notificationRoutes from './routes/notifications/index.js';
import signatureRoutes from './routes/signatures/index.js';
import searchRoutes from './routes/search/index.js';
import aiRoutes from './routes/ai/index.js';
import learnRoutes from './routes/ai/learn.js';
import chatHistoryRoutes from './routes/ai/chat-history.js';
import writingPreferencesRoutes from './routes/settings/writing-preferences.js';
import dashboardRoutes from './routes/dashboard/index.js';
import scheduledEmailRoutes from './routes/scheduled-emails/index.js';
import classificationRoutes from './routes/classifications/index.js';
import followUpRoutes from './routes/follow-ups/index.js';
import trackingRoutes from './routes/tracking/index.js';
import meetingRoutes from './routes/meetings/index.js';
import handoffRoutes from './routes/handoffs/index.js';
import oooRoutes from './routes/ooo/index.js';
import contactRoutes from './routes/contacts/index.js';
import personRoutes from './routes/persons/index.js';
import triageRoutes from './routes/triage/index.js';
import trackingExclusionRoutes from './routes/settings/tracking-exclusions.js';
import notificationPreferencesRoutes from './routes/settings/notification-preferences.js';
import blockedSenderRoutes from './routes/blocked-senders/index.js';
import inboxSplitRoutes from './routes/settings/inbox-splits.js';
import aiFilterRoutes from './routes/ai-filters/index.js';
import snippetRoutes from './routes/snippets/index.js';
import draftRoutes from './routes/drafts/index.js';
import deviceRoutes from './routes/devices/index.js';
import pushHealthRoutes from './routes/devices/push-health.js';
import socketPlugin from './plugins/socket.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'info' : 'warn',
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // Error handler
  app.setErrorHandler(errorHandler);

  // CORS — support multiple origins for web, Electron, and Capacitor iOS
  const allowedOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : [env.FRONTEND_URL];

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server, packaged Electron via file://)
      if (!origin) return cb(null, true);
      // Packaged Electron loads from file:// — origin header may be "file://" or null
      if (origin === 'file://' || origin.startsWith('file://')) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);

  // Routes
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(accountRoutes);
  await app.register(threadRoutes);
  await app.register(emailRoutes);
  await app.register(commentRoutes);
  await app.register(notificationRoutes);
  await app.register(signatureRoutes);
  await app.register(searchRoutes);
  await app.register(aiRoutes);
  await app.register(learnRoutes);
  await app.register(chatHistoryRoutes);
  await app.register(writingPreferencesRoutes);
  await app.register(dashboardRoutes);
  await app.register(scheduledEmailRoutes);
  await app.register(classificationRoutes);
  await app.register(followUpRoutes);
  await app.register(trackingRoutes);
  await app.register(meetingRoutes);
  await app.register(handoffRoutes);
  await app.register(oooRoutes);
  await app.register(contactRoutes);
  await app.register(personRoutes);
  await app.register(triageRoutes);
  await app.register(trackingExclusionRoutes);
  await app.register(notificationPreferencesRoutes);
  await app.register(blockedSenderRoutes);
  await app.register(inboxSplitRoutes);
  await app.register(aiFilterRoutes);
  await app.register(snippetRoutes);
  await app.register(draftRoutes);
  await app.register(deviceRoutes);
  await app.register(pushHealthRoutes);

  // Health check
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
}
