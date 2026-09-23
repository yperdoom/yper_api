import jwt from 'jsonwebtoken';

const TOKEN_TTL = '30d';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
}

export function signToken({ userId, email, apps }) {
  return jwt.sign({ userId, email, apps }, secret(), { expiresIn: TOKEN_TTL });
}

/**
 * Hook onRequest: valida o Bearer token e preenche request.user.
 * Responder dentro de um hook interrompe a cadeia, entao a rota nem roda.
 */
export async function requireAuth(request, reply) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  try {
    request.user = jwt.verify(token, secret());
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

/** Hook onRequest: exige que o app esteja liberado no token. Roda depois do requireAuth. */
export function requireApp(app) {
  return async function checkApp(request, reply) {
    const apps = request.user?.apps || [];
    if (!apps.includes(app)) {
      return reply.code(403).send({ error: `No access to ${app}` });
    }
  };
}
