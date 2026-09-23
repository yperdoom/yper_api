// Sobe o server.js de verdade nos dois modos de log, contra um mongo em memoria.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const mongo = await MongoMemoryServer.create();
let failures = 0;

async function boot(label, extraEnv, port) {
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB: 'boot',
      JWT_SECRET: 'boot-secret',
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });

  let status = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    try {
      status = (await fetch(`http://127.0.0.1:${port}/health`)).status;
      break;
    } catch {
      if (child.exitCode !== null) break;
    }
  }

  await sleep(800);
  child.kill();

  const ok = status === 200;
  if (!ok) failures += 1;
  console.log(`\n[${label}] /health -> ${status ?? 'sem resposta'} ${ok ? 'ok' : 'FAIL'}`);
  console.log(output.trim().split('\n').slice(0, 3).join('\n') || '(sem log)');
  return output;
}

const dev = await boot('dev (pino-pretty)', { NODE_ENV: '' }, 4412);
if (!/INFO|listening|mongo/i.test(dev)) {
  failures += 1;
  console.log('  FAIL: modo dev nao logou nada');
}

const prod = await boot('producao (JSON)', { NODE_ENV: 'production' }, 4413);
const firstLine = prod.trim().split('\n')[0] || '';
try {
  JSON.parse(firstLine);
  console.log('  ok: log de producao e JSON valido');
} catch {
  failures += 1;
  console.log('  FAIL: log de producao nao e JSON ->', firstLine.slice(0, 120));
}

await mongo.stop();
console.log(failures === 0 ? '\nBOOT OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
