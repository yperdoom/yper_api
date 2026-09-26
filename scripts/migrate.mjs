/**
 * Migracoes de dados da base. Idempotente: cada passo so pega o que ainda nao foi migrado.
 *
 *   yarn migrate              aplica
 *   yarn migrate --dry-run    so mostra o que mudaria
 *
 * Usa MONGODB_URI e MONGODB_DB (do ambiente ou do .env).
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { APPS } from '../src/models/User.js';

const STEPS = [
  {
    collection: 'users',
    label: 'Usuarios',
    what: 'sem apps',
    filter: { apps: { $in: [null, []] } },
    update: { $set: { apps: [...APPS] } },
  },
];

const dryRun = process.argv.includes('--dry-run');
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'yper';

if (!uri) {
  console.error('MONGODB_URI is not set');
  process.exit(1);
}

await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000 });
const { db } = mongoose.connection;

try {
  const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();
  console.log(`Banco "${dbName}"${dryRun ? ' (dry-run)' : ''}`);
  console.log(`Colecoes: ${collections.join(', ') || '(nenhuma)'}`);

  let pending = 0;
  for (const step of STEPS) {
    const count = await db.collection(step.collection).countDocuments(step.filter);
    if (count === 0) continue;
    pending += count;

    if (dryRun) {
      console.log(`${step.label}: ${count} ${step.what}`);
      continue;
    }

    const { modifiedCount } = await db.collection(step.collection).updateMany(step.filter, step.update);
    console.log(`${step.label}: ${count} ${step.what} -> ${modifiedCount} atualizado(s)`);
  }

  if (pending === 0) console.log('nada a migrar');
  else if (dryRun) console.log('dry-run: nada foi alterado');
} finally {
  await mongoose.disconnect();
}
