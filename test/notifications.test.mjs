import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import PushDevice from '../src/models/yper/PushDevice.js';
import Preferences from '../src/models/yper/NotificationPreferences.js';
import Delivery from '../src/models/yper/NotificationDelivery.js';
import BodyMeasurement from '../src/models/yper/BodyMeasurement.js';
import Meal from '../src/models/yper/Meal.js';
import User from '../src/models/User.js';
import { localTime, reminderDue, runNotifications } from '../src/services/notificationScheduler.js';
import { defaultPreferences } from '../src/routes/yper/notifications.routes.js';

// Isolated Mongo and fake transport: no credentials loaded and no real FCM traffic.
process.env.JWT_SECRET = 'notification-tests-only';
process.env.YPER_PUBLIC_URL = 'https://yper.example.com';
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const mongo = await MongoMemoryServer.create();
const sent = [];
const send = async (device, payload) => { sent.push({ user: String(device.user), ...payload }); };
const app = buildApp({ pushSender: send });
try {
  await mongoose.connect(mongo.getUri(), { dbName: 'notifications-test' });
  await Promise.all([PushDevice.init(), Preferences.init(), Delivery.init()]);
  const setup = (await app.inject({ method: 'POST', url: '/auth/setup', payload: { email: 'push@test.com', password: 'secret123' } })).json();
  const user = setup.user.id;
  const headers = { authorization: `Bearer ${setup.token}` };
  const call = (method, path, payload) => app.inject({ method, url: `/yper/notifications${path}`, headers, payload });
  assert.equal((await app.inject({ method: 'GET', url: '/yper/notifications' })).statusCode, 401);
  const initial = (await call('GET', '')).json();
  assert.equal(initial.configured, false);
  assert.equal(initial.preferences.reminders.find(r => r.kind === 'weight').time, '07:30');
  assert.equal((await call('POST', '/devices', { token: 'a'.repeat(100) })).statusCode, 503);
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}'; // Presence only; fake transport never parses it.
  const response = await call('POST', '/devices', { token: 'a'.repeat(100) });
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().device._id;
  assert.equal((await call('POST', '/devices', { token: 'a'.repeat(100) })).json().device._id, id);
  assert.ok(!(await call('GET', '')).body.includes('a'.repeat(100)));
  for (const payload of [
    { ...defaultPreferences(), timezone: 'invalid' },
    { ...defaultPreferences(), reminders: [{ kind: 'weight', time: '24:00', enabled: true, days: [1] }] },
    { ...defaultPreferences(), reminders: [{ kind: 'weight', time: '07:30', enabled: true, days: [] }] },
    { ...defaultPreferences(), reminders: [{ kind: 'weight', time: '07:30', enabled: true, days: [1, 1] }] },
    { ...defaultPreferences(), reminders: Array(2).fill(defaultPreferences().reminders[0]) },
  ]) assert.equal((await call('PUT', '/preferences', payload)).statusCode, 400);
  assert.equal((await call('PUT', '/preferences', defaultPreferences())).statusCode, 200);
  assert.equal((await call('POST', `/devices/${id}/test`)).statusCode, 200);
  assert.equal((await call('POST', `/devices/${id}/test`)).statusCode, 429);

  await app.inject({ method: 'POST', url: '/auth/users', headers, payload: { email: 'other@test.com', password: 'secret123', apps: ['yper'] } });
  const other = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'other@test.com', password: 'secret123' } })).json();
  const otherHeaders = { authorization: `Bearer ${other.token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/yper/notifications', headers: otherHeaders })).json().devices.length, 0);
  await app.inject({ method: 'DELETE', url: `/yper/notifications/devices/${id}`, headers: otherHeaders });
  assert.ok(await PushDevice.exists({ _id: id }));
  assert.equal((await app.inject({ method: 'POST', url: `/yper/notifications/devices/${id}/test`, headers: otherHeaders })).statusCode, 429);

  const now = new Date('2026-10-06T10:30:00Z');
  await PushDevice.updateOne({ _id: id }, { expiresAt: new Date('2027-01-01') });
  const clock = localTime(now, 'America/Sao_Paulo');
  assert.deepEqual(clock, { day: '2026-10-06', weekday: 2, minute: 450 });
  const weight = defaultPreferences().reminders[0];
  assert.equal(reminderDue(weight, { ...clock, minute: 449 }), false);
  assert.equal(reminderDue(weight, { ...clock, minute: 480 }), false);
  assert.equal(localTime(new Date('2026-10-06T01:00:00Z'), 'America/Sao_Paulo').day, '2026-10-05');
  sent.length = 0;
  await Promise.all([runNotifications({ now, send }), runNotifications({ now, send })]);
  assert.equal(sent.length, 1, 'concurrent cron calls send one reminder per device/day');
  await runNotifications({ now, send }); assert.equal(sent.length, 1);
  await Delivery.deleteMany({}); sent.length = 0;
  await BodyMeasurement.create({ user, date: '2026-10-06', weightKg: 75 });
  await runNotifications({ now, send }); assert.equal(sent.length, 0, 'date-only weight suppresses the same calendar day');
  await BodyMeasurement.deleteMany({});
  await Meal.create({ user, date: '2026-10-06', type: 'breakfast' });
  await runNotifications({ now: new Date('2026-10-06T12:00:00Z'), send }); assert.equal(sent.length, 0);
  await runNotifications({ now: new Date('2026-10-06T15:00:00Z'), send }); assert.equal(sent.length, 1, 'breakfast does not suppress lunch');
  await Delivery.deleteMany({}); sent.length = 0;
  await User.updateOne({ _id: user }, { active: false });
  await runNotifications({ now, send }); assert.equal(sent.length, 0);
  await User.updateOne({ _id: user }, { active: true });
  let attempts = 0;
  const fail = async () => { attempts++; throw new Error('transient'); };
  for (const minutes of [0, 1, 5, 10, 15]) await runNotifications({ now: new Date(now.valueOf() + minutes * 60000), send: fail });
  assert.equal(attempts, 3, 'bounded retry with backoff');
  await Delivery.deleteMany({});
  await Preferences.updateOne({ user }, { 'reminders.0.enabled': false });
  await runNotifications({ now, send }); assert.equal(sent.length, 0);
  await Preferences.updateOne({ user }, { 'reminders.0.enabled': true });
  await PushDevice.updateOne({ _id: id }, { expiresAt: new Date('2026-10-01') });
  await runNotifications({ now, send }); assert.equal(sent.length, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/internal/notifications/run' })).statusCode, 401);
  process.env.NOTIFICATIONS_CRON_SECRET = 'b'.repeat(40);
  assert.equal((await app.inject({ method: 'POST', url: '/internal/notifications/run', headers: { authorization: 'Bearer ' + 'é'.repeat(40) } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/internal/notifications/run', headers: { authorization: 'Bearer ' + 'b'.repeat(40) } })).statusCode, 200);
  await call('DELETE', `/devices/${id}`);
  assert.equal(await PushDevice.countDocuments({ user }), 0);
  console.log('NOTIFICATIONS OK: ownership, validation, schedule, timezone, suppression, concurrency, retries, revocation and cron auth');
} finally { await app.close(); await mongoose.disconnect(); await mongo.stop(); }
