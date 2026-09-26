/**
 * Usuarios: papel (role), ativo/inativo e o que isso muda no login e no requireAuth.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'users';
process.env.JWT_SECRET = 'users-secret';

const { connectDB } = await import('../src/config/db.js');
const { buildApp } = await import('../src/app.js');
await connectDB();

const app = buildApp({ logger: { level: 'error' } });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

let failures = 0;

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ->`, JSON.stringify(detail));
  }
}

const tokenPayload = (token) =>
  JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString() || '{}');

const users = () => mongoose.connection.db.collection('users');

// ---------------- role e active ----------------
console.log('\n[role e active]');
const setup = await call('POST', '/auth/setup', { name: 'Admin', email: 'admin@test.com', password: 'secret123' });
const adminToken = setup.body.token;
check('setup cria admin', setup.status === 201 && setup.body.user?.role === 'admin', setup.body.user);
check('setup cria usuario ativo', setup.body.user?.active === true, setup.body.user);
check('token do setup leva o role', tokenPayload(adminToken).role === 'admin', tokenPayload(adminToken));

const created = await call('POST', '/auth/users', { name: 'Func', email: 'func@test.com', password: 'abc12345' }, adminToken);
check('usuario novo nasce employee', created.status === 201 && created.body.user?.role === 'employee', created.body.user);
check('usuario novo nasce ativo', created.body.user?.active === true, created.body.user);

const login = await call('POST', '/auth/login', { email: 'func@test.com', password: 'abc12345' });
const employeeToken = login.body.token;
check('login devolve o role', login.status === 200 && login.body.user?.role === 'employee', login.body.user);
check('token do login leva o role', tokenPayload(employeeToken).role === 'employee', tokenPayload(employeeToken));

const me = await call('GET', '/auth/me', null, employeeToken);
check('GET /auth/me traz role', me.status === 200 && me.body.user?.role === 'employee', me.body);

// ---------------- inativo ----------------
console.log('\n[inativo]');
await users().updateOne({ email: 'func@test.com' }, { $set: { active: false } });

const inactiveLogin = await call('POST', '/auth/login', { email: 'func@test.com', password: 'abc12345' });
check('login de inativo -> 403', inactiveLogin.status === 403, inactiveLogin);

const inactiveMe = await call('GET', '/auth/me', null, employeeToken);
check('token antigo de inativo perde acesso na hora -> 401', inactiveMe.status === 401, inactiveMe);

const inactiveApp = await call('GET', '/yper/exercises', null, employeeToken);
check('inativo tambem barrado nas rotas dos apps -> 401', inactiveApp.status === 401, inactiveApp);

await users().updateOne({ email: 'func@test.com' }, { $set: { active: true } });
const reactivated = await call('GET', '/auth/me', null, employeeToken);
check('reativado volta a ter acesso', reactivated.status === 200, reactivated);

// ---------------- removido ----------------
console.log('\n[removido]');
await users().deleteOne({ email: 'func@test.com' });
const goneMe = await call('GET', '/yper/exercises', null, employeeToken);
check('token de usuario removido -> 401', goneMe.status === 401, goneMe);

const adminStill = await call('GET', '/yper/exercises', null, adminToken);
check('admin segue com acesso', adminStill.status === 200, adminStill);

await app.close();
await mongoose.disconnect();
await mongo.stop();

console.log(failures === 0 ? '\nUSERS OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
