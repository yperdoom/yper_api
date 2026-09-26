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

// ---------------- CRUD de usuarios (admin) ----------------
console.log('\n[crud de usuarios: permissao]');
const noPassword = (list) => list.every((u) => u && u.password === undefined);
const loginAs = async (email, password) =>
  (await call('POST', '/auth/login', { email, password })).body.token;

await call('POST', '/auth/users', { email: 'emp@test.com', password: 'abc12345', role: 'employee' }, adminToken);
await call('POST', '/auth/users', { email: 'man@test.com', password: 'abc12345', role: 'manager' }, adminToken);
const empToken = await loginAs('emp@test.com', 'abc12345');
const manToken = await loginAs('man@test.com', 'abc12345');
const empId = tokenPayload(empToken).userId;

for (const [label, token] of [['employee', empToken], ['manager', manToken]]) {
  const attempts = [
    await call('GET', '/auth/users', null, token),
    await call('POST', '/auth/users', { email: 'x@test.com', password: 'abc12345' }, token),
    await call('PUT', `/auth/users/${empId}`, { name: 'x' }, token),
    await call('PUT', `/auth/users/${empId}/password`, { password: 'abc12345' }, token),
    await call('DELETE', `/auth/users/${empId}`, null, token),
  ];
  check(`${label} recebe 403 em todas as rotas de usuarios`, attempts.every((r) => r.status === 403), attempts.map((r) => r.status));
}

console.log('\n[crud de usuarios: admin]');
const list = await call('GET', '/auth/users', null, adminToken);
check('admin lista usuarios', list.status === 200 && list.body.users?.length === 3, list.body);
check('listagem nao devolve senha', noPassword(list.body.users || []), list.body.users);
check('listagem traz role e active', list.body.users?.every((u) => u.role && typeof u.active === 'boolean'), list.body.users);

const createdMan = await call('POST', '/auth/users', { name: 'Gerente', email: 'Gerente@Test.com', password: 'abc12345', role: 'manager', apps: ['movix'] }, adminToken);
check('admin cria usuario com role e apps', createdMan.status === 201 && createdMan.body.user?.role === 'manager' && createdMan.body.user?.apps?.join() === 'movix', createdMan.body);
check('criacao nao devolve senha', noPassword([createdMan.body.user]), createdMan.body.user);
const manId = createdMan.body.user?.id;

const createdAdmin = await call('POST', '/auth/users', { email: 'admin2@test.com', password: 'abc12345', role: 'admin', apps: ['movix'] }, adminToken);
check('admin novo sempre tem os 3 apps', createdAdmin.status === 201 && createdAdmin.body.user?.apps?.length === 3, createdAdmin.body);
const admin2Id = createdAdmin.body.user?.id;

const dupEmail = await call('POST', '/auth/users', { email: 'gerente@test.com', password: 'abc12345' }, adminToken);
check('email duplicado -> 409', dupEmail.status === 409, dupEmail);
const shortPass = await call('POST', '/auth/users', { email: 'curta@test.com', password: '12345' }, adminToken);
check('senha com menos de 6 -> 400', shortPass.status === 400, shortPass);
const badRole = await call('POST', '/auth/users', { email: 'role@test.com', password: 'abc12345', role: 'owner' }, adminToken);
check('role invalido -> 400', badRole.status === 400, badRole);
const noEmail = await call('POST', '/auth/users', { password: 'abc12345' }, adminToken);
check('sem email -> 400', noEmail.status === 400, noEmail);

const updated = await call('PUT', `/auth/users/${manId}`, { name: 'Gerente 2', role: 'employee', apps: ['helake', 'yper'], active: false, password: 'hackeada' }, adminToken);
check('admin edita nome, role, apps e active', updated.status === 200 && updated.body.user?.name === 'Gerente 2' && updated.body.user?.role === 'employee' && updated.body.user?.apps?.join() === 'helake,yper' && updated.body.user?.active === false, updated.body);
check('edicao nao devolve senha', noPassword([updated.body.user]), updated.body.user);
await call('PUT', `/auth/users/${manId}`, { active: true }, adminToken);
const oldPassLogin = await call('POST', '/auth/login', { email: 'gerente@test.com', password: 'abc12345' });
check('PUT /:id ignora password', oldPassLogin.status === 200, oldPassLogin);

