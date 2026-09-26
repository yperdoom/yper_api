import User, { APPS } from '../models/User.js';
import { requireAdmin } from '../hooks/auth.js';
import { httpError } from '../lib/errors.js';
import { publicUser, sanitizeApps, hashPassword } from '../lib/users.js';

const EDITABLE = ['name', 'email', 'role', 'apps', 'active'];

/**
 * Gestao de usuarios, so admin. Registrado dentro do escopo com requireAuth.
 * Como quem chama e sempre um admin ativo e ele nao pode se rebaixar, desativar
 * ou remover, a base nunca fica sem admin ativo.
 */
export default async function usersRoutes(fastify) {
  fastify.addHook('onRequest', requireAdmin);

  const findOr404 = async (id) => {
    const user = await User.findById(id);
    if (!user) throw httpError(404, 'Not found');
    return user;
  };

  const isSelf = (request) => request.params.id === String(request.user.userId);

  fastify.get('/', async () => {
    const users = await User.find().sort({ email: 1 }).lean();
    return { users: users.map(publicUser) };
  });

  fastify.post('/', async (request, reply) => {
    const { name = '', email, password, role, apps } = request.body || {};
    if (!email || !password) throw httpError(400, 'Email and password are required');

    const user = new User({ name, email, role, apps: sanitizeApps(apps) });
    user.password = await hashPassword(password);
    // Admin sempre acessa todos os apps.
    if (user.role === 'admin') user.apps = [...APPS];
    await user.save();

    return reply.code(201).send({ user: publicUser(user) });
  });

  fastify.put('/:id', async (request) => {
    const user = await findOr404(request.params.id);
    const body = request.body || {};

    for (const field of EDITABLE) {
      if (body[field] === undefined) continue;
      user[field] = field === 'apps' ? sanitizeApps(body.apps) : body[field];
    }

    if (isSelf(request) && (user.role !== 'admin' || !user.active)) {
      throw httpError(409, 'You cannot demote or deactivate yourself');
    }
    if (user.role === 'admin') user.apps = [...APPS];

    await user.save();
    return { user: publicUser(user) };
  });

  fastify.put('/:id/password', async (request) => {
    const user = await findOr404(request.params.id);
    user.password = await hashPassword(request.body?.password);
    await user.save();
    return { user: publicUser(user) };
  });

  fastify.delete('/:id', async (request) => {
    if (isSelf(request)) throw httpError(409, 'You cannot delete yourself');

    const user = await User.findByIdAndDelete(request.params.id);
    if (!user) throw httpError(404, 'Not found');
    return { success: true };
  });
}
