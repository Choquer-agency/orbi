import type { FastifyInstance } from 'fastify';
import { AuthService } from './auth.service.js';
import { loginSchema, registerSchema } from './auth.schema.js';
import { authenticate } from '../../middleware/authenticate.js';

export default async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app.prisma);

  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await authService.login(input);
    const token = app.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      { expiresIn: '7d' },
    );
    return { data: { user, token } };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const user = await authService.register(input);
    const token = app.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      { expiresIn: '7d' },
    );
    return { data: { user, token } };
  });

  app.get('/api/auth/me', { preHandler: [authenticate] }, async (request) => {
    const user = await authService.getUser(request.user.userId);
    return { data: user };
  });
}
