import 'dotenv/config';
import { buildApp } from './src/app.js';
import { connectDB } from './src/config/db.js';

const PORT = Number(process.env.PORT) || 4000;

/**
 * Em producao o pino escreve JSON, que e o formato que o Render indexa.
 * No terminal isso fica ilegivel, entao usamos o pino-pretty — mas ele e
 * devDependency e pode nao existir no servidor, por isso a checagem.
 */
function prettyTransport() {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    import.meta.resolve('pino-pretty');
    return { target: 'pino-pretty' };
  } catch {
    return undefined;
  }
}

const app = buildApp({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: prettyTransport(),
  },
});

try {
  await connectDB();
  app.log.info('mongo conectado');
} catch (err) {
  app.log.error({ err }, 'falha ao conectar no mongo');
  process.exit(1);
}

try {
  // 0.0.0.0 e obrigatorio para o Render enxergar a porta.
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'falha ao subir o servidor');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log.info(`${signal} recebido, encerrando`);
    await app.close();
    process.exit(0);
  });
}
