import jwt from 'jsonwebtoken';

import User from '../models/User.js';
import { httpError } from '../lib/errors.js';

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
 * Lancar erro dentro de um hook interrompe a cadeia, entao a rota nem roda.
 */
export async function requireAuth(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    throw httpError(401, 'UNAUTHORIZED');
  }

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    throw httpError(401, 'TOKEN_INVALID');
  }

  const user = await User.findById(payload.userId).select('role active apps').lean();
  if (!user || user.active === false) {
    throw httpError(401, 'UNAUTHORIZED');
  }

  request.user = { ...payload, role: user.role, apps: user.apps };
}

/** Hook onRequest: exige que o app esteja liberado para o usuario. Roda depois do requireAuth. */
export function requireApp(app) {
  return async function checkApp(request) {
    const apps = request.user?.apps || [];
    if (!apps.includes(app)) {
      throw httpError(403, 'APP_FORBIDDEN', { app });
    }
  };
}

/** Hook onRequest: so admin passa. Roda depois do requireAuth, que traz o role do banco. */
export async function requireAdmin(request) {
  if (request.user?.role !== 'admin') {
    throw httpError(403, 'ADMIN_ONLY');
  }
}
