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

// Valores antigos gravados em portugues -> valor em ingles.
const MUSCLE_GROUP_MAP = {
  Peito: 'chest',
  Costas: 'back',
  Pernas: 'legs',
  Gluteos: 'glutes',
  Ombros: 'shoulders',
  Biceps: 'biceps',
  Triceps: 'triceps',
  Abdomen: 'abs',
  Panturrilha: 'calves',
  Cardio: 'cardio',
  'Corpo inteiro': 'fullBody',
  Outro: 'other',
};
const YIELD_UNIT_MAP = { fatias: 'slices' };

const renameValues = (collection, label, field, map) =>
  Object.entries(map).map(([from, to]) => ({
    collection,
    label,
    what: `com ${field} "${from}" -> "${to}"`,
    filter: { [field]: from },
    update: { $set: { [field]: to } },
  }));

const STEPS = [
  {
    collection: 'users',
    label: 'Usuarios',
    what: 'sem apps',
    filter: { apps: { $in: [null, []] } },
    update: { $set: { apps: [...APPS] } },
  },
  // Antes dos papeis so existia o dono da base, entao quem nao tem role e admin.
  {
    collection: 'users',
    label: 'Usuarios',
    what: 'sem role',
    filter: { role: { $exists: false } },
    update: { $set: { role: 'admin' } },
  },
  {
    collection: 'users',
    label: 'Usuarios',
    what: 'sem active',
    filter: { active: { $exists: false } },
    update: { $set: { active: true } },
  },
  ...renameValues('exercises', 'Exercicios', 'muscleGroup', MUSCLE_GROUP_MAP),
  ...renameValues('recipes', 'Receitas', 'yieldUnit', YIELD_UNIT_MAP),
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
