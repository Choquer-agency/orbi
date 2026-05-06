import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}

export default fp(async function socketPlugin(app: FastifyInstance) {
  const allowedOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : [env.FRONTEND_URL];

  const io = new Server(app.server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  // Authenticate socket connections using JWT
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const payload = app.jwt.verify<{ userId: string; email: string; role: string }>(token);
      socket.data.userId = payload.userId;
      socket.data.email = payload.email;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // Join user-specific room on connection
  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);
    app.log.info(`Socket connected: user ${userId}`);

    socket.on('disconnect', () => {
      app.log.info(`Socket disconnected: user ${userId}`);
    });
  });

  app.decorate('io', io);

  // Close Socket.io on server shutdown
  app.addHook('onClose', async () => {
    io.close();
  });
});
