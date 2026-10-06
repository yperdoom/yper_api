import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.JWT_SECRET = 'progress-test-secret';
const { buildApp } = await import('../src/app.js');
const { default: WorkoutProgress } = await import('../src/models/yper/WorkoutProgress.js');
const { default: Workout } = await import('../src/models/yper/Workout.js');
const app = buildApp({ logger: false });
try {
  await mongoose.connect(mongo.getUri(), { dbName: 'progress-test' });
  await WorkoutProgress.init();
  const setup = (await app.inject({ method: 'POST', url: '/auth/setup', payload: { email: 'one@test.com', password: 'secret123' } })).json();
  const headers = { authorization: `Bearer ${setup.token}` };
  const call = (method, url, payload) => app.inject({ method, url, payload, headers });
  const exercise = (await call('POST', '/yper/exercises', { name: 'Supino' })).json().exercise;
  const second = (await call('POST', '/yper/exercises', { name: 'Remada' })).json().exercise;
  const workout = (await call('POST', '/yper/workouts', { name: 'A', weekdays: [new Date().getDay()], items: [{ exercise: exercise._id, weight: 20 }, { exercise: second._id }] })).json().workout;
  assert.equal(workout.items[0].sets, null);
  assert.equal(workout.items[0].reps, '');
  const otherWorkout = (await call('POST', '/yper/workouts', { name: 'B', items: [{ exercise: exercise._id, weight: 30 }] })).json().workout;
  await Workout.collection.updateOne({ _id: new mongoose.Types.ObjectId(workout._id) }, { $set: { updatedAt: new Date('2020-01-01') } });
  let exercises = (await call('GET', '/yper/exercises')).json().exercises;
  assert.equal(exercises.find(e => e._id === exercise._id).weight, 30);
  const log = (await call('POST', '/yper/logs', { workout: workout._id, date: '2026-10-01', entries: [{ exercise: exercise._id, sets: [{ reps: 10, weight: 20 }] }] })).json().log;
  assert.equal((await call('PUT', `/yper/exercises/${exercise._id}`, { weight: 42.5 })).statusCode, 200);
  for (const weight of [-1, 'not-a-number']) assert.equal((await call('PUT', `/yper/exercises/${exercise._id}`, { weight })).statusCode, 400);
  exercises = (await call('GET', '/yper/exercises')).json().exercises;
  assert.equal(exercises.find(e => e._id === exercise._id).weight, 42.5);
  const workouts = (await call('GET', '/yper/workouts')).json().workouts;
  assert.ok(workouts.every(w => w.items[0].exercise.weight === 42.5));
  assert.equal((await call('GET', `/yper/logs/${log._id}`)).json().log.entries[0].sets[0].weight, 20);
  assert.equal((await call('GET', '/yper/dashboard')).json().todaysWorkouts[0].items[0].exercise.weight, 42.5);
  const path = `/yper/workouts/${workout._id}/progress`;
  const payload = { day: '2026-10-02', exercise: exercise._id, completed: true };
  assert.deepEqual((await call('GET', `${path}?day=2026-10-02`)).json().completedExercises, []);
  const concurrent = await Promise.all([call('PUT', path, payload), call('PUT', path, { ...payload, exercise: second._id })]);
  assert.ok(concurrent.every(response => response.statusCode === 200), concurrent.map(r => r.body).join());
  assert.equal((await call('PUT', path, payload)).json().completedExercises.length, 2);
  assert.equal(await WorkoutProgress.countDocuments({ workout: workout._id, day: payload.day }), 1);
  assert.deepEqual((await call('GET', `${path}?day=2026-10-03`)).json().completedExercises, []);
  assert.deepEqual((await call('GET', `/yper/workouts/${otherWorkout._id}/progress?day=2026-10-02`)).json().completedExercises, []);
  assert.equal((await call('PUT', path, { ...payload, completed: false })).json().completedExercises.length, 1);
  for (const invalid of [{ ...payload, day: '2026-02-30' }, { ...payload, day: ['2026-10-02'] }, { ...payload, completed: 'yes' }, { ...payload, exercise: new mongoose.Types.ObjectId().toString() }]) {
    assert.equal((await call('PUT', path, invalid)).statusCode, 400);
  }
  const activity = (await call('GET', '/yper/workouts/activity?from=2026-10-01&to=2026-10-04&timezone=America%2FSao_Paulo')).json().activity;
  assert.deepEqual(new Set(activity.map(a => a.day)), new Set(['2026-10-01', '2026-10-02']));
  assert.equal(activity.find(a => a.source === 'checklist').completedCount, 1);
  assert.equal((await call('GET', '/yper/workouts/activity?from=2026-10-07&to=2026-10-01')).statusCode, 400);
  assert.equal((await call('GET', '/yper/workouts/activity?from=2026-10-01&to=2026-10-02&timezone=bad')).statusCode, 400);
  await call('POST', '/auth/users', { email: 'two@test.com', password: 'secret123', apps: ['yper'] });
  const login = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'two@test.com', password: 'secret123' } })).json();
  const outsider = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${login.token}` } });
  assert.equal((await outsider('GET', `${path}?day=2026-10-02`)).statusCode, 404);
  assert.equal((await outsider('PUT', path, payload)).statusCode, 404);
  assert.equal((await outsider('PUT', `/yper/exercises/${exercise._id}`, { weight: 1 })).statusCode, 404);
  assert.deepEqual((await outsider('GET', '/yper/workouts/activity?from=2026-10-01&to=2026-10-04')).json().activity, []);
  await call('DELETE', `/yper/workouts/${workout._id}`);
  const retained = (await call('GET', '/yper/workouts/activity?from=2026-10-02&to=2026-10-02')).json().activity;
  assert.equal(retained[0].workoutName, 'A');

  const customer = (await call('POST', '/helake/customers', { name: 'Ana' })).json().customer;
  const cancelledOnly = (await call('POST', '/helake/customers', { name: 'Bia' })).json().customer;
  const noOrders = (await call('POST', '/helake/customers', { name: 'Cris' })).json().customer;
  const orders = mongoose.connection.db.collection('orders');
  await orders.insertMany(['new', 'in_production', 'ready', 'delivered', 'cancelled'].map(status => ({ customer: new mongoose.Types.ObjectId(customer._id), status, paidPrice: 10, deliveryDate: new Date('2026-10-01') })));
  await orders.insertOne({ customer: new mongoose.Types.ObjectId(cancelledOnly._id), status: 'cancelled', paidPrice: 90, deliveryDate: new Date() });
  const customers = (await call('GET', '/helake/customers')).json().customers;
  const ana = customers.find(c => c._id === customer._id);
  assert.equal(ana.totalOrders, 4); assert.equal(ana.completedOrders, 1); assert.equal(ana.cancelledOrders, 1); assert.equal(ana.totalSpent, 40);
  const bia = customers.find(c => c._id === cancelledOnly._id);
  assert.equal(bia.cancelledOrders, 1); assert.equal(bia.totalOrders, 0); assert.equal(bia.totalSpent, 0); assert.equal(bia.lastOrder, null);
  assert.equal(customers.find(c => c._id === noOrders._id).completedOrders, 0);
  console.log('TRAINING PROGRESS OK: daily history, calendar, weights, ownership, concurrency and customer counts');
} finally {
  await app.close(); await mongoose.disconnect(); await mongo.stop();
}
