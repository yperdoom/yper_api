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

await mongoose.connect(uri, { dbName: 'legacy' });
const untouched = await mongoose.connection.db.collection('users').findOne({});
check('dry-run nao alterou nada', untouched.apps === undefined, untouched);
await mongoose.disconnect();

const applied = run([]);
check('aplica em 1 usuario', applied.includes('1 atualizado(s)'), applied);

await mongoose.connect(uri, { dbName: 'legacy' });
const migrated = await mongoose.connection.db.collection('users').findOne({});
check('usuario recebeu os 3 apps', migrated.apps?.length === 3, migrated);
await mongoose.disconnect();

const again = run([]);
check('rodar de novo nao faz nada (idempotente)', again.includes('nada a migrar'), again);

await mongo.stop();

console.log(failures === 0 ? '\nMIGRATE OK' : `\n${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
