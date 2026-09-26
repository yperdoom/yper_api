import bcrypt from 'bcryptjs';

import User, { APPS } from '../models/User.js';
import { signToken, requireAuth } from '../hooks/auth.js';
import { httpError } from '../lib/errors.js';
import { publicUser, hashPassword } from '../lib/users.js';
import usersRoutes from './users.routes.js';

const tokenFor = (user) =>
  signToken({ userId: user._id, email: user.email, apps: user.apps, role: user.role });

export default async function authRoutes(fastify) {
  /** Cria o primeiro usuario. So funciona enquanto a base estiver vazia. */
  fastify.post('/setup', async (request, reply) => {
    const count = await User.estimatedDocumentCount();
    if (count > 0) throw httpError(403, 'SETUP_ALREADY_DONE');

    const { name = '', email, password } = request.body || {};
    if (!email || !password) throw httpError(400, 'EMAIL_PASSWORD_REQUIRED');

    const user = await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      apps: [...APPS],
      role: 'admin',
    });

    return reply.code(201).send({
      user: publicUser(user),
      token: tokenFor(user),
    });
  });

  /** Informa ao frontend se a base ja tem usuario (usado pela tela de setup). */
  fastify.get('/status', async () => {
    const count = await User.estimatedDocumentCount();
    return { initialized: count > 0 };
  });

  fastify.post('/login', async (request) => {
    const { email, password, app } = request.body || {};
    if (!email || !password) throw httpError(400, 'EMAIL_PASSWORD_REQUIRED');

    const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
    if (!user) throw httpError(401, 'INVALID_CREDENTIALS');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw httpError(401, 'INVALID_CREDENTIALS');

    if (user.active === false) throw httpError(403, 'USER_INACTIVE');

    if (app && !user.apps.includes(app)) throw httpError(403, 'APP_FORBIDDEN', { app });

    return {
      user: publicUser(user),
      token: tokenFor(user),
    };
  });

  // Daqui para baixo tudo exige estar logado.
  fastify.register(async (secured) => {
    secured.addHook('onRequest', requireAuth);

    secured.get('/me', async (request) => {
      const user = await User.findById(request.user.userId);
      if (!user) throw httpError(401, 'UNAUTHORIZED');
      return { user: publicUser(user) };
    });

    secured.put('/me/password', async (request) => {
      const { currentPassword, newPassword } = request.body || {};
      if (!currentPassword) throw httpError(400, 'CURRENT_PASSWORD_REQUIRED');

      const user = await User.findById(request.user.userId).select('+password');
      const valid = await bcrypt.compare(String(currentPassword), user.password);
      if (!valid) throw httpError(400, 'CURRENT_PASSWORD_INCORRECT');

      user.password = await hashPassword(newPassword);
      await user.save();
      return { user: publicUser(user) };
    });

    secured.register(usersRoutes, { prefix: '/users' });
  });
}
