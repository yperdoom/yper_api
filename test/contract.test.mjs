/**
 * Verifica que toda rota chamada pelos frontends existe na API.
 *
 * Le os fontes de <FRONTS_DIR>/{helake,movix,yper}/src (padrao: ../yper/apps, o monorepo),
 * extrai as chamadas api.get/post/put/del, troca os trechos interpolados por valores
 * validos e bate em cada uma. Uma rota inexistente responde code ROUTE_NOT_FOUND e e
 * reportada aqui. App com fonte mas sem nenhuma chamada extraida tambem falha: sinal
 * de que o regex parou de casar.
 *
 * Rodar da raiz do yper_api:  node test/contract.test.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const ROOT = process.env.FRONTS_DIR || resolve('../yper/apps');
const APPS = ['helake', 'movix', 'yper'];
const FAKE_ID = '000000000000000000000000';

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|vue)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Extrai as chamadas api.<metodo>('<caminho>') de um arquivo. */
function extractCalls(source) {
  const calls = [];
  const pattern = /api\.(get|post|put|del)\(\s*(`[^`]*`|'[^']*')/g;

  for (const match of source.matchAll(pattern)) {
    const method = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE' }[match[1]];
    let path = match[2].slice(1, -1);

    // `${x}` vira um id valido.
    path = path.replace(/\$\{[^}]*\}/g, FAKE_ID);

    // Interpolacao com template aninhado (`${query ? `?${query}` : ''}`) nao fecha
    // no regex acima; o que sobra a partir do $ e querystring opcional, entao cai fora.
    const leftover = path.indexOf('$');
    if (leftover !== -1) path = path.slice(0, leftover);

    calls.push({ method, path });
  }
  return calls;
}

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'contract';
process.env.JWT_SECRET = 'contract-secret';

const { connectDB } = await import('../src/config/db.js');
const { buildApp } = await import('../src/app.js');
await connectDB();

const app = buildApp({ logger: { level: 'error' } });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

const setup = await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'contract@test.com', password: 'secret123' }),
});
const { token } = await setup.json();

let checked = 0;
let missing = 0;
let empty = 0;

for (const appName of APPS) {
  const srcDir = join(ROOT, appName, 'src');

  // Os frontends ficam no monorepo ao lado. Num clone isolado do backend, pula.
  if (!existsSync(srcDir)) {
    console.log(`\n[${appName}] fonte nao encontrada em ${srcDir}, pulando`);
    continue;
  }

  const calls = new Map();

  for (const file of sourceFiles(srcDir)) {
    for (const call of extractCalls(readFileSync(file, 'utf8'))) {
      calls.set(`${call.method} ${call.path}`, call);
    }
  }

  console.log(`\n[${appName}] ${calls.size} rota(s) chamadas pelo frontend`);

  if (calls.size === 0) {
    empty += 1;
    console.log(`  FALHA  nenhuma chamada encontrada em ${srcDir}`);
    continue;
  }

  for (const { method, path } of [...calls.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const url = `${base}/${appName}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      // Corpo vazio: importa se a rota existe, nao se o payload e valido.
      body: ['POST', 'PUT'].includes(method) ? '{}' : undefined,
    });

    const payload = await response.json().catch(() => ({}));
    const routeMissing = response.status === 404 && payload.code === 'ROUTE_NOT_FOUND';

    checked += 1;
    if (routeMissing) {
      missing += 1;
      console.log(`  FALTA  ${method} /${appName}${path}`);
    } else {
      console.log(`  ok     ${method} /${appName}${path}  -> ${response.status}`);
    }
  }
}

await app.close();
await mongoose.disconnect();
await mongo.stop();

console.log(
  missing === 0
    ? `\n${checked} rota(s) conferida(s): todas existem na API.`
    : `\n${missing} de ${checked} rota(s) NAO existem na API.`
);
if (empty > 0) console.log(`${empty} app(s) sem nenhuma chamada extraida.`);
process.exit(missing === 0 && empty === 0 ? 0 : 1);
