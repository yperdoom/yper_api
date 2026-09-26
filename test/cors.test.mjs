/**
 * CORS e parsing de corpo. Nao precisa de banco: tudo aqui acontece antes das rotas.
 *
 * O preflight importa porque o navegador so deixa o PUT ou o DELETE sair se a
 * resposta do OPTIONS listar o metodo. O padrao do @fastify/cors e GET,HEAD,POST,
 * entao esquecer de declarar os metodos quebra edicao e exclusao nos tres apps.
 */
process.env.CORS_ORIGINS = 'http://localhost:5173,https://helake.vercel.app';
process.env.JWT_SECRET = 'cors-secret';

const { buildApp } = await import('../src/app.js');

const app = buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label} ->`, JSON.stringify(detail));
  }
};

const preflight = (origin, method) =>
  fetch(`${base}/helake/orders/000000000000000000000000`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });

console.log('\n[cors]');

const put = await preflight('http://localhost:5173', 'PUT');
const allowedMethods = (put.headers.get('access-control-allow-methods') || '')
  .split(',')
  .map((method) => method.trim());

check('preflight responde', put.status === 204 || put.status === 200, put.status);
check('libera a origem do .env', put.headers.get('access-control-allow-origin') === 'http://localhost:5173', put.headers.get('access-control-allow-origin'));
check('PUT liberado no preflight', allowedMethods.includes('PUT'), allowedMethods);
check('DELETE liberado no preflight', allowedMethods.includes('DELETE'), allowedMethods);
check('Authorization liberado', /authorization/i.test(put.headers.get('access-control-allow-headers') || ''), put.headers.get('access-control-allow-headers'));

const other = await preflight('https://helake.vercel.app', 'DELETE');
check('segunda origem da lista tambem passa', other.headers.get('access-control-allow-origin') === 'https://helake.vercel.app', other.headers.get('access-control-allow-origin'));

const stranger = await fetch(`${base}/health`, { headers: { Origin: 'https://site-aleatorio.com' } });
check('origem fora da lista nao recebe allow-origin', stranger.headers.get('access-control-allow-origin') === null, stranger.headers.get('access-control-allow-origin'));

console.log('\n[corpo]');

const emptyBody = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
});
const emptyPayload = await emptyBody.json();
check('content-type json sem corpo nao quebra', emptyBody.status === 400 && emptyPayload.code === 'EMAIL_PASSWORD_REQUIRED', emptyPayload);

const malformed = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{nao e json',
});
check('json malformado -> 400', malformed.status === 400, await malformed.json());

console.log('\n[rotas]');

const health = await fetch(`${base}/health`);
check('GET /health', health.status === 200, health.status);

const trailing = await fetch(`${base}/health/`);
check('barra no fim casa a mesma rota', trailing.status === 200, trailing.status);

const unknown = await fetch(`${base}/nao-existe`);
const unknownBody = await unknown.json();
check('rota inexistente -> 404 com mensagem', unknown.status === 404 && unknownBody.code === 'ROUTE_NOT_FOUND' && !!unknownBody.error, unknownBody);

await app.close();

console.log(failures === 0 ? '\nCORS OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
