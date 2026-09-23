import bcrypt from 'bcryptjs';

import User, { APPS } from '../models/User.js';
import { signToken, requireAuth } from '../hooks/auth.js';
import { httpError } from '../lib/errors.js';

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  apps: user.apps,
});

function sanitizeApps(apps) {
  if (!Array.isArray(apps) || apps.length === 0) return [...APPS];
  const valid = apps.filter((app) => APPS.includes(app));
  return valid.length ? valid : [...APPS];
}

export default async function authRoutes(fastify) {
  /** Cria o primeiro usuario. So funciona enquanto a base estiver vazia. */
  fastify.post('/setup', async (request, reply) => {
    const count = await User.estimatedDocumentCount();
    if (count > 0) throw httpError(403, 'Setup already done');

    const { name = '', email, password } = request.body || {};
    if (!email || !password) throw httpError(400, 'Email and password are required');

    const user = await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      apps: [...APPS],
    });

    return reply.code(201).send({
      user: publicUser(user),
      token: signToken({ userId: user._id, email: user.email, apps: user.apps }),
    });
  });

  /** Informa ao frontend se a base ja tem usuario (usado pela tela de setup). */
  fastify.get('/status', async () => {
    const count = await User.estimatedDocumentCount();
    return { initialized: count > 0 };
  });

  fastify.post('/login', async (request) => {
    const { email, password, app } = request.body || {};
    if (!email || !password) throw httpError(400, 'Email and password are required');

    const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
    if (!user) throw httpError(401, 'Invalid credentials');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw httpError(401, 'Invalid credentials');

    if (app && !user.apps.includes(app)) throw httpError(403, `No access to ${app}`);

    return {
      user: publicUser(user),
      token: signToken({ userId: user._id, email: user.email, apps: user.apps }),
    };
  });

  // Daqui para baixo tudo exige estar logado.
  fastify.register(async (secured) => {
    secured.addHook('onRequest', requireAuth);

    secured.get('/me', async (request) => {
      const user = await User.findById(request.user.userId);
      if (!user) throw httpError(401, 'Unauthorized');
      return { user: publicUser(user) };
    });

    secured.get('/users', async () => {
      const users = await User.find().sort({ email: 1 }).lean();
      return { users: users.map(publicUser) };
    });

    /** Cadastro de novos usuarios: so quem ja esta dentro cria. */
    secured.post('/users', async (request, reply) => {
      const { name = '', email, password, apps } = request.body || {};
      if (!email || !password) throw httpError(400, 'Email and password are required');

      const user = await User.create({
        name,
        email,
        password: await bcrypt.hash(password, 10),
        apps: sanitizeApps(apps),
      });

      return reply.code(201).send({ user: publicUser(user) });
    });
  });
}
