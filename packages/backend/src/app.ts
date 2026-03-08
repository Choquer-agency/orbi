import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
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

  // Plugins
  await app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  await app.register(prismaPlugin);
  await app.register(redisPlugin);

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

  // Health check
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
}
