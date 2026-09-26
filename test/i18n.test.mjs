/**
 * i18n das mensagens de erro.
 *
 * (a) estatico: todo codigo usado em src existe nos dois locales, e os locales
 *     tem exatamente as mesmas chaves.
 * (b) http: o corpo de erro traz { error, code, params? } com a mensagem no idioma
 *     do Accept-Language (padrao pt-BR).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label} ->`, JSON.stringify(detail));
  }
};

const SRC = resolve('src');
const LOCALES_DIR = join(SRC, 'i18n', 'locales');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

async function loadLocale(name) {
  const file = join(LOCALES_DIR, `${name}.js`);
  if (!existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

// ---------------- estatico ----------------
console.log('\n[estatico]');

const ptModule = await loadLocale('pt-BR');
const enModule = await loadLocale('en-US');
check('locale pt-BR existe', !!ptModule, LOCALES_DIR);
check('locale en-US existe', !!enModule, LOCALES_DIR);

const pt = ptModule?.default || {};
const en = enModule?.default || {};

const usedCodes = new Set();
let dynamicCalls = [];
for (const file of sourceFiles(SRC)) {
  if (file.startsWith(LOCALES_DIR)) continue;
  const text = readFileSync(file, 'utf8');

  for (const match of text.matchAll(/\b(?:httpError|sendError)\(([^)]*)/g)) {
    const args = match[1];
    // Definicao ou repasse (err.code): o codigo veio de outra chamada, ja conferida.
    if (/^\s*status\s*,\s*code\b/.test(args) || /\bstatus\s*,\s*code\s*,/.test(args) || /\berr\.code\b/.test(args)) continue;
    const literal = args.match(/,\s*'([A-Z][A-Z0-9_]*)'/);
    if (literal) usedCodes.add(literal[1]);
    else dynamicCalls.push(`${file}: ${match[0].slice(0, 80)}`);
  }
}

check('src usa algum codigo', usedCodes.size > 0, [...usedCodes]);
check('toda chamada usa status e codigo literais', dynamicCalls.length === 0, dynamicCalls);

const REQUIRED = [
  'UNAUTHORIZED', 'TOKEN_INVALID', 'APP_FORBIDDEN', 'ADMIN_ONLY', 'NOT_FOUND',
  'SETUP_ALREADY_DONE', 'EMAIL_PASSWORD_REQUIRED', 'INVALID_CREDENTIALS', 'USER_INACTIVE',
  'PASSWORD_TOO_SHORT', 'CURRENT_PASSWORD_REQUIRED', 'CURRENT_PASSWORD_INCORRECT',
  'SELF_DEMOTE', 'SELF_DELETE', 'CUSTOMER_HAS_ORDERS', 'RECIPE_HAS_ORDERS', 'INGREDIENT_IN_USE',
  'PRODUCT_HAS_MOVEMENTS', 'MOVEMENTS_IMMUTABLE', 'INVOICE_NOT_DRAFT', 'INVOICE_NOT_CONFIRMABLE',
  'INVOICE_NO_ITEMS', 'INVOICE_ALREADY_CANCELLED', 'INVALID_MOVEMENT_TYPE', 'INVALID_QUANTITY',
  'PRODUCT_NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_VALUE', 'DUPLICATE_VALUE',
  'ROUTE_NOT_FOUND', 'BAD_REQUEST', 'INTERNAL_ERROR',
];
for (const code of REQUIRED) usedCodes.add(code);

const missingPt = [...usedCodes].filter((code) => typeof pt[code] !== 'string');
const missingEn = [...usedCodes].filter((code) => typeof en[code] !== 'string');
check('todo codigo existe em pt-BR', missingPt.length === 0, missingPt);
check('todo codigo existe em en-US', missingEn.length === 0, missingEn);

const ptKeys = Object.keys(pt).sort().join();
const enKeys = Object.keys(en).sort().join();
check('locales com as mesmas chaves', ptKeys === enKeys && ptKeys.length > 0, { pt: Object.keys(pt).length, en: Object.keys(en).length });

const ptValues = Object.keys(ptModule?.values || {}).sort().join();
const enValues = Object.keys(enModule?.values || {}).sort().join();
check('valores traduzidos com as mesmas chaves', ptValues === enValues, { ptValues, enValues });

// ---------------- http ----------------
console.log('\n[http]');

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'i18n';
process.env.JWT_SECRET = 'i18n-secret';
delete process.env.CORS_ORIGINS;

const { connectDB } = await import('../src/config/db.js');
const { buildApp } = await import('../src/app.js');
await connectDB();

const app = buildApp({ logger: { level: 'fatal' } });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

async function call(method, path, { body, token, lang } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(lang ? { 'Accept-Language': lang } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const setup = await call('POST', '/auth/setup', { body: { name: 'Admin', email: 'admin@test.com', password: 'secret123' } });
const adminToken = setup.body.token;
await call('POST', '/auth/users', { token: adminToken, body: { email: 'yper@test.com', password: 'abc12345', apps: ['yper'] } });
await call('POST', '/auth/users', { token: adminToken, body: { email: 'off@test.com', password: 'abc12345' } });
await mongoose.connection.db.collection('users').updateOne({ email: 'off@test.com' }, { $set: { active: false } });

const wrong = { email: 'admin@test.com', password: 'errada' };
const wrongDefault = await call('POST', '/auth/login', { body: wrong });
check('login errado -> 401 INVALID_CREDENTIALS', wrongDefault.status === 401 && wrongDefault.body.code === 'INVALID_CREDENTIALS', wrongDefault);
check('sem Accept-Language -> mensagem pt-BR', wrongDefault.body.error === pt.INVALID_CREDENTIALS && !!pt.INVALID_CREDENTIALS, wrongDefault.body);

const wrongEn = await call('POST', '/auth/login', { body: wrong, lang: 'en-US' });
check('Accept-Language en-US -> mensagem en-US', wrongEn.body.code === 'INVALID_CREDENTIALS' && wrongEn.body.error === en.INVALID_CREDENTIALS && pt.INVALID_CREDENTIALS !== en.INVALID_CREDENTIALS, wrongEn.body);

const wrongEnShort = await call('POST', '/auth/login', { body: wrong, lang: 'fr-FR,en;q=0.8' });
check('primeira tag suportada vence (en)', wrongEnShort.body.error === en.INVALID_CREDENTIALS, wrongEnShort.body);

const wrongPt = await call('POST', '/auth/login', { body: wrong, lang: 'pt,en-US;q=0.5' });
check('pt casa pt-BR', wrongPt.body.error === pt.INVALID_CREDENTIALS, wrongPt.body);

const wrongUnsupported = await call('POST', '/auth/login', { body: wrong, lang: 'de-DE' });
check('idioma nao suportado -> pt-BR', wrongUnsupported.body.error === pt.INVALID_CREDENTIALS, wrongUnsupported.body);

const inactive = await call('POST', '/auth/login', { body: { email: 'off@test.com', password: 'abc12345' } });
check('inativo -> 403 USER_INACTIVE', inactive.status === 403 && inactive.body.code === 'USER_INACTIVE' && inactive.body.error === pt.USER_INACTIVE, inactive);

const yperToken = (await call('POST', '/auth/login', { body: { email: 'yper@test.com', password: 'abc12345' } })).body.token;
const forbidden = await call('GET', '/movix/products', { token: yperToken, lang: 'en-US' });
check('app bloqueado -> 403 APP_FORBIDDEN', forbidden.status === 403 && forbidden.body.code === 'APP_FORBIDDEN', forbidden);
check('APP_FORBIDDEN traz app nos params', forbidden.body.params?.app === 'movix', forbidden.body);
check('APP_FORBIDDEN interpola o app na mensagem', typeof forbidden.body.error === 'string' && forbidden.body.error.includes('movix') && !forbidden.body.error.includes('{'), forbidden.body);

const forbiddenLogin = await call('POST', '/auth/login', { body: { email: 'yper@test.com', password: 'abc12345', app: 'helake' } });
check('login em app bloqueado -> APP_FORBIDDEN', forbiddenLogin.status === 403 && forbiddenLogin.body.code === 'APP_FORBIDDEN' && forbiddenLogin.body.params?.app === 'helake', forbiddenLogin);

const invalid = await call('POST', '/movix/suppliers', { token: adminToken, body: {} });
check('validacao -> 400 VALIDATION_FAILED', invalid.status === 400 && invalid.body.code === 'VALIDATION_FAILED' && invalid.body.error === pt.VALIDATION_FAILED, invalid);
check('validacao traz fields', !!invalid.body.fields?.name, invalid.body);

const noToken = await call('GET', '/yper/exercises');
check('sem token -> 401 UNAUTHORIZED', noToken.status === 401 && noToken.body.code === 'UNAUTHORIZED', noToken);

const badToken = await call('GET', '/yper/exercises', { token: 'lixo' });
check('token invalido -> 401 TOKEN_INVALID', badToken.status === 401 && badToken.body.code === 'TOKEN_INVALID', badToken);

const notAdmin = await call('GET', '/auth/users', { token: yperToken });
check('nao admin -> 403 ADMIN_ONLY', notAdmin.status === 403 && notAdmin.body.code === 'ADMIN_ONLY', notAdmin);

const shortPass = await call('POST', '/auth/users', { token: adminToken, lang: 'en-US', body: { email: 'x@test.com', password: '123' } });
check('senha curta -> PASSWORD_TOO_SHORT com min', shortPass.status === 400 && shortPass.body.code === 'PASSWORD_TOO_SHORT' && shortPass.body.params?.min === 6 && shortPass.body.error.includes('6'), shortPass);

const cast = await call('GET', '/movix/suppliers/nao-e-id', { token: adminToken });
check('CastError -> 400 INVALID_VALUE', cast.status === 400 && cast.body.code === 'INVALID_VALUE' && cast.body.params?.field === '_id', cast);

const dup = await call('POST', '/auth/users', { token: adminToken, body: { email: 'yper@test.com', password: 'abc12345' } });
check('duplicado -> 409 DUPLICATE_VALUE com fields', dup.status === 409 && dup.body.code === 'DUPLICATE_VALUE' && Array.isArray(dup.body.fields), dup);

const missing = await call('GET', '/movix/suppliers/000000000000000000000000', { token: adminToken });
check('inexistente -> 404 NOT_FOUND', missing.status === 404 && missing.body.code === 'NOT_FOUND', missing);

const unknown = await call('GET', '/nao-existe', { lang: 'en-US' });
check('rota inexistente -> 404 ROUTE_NOT_FOUND', unknown.status === 404 && unknown.body.code === 'ROUTE_NOT_FOUND' && typeof unknown.body.error === 'string', unknown);

const malformed = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nao e json' });
const malformedBody = await malformed.json();
check('json malformado -> 400 BAD_REQUEST', malformed.status === 400 && malformedBody.code === 'BAD_REQUEST' && malformedBody.error === pt.BAD_REQUEST, malformedBody);

const noParams = await call('POST', '/auth/login', { body: {} });
check('sem params -> corpo sem params', noParams.body.code === 'EMAIL_PASSWORD_REQUIRED' && !('params' in noParams.body), noParams.body);

const preflight = await fetch(`${base}/yper/exercises`, {
  method: 'OPTIONS',
  headers: {
    Origin: 'http://localhost:5173',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization,accept-language',
  },
});
check('preflight libera Accept-Language', /accept-language/i.test(preflight.headers.get('access-control-allow-headers') || ''), preflight.headers.get('access-control-allow-headers'));

await app.close();
await mongoose.disconnect();
await mongo.stop();

console.log(failures === 0 ? '\nI18N OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
