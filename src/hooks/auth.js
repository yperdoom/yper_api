import jwt from 'jsonwebtoken';

import User from '../models/User.js';

const TOKEN_TTL = '30d';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
}

export function signToken({ userId, email, apps, role }) {
  return jwt.sign({ userId, email, apps, role }, secret(), { expiresIn: TOKEN_TTL });
}

/**
 * Hook onRequest: valida o Bearer token e preenche request.user.
 * O usuario e conferido no banco a cada request: removido ou inativo perde o acesso
 * na hora, mesmo com token valido. Role e apps tambem vem do banco, nao do token.
 * Responder dentro de um hook interrompe a cadeia, entao a rota nem roda.
 */
export async function requireAuth(request, reply) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }

  const user = await User.findById(payload.userId).select('role active apps').lean();
  if (!user || user.active === false) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  request.user = { ...payload, role: user.role, apps: user.apps };
}

/** Hook onRequest: exige que o app esteja liberado para o usuario. Roda depois do requireAuth. */
export function requireApp(app) {
  return async function checkApp(request, reply) {
    const apps = request.user?.apps || [];
    if (!apps.includes(app)) {
      return reply.code(403).send({ error: `No access to ${app}` });
    }
  };
}

/** Hook onRequest: so admin passa. Roda depois do requireAuth, que traz o role do banco. */
export async function requireAdmin(request, reply) {
  if (request.user?.role !== 'admin') {
    return reply.code(403).send({ error: 'Admin only' });
  }
}