const putBadRole = await call('PUT', `/auth/users/${manId}`, { role: 'owner' }, adminToken);
check('PUT com role invalido -> 400', putBadRole.status === 400, putBadRole);
const putDupEmail = await call('PUT', `/auth/users/${manId}`, { email: 'emp@test.com' }, adminToken);
check('PUT com email de outro -> 409', putDupEmail.status === 409, putDupEmail);
const putMissing = await call('PUT', '/auth/users/000000000000000000000000', { name: 'x' }, adminToken);
check('PUT em id inexistente -> 404', putMissing.status === 404, putMissing);

const passShort = await call('PUT', `/auth/users/${manId}/password`, { password: '123' }, adminToken);
check('redefinir senha curta -> 400', passShort.status === 400, passShort);
const passOk = await call('PUT', `/auth/users/${manId}/password`, { password: 'nova1234' }, adminToken);
check('admin redefine senha', passOk.status === 200 && noPassword([passOk.body.user]), passOk.body);
const newPassLogin = await call('POST', '/auth/login', { email: 'gerente@test.com', password: 'nova1234' });
check('login com a senha nova', newPassLogin.status === 200, newPassLogin);
const passMissing = await call('PUT', '/auth/users/000000000000000000000000/password', { password: 'nova1234' }, adminToken);
check('redefinir senha de id inexistente -> 404', passMissing.status === 404, passMissing);

console.log('\n[crud de usuarios: protecoes]');
const adminId = setup.body.user?.id;
const selfDeactivate = await call('PUT', `/auth/users/${adminId}`, { active: false }, adminToken);
check('admin nao desativa a si mesmo -> 409', selfDeactivate.status === 409 && !!selfDeactivate.body.error, selfDeactivate);
const selfDemote = await call('PUT', `/auth/users/${adminId}`, { role: 'manager' }, adminToken);
check('admin nao rebaixa a si mesmo -> 409', selfDemote.status === 409 && !!selfDemote.body.error, selfDemote);
const selfDelete = await call('DELETE', `/auth/users/${adminId}`, null, adminToken);
check('admin nao remove a si mesmo -> 409', selfDelete.status === 409 && !!selfDelete.body.error, selfDelete);
const selfRename = await call('PUT', `/auth/users/${adminId}`, { name: 'Admin Renomeado', role: 'admin', active: true }, adminToken);
check('admin edita o proprio nome', selfRename.status === 200 && selfRename.body.user?.name === 'Admin Renomeado', selfRename);

// admin2 rebaixado perde o poder na hora, mesmo com token que diz admin.
const admin2Token = await loginAs('admin2@test.com', 'abc12345');
const admin2Before = await call('GET', '/auth/users', null, admin2Token);
check('segundo admin gerencia usuarios', admin2Before.status === 200, admin2Before.status);
const demote = await call('PUT', `/auth/users/${admin2Id}`, { role: 'employee' }, adminToken);
check('admin rebaixa outro admin', demote.status === 200 && demote.body.user?.role === 'employee', demote.body);
const admin2After = await call('GET', '/auth/users', null, admin2Token);
check('rebaixado perde acesso na hora (role vem do banco) -> 403', admin2After.status === 403, admin2After);
const activeAdmins = await users().countDocuments({ role: 'admin', active: true });
check('continua havendo admin ativo', activeAdmins === 1, activeAdmins);

const del = await call('DELETE', `/auth/users/${manId}`, null, adminToken);
check('admin remove usuario', del.status === 200, del);
const delLogin = await call('POST', '/auth/login', { email: 'gerente@test.com', password: 'nova1234' });
check('removido nao loga', delLogin.status === 401, delLogin);
const delMissing = await call('DELETE', `/auth/users/${manId}`, null, adminToken);
check('remover id inexistente -> 404', delMissing.status === 404, delMissing);

await app.close();
await mongoose.disconnect();
await mongo.stop();

console.log(failures === 0 ? '\nUSERS OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
