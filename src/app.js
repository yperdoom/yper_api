import Fastify from 'fastify';
import cors from '@fastify/cors';

import { errorHandler, notFoundHandler } from './lib/errors.js';

import authRoutes from './routes/auth.routes.js';
import helakeRoutes from './routes/helake/index.js';
import movixRoutes from './routes/movix/index.js';
import yperRoutes from './routes/yper/index.js';

const allowedOrigins = () =>
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

/**
 * Monta a instancia do Fastify. Quem chama decide o logger: o servidor liga,
 * os testes deixam so o nivel de erro.
 *
 * O retorno ainda nao esta pronto para receber requisicao — os plugins so
 * terminam de registrar no listen() ou num await app.ready().
 */
export function buildApp(options = {}) {
  const app = Fastify({
    logger: false,
    // Sem isto /customers/ nao casa com /customers, que era o comportamento anterior.
    routerOptions: { ignoreTrailingSlash: true },
    ...options,
  });

  // Declarar o campo antes deixa a shape do request estavel para a V8.
  app.decorateRequest('user', null);

  // O parser nativo recusa corpo vazio com content-type json, e e comum um cliente
  // mandar o header em DELETE ou em POST de acao. Aqui isso vira um objeto vazio.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (!body || !body.trim()) return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        done(err);
      }
    }
  );

  const origins = allowedOrigins();
  app.register(cors, {
    origin: origins.length ? origins : true,
    // O padrao do plugin e so GET,HEAD,POST: sem isto o navegador barra PUT e DELETE no preflight.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language'],
    maxAge: 86400,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.get('/health', async () => ({ ok: true, uptime: Math.round(process.uptime()) }));

  app.register(authRoutes, { prefix: '/auth' });
  app.register(helakeRoutes, { prefix: '/helake' });
  app.register(movixRoutes, { prefix: '/movix' });
  app.register(yperRoutes, { prefix: '/yper' });

  return app;
}

export default buildApp;
