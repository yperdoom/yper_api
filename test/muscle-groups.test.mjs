import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { migrateMuscleGroups, rollbackMuscleGroups, normalizeMuscleGroup } from '../scripts/muscle-groups.mjs';

const mongo = await MongoMemoryServer.create();
const temp = mkdtempSync(join(tmpdir(), 'yper-muscle-groups-'));
process.env.MONGODB_URI = mongo.getUri();
process.env.MONGODB_DB = 'groups-test';
process.env.JWT_SECRET = 'groups-test-secret';
const { buildApp } = await import('../src/app.js');
const app = buildApp({ logger: false });
try {
  await mongoose.connect(mongo.getUri(), { dbName: 'groups-test' });
  const setup = (await app.inject({ method: 'POST', url: '/auth/setup', payload: { email: 'one@test.com', password: 'secret123' } })).json();
  const headers = { authorization: `Bearer ${setup.token}` };
  const call = (method, url, payload) => app.inject({ method, url, payload, headers });
  const first = await call('POST', '/yper/exercises', { name: 'Curl', muscleGroup: 'biceps' });
  assert.equal(first.statusCode, 201);
  const id = first.json().exercise._id;
  const omitted = await call('POST', '/yper/exercises', { name: 'Unknown' });
  assert.equal(omitted.json().exercise.muscleGroup, 'other');
  assert.equal((await call('PUT', `/yper/exercises/${id}`, { name: 'Curl renamed' })).json().exercise.muscleGroup, 'biceps');
  for (const value of ['', null, 'invalid', ['biceps'], { group: 'biceps' }]) {
    assert.equal((await call('POST', '/yper/exercises', { name: 'Invalid', muscleGroup: value })).statusCode, 400);
    assert.equal((await call('PUT', `/yper/exercises/${id}`, { muscleGroup: value })).statusCode, 400);
  }
  const db = mongoose.connection.db;
  await db.collection('exercises').insertOne({ user: new mongoose.Types.ObjectId(), name: 'Private', muscleGroup: 'biceps' });
  assert.equal((await call('GET', '/yper/exercises')).json().exercises.length, 2);
  assert.deepEqual((await call('GET', '/yper/exercises?muscleGroup=biceps')).json().exercises.map(e => e._id), [id]);
  assert.equal((await call('GET', '/yper/exercises?muscleGroup=legs')).json().exercises.length, 0);
  for (const query of ['muscleGroup=bad', 'muscleGroup=', 'muscleGroup=biceps&muscleGroup=legs', 'muscleGroup[x]=biceps']) {
    const response = await call('GET', `/yper/exercises?${query}`);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'INVALID_VALUE');
  }
  const workout = await call('POST', '/yper/workouts', { name: 'A', items: [{ exercise: id }] });
  assert.equal(workout.statusCode, 201);
  assert.equal((await call('GET', '/yper/workouts')).json().workouts[0].items[0].exercise.muscleGroup, 'biceps');

  assert.equal(normalizeMuscleGroup(' BÍCEPS '), 'biceps');
  assert.equal(normalizeMuscleGroup('corpo   inteiro'), 'fullBody');
  assert.equal(normalizeMuscleGroup('Perna'), 'legs');
  const collection = db.collection('exercises');
  const legacy = [
    { name: 'Accented', muscleGroup: ' Bíceps ' }, { name: 'Missing' },
    { name: 'Null', muscleGroup: null }, { name: 'Empty', muscleGroup: '' },
    { name: 'Invalid', muscleGroup: '???' }, { name: 'Keep', muscleGroup: 'legs' },
  ];
  const inserted = await collection.insertMany(legacy);
  const auditPath = join(temp, 'audit.jsonl');
  const options = { auditPath, log: () => {} };
  assert.equal(await migrateMuscleGroups(db, { ...options, dryRun: true }), 5);
  assert.equal(existsSync(auditPath), false);
  assert.equal(Object.hasOwn(await collection.findOne({ name: 'Missing' }), 'muscleGroup'), false);
  await migrateMuscleGroups(db, options);
  assert.equal((await collection.findOne({ name: 'Accented' })).muscleGroup, 'biceps');
  assert.equal((await collection.findOne({ name: 'Missing' })).muscleGroup, 'other');
  assert.equal((await collection.findOne({ name: 'Keep' })).muscleGroup, 'legs');
  assert.equal(await migrateMuscleGroups(db, options), 0);
  assert.equal((await call('GET', '/yper/workouts')).json().workouts[0].items[0].exercise._id, id);
  await rollbackMuscleGroups(db, { ...options, dryRun: true });
  assert.equal((await collection.findOne({ name: 'Missing' })).muscleGroup, 'other');
  await collection.updateOne({ name: 'Invalid' }, { $set: { muscleGroup: 'chest', updatedAt: new Date() } });
  await rollbackMuscleGroups(db, options);
  assert.equal((await collection.findOne({ name: 'Accented' })).muscleGroup, ' Bíceps ');
  assert.equal(Object.hasOwn(await collection.findOne({ name: 'Missing' }), 'muscleGroup'), false);
  assert.equal((await collection.findOne({ name: 'Null' })).muscleGroup, null);
  assert.equal((await collection.findOne({ name: 'Empty' })).muscleGroup, '');
  assert.equal((await collection.findOne({ name: 'Invalid' })).muscleGroup, 'chest');
  assert.equal(await collection.countDocuments({ _id: { $in: Object.values(inserted.insertedIds) } }), 6);
  await migrateMuscleGroups(db, { ...options, auditPath: join(temp, 'resume.jsonl') });
  assert.equal(await migrateMuscleGroups(db, options), 0);
  console.log('MUSCLE GROUPS OK: API, ownership, validation, migration, dry-run, rollback and resume');
} finally {
  await app.close();
  await mongoose.disconnect();
  await mongo.stop();
  rmSync(temp, { recursive: true, force: true });
}
