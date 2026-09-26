/**
 * Testa o migrate contra um Mongo em memoria, simulando a base antiga do helake:
 * um usuario gravado sem o campo `apps`.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { execFileSync } from 'node:child_process';

const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri();

const env = { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'legacy', JWT_SECRET: 'x' };

// Grava direto na colecao, sem passar pelo schema, para o doc nascer sem `apps`.
await mongoose.connect(uri, { dbName: 'legacy' });
await mongoose.connection.db.collection('users').insertOne({
  email: 'antigo@test.com',
  password: 'hash',
  createdAt: new Date(),
});
await mongoose.connection.db.collection('orders').insertOne({ quantity: 1 });
await mongoose.connection.db.collection('exercises').insertMany([
  { name: 'Supino', muscleGroup: 'Peito' },
  { name: 'Burpee', muscleGroup: 'Corpo inteiro' },
  { name: 'Remada', muscleGroup: 'back' },
]);
await mongoose.connection.db.collection('recipes').insertMany([
  { name: 'Torta', yieldUnit: 'fatias' },
  { name: 'Pao', yieldUnit: 'un' },
]);
await mongoose.disconnect();

const run = (args) =>
  execFileSync('node', ['scripts/migrate.mjs', ...args], { env, encoding: 'utf8' });

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label} ->`, JSON.stringify(detail));
  }
};

console.log('\n[migrate]');

const dry = run(['--dry-run']);
check('dry-run nomeia o banco', dry.includes('"legacy"'), dry);
check('dry-run lista as colecoes', dry.includes('users') && dry.includes('orders'), dry);
check('dry-run anuncia 1 usuario pendente', dry.includes('Usuarios: 1 sem apps'), dry);
check('dry-run anuncia 1 usuario sem role', dry.includes('Usuarios: 1 sem role'), dry);
check('dry-run anuncia 1 usuario sem active', dry.includes('Usuarios: 1 sem active'), dry);
check('dry-run anuncia Peito -> chest', dry.includes('Exercicios: 1 com muscleGroup "Peito" -> "chest"'), dry);
check('dry-run anuncia Corpo inteiro -> fullBody', dry.includes('Exercicios: 1 com muscleGroup "Corpo inteiro" -> "fullBody"'), dry);
check('dry-run anuncia fatias -> slices', dry.includes('Receitas: 1 com yieldUnit "fatias" -> "slices"'), dry);

await mongoose.connect(uri, { dbName: 'legacy' });
const untouched = await mongoose.connection.db.collection('users').findOne({});
check('dry-run nao alterou nada', untouched.apps === undefined && untouched.role === undefined && untouched.active === undefined, untouched);
await mongoose.disconnect();

const applied = run([]);
check('aplica em 1 usuario', applied.includes('1 atualizado(s)'), applied);

await mongoose.connect(uri, { dbName: 'legacy' });
const migrated = await mongoose.connection.db.collection('users').findOne({});
check('usuario recebeu os 3 apps', migrated.apps?.length === 3, migrated);
check('usuario sem role virou admin', migrated.role === 'admin', migrated);
check('usuario sem active ficou ativo', migrated.active === true, migrated);
const groups = (await mongoose.connection.db.collection('exercises').find().sort({ name: 1 }).toArray())
  .map((e) => `${e.name}:${e.muscleGroup}`).join();
check('muscleGroup em ingles', groups === 'Burpee:fullBody,Remada:back,Supino:chest', groups);
const units = (await mongoose.connection.db.collection('recipes').find().sort({ name: 1 }).toArray())
  .map((r) => `${r.name}:${r.yieldUnit}`).join();
check('fatias virou slices e un ficou', units === 'Pao:un,Torta:slices', units);
await mongoose.disconnect();

const again = run([]);
check('rodar de novo nao faz nada (idempotente)', again.includes('nada a migrar'), again);

await mongo.stop();

console.log(failures === 0 ? '\nMIGRATE OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
