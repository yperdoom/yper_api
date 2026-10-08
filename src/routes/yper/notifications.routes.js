import PushDevice from '../../models/yper/PushDevice.js';
import Preferences, { REMINDER_KINDS } from '../../models/yper/NotificationPreferences.js';
import { httpError } from '../../lib/errors.js';
import { pushConfigured } from '../../services/push.service.js';

export function defaultPreferences() {
  const times = { weight: '07:30', breakfast: '09:00', lunch: '12:00', afternoon_snack: '16:00', dinner: '20:00' };
  return { timezone: 'America/Sao_Paulo', locale: 'pt-BR', reminders: REMINDER_KINDS.map(kind => ({
    kind, enabled: Boolean(times[kind]), time: times[kind] || '09:00', days: [0, 1, 2, 3, 4, 5, 6],
  })) };
}

function validatePreferences(body) {
  if (!body || typeof body.timezone !== 'string' || !['pt-BR', 'en-US'].includes(body.locale)
    || !Array.isArray(body.reminders) || body.reminders.length > REMINDER_KINDS.length) throw httpError(400, 'BAD_REQUEST');
  try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw httpError(400, 'INVALID_VALUE', { field: 'timezone' }); }
  const kinds = new Set();
  for (const item of body.reminders) {
    if (!item || !REMINDER_KINDS.includes(item.kind) || kinds.has(item.kind) || typeof item.enabled !== 'boolean'
      || typeof item.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)
      || !Array.isArray(item.days) || item.days.length > 7 || (item.enabled && !item.days.length)
      || item.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(item.days).size !== item.days.length) {
      throw httpError(400, 'BAD_REQUEST');
    }
    kinds.add(item.kind);
  }
  return { timezone: body.timezone, locale: body.locale, reminders: body.reminders.map(({ kind, enabled, time, days }) => ({ kind, enabled, time, days })) };
}

export default async function notificationRoutes(fastify) {
  fastify.get('/', async request => ({
    configured: pushConfigured(),
    preferences: await Preferences.findOne({ user: request.user.userId }).select('timezone locale reminders -_id').lean() || defaultPreferences(),
    devices: await PushDevice.find({ user: request.user.userId, expiresAt: { $gt: new Date() } }).select('_id createdAt updatedAt').lean(),
  }));
  fastify.put('/preferences', async request => {
    const data = validatePreferences(request.body);
    await Preferences.updateOne({ user: request.user.userId }, { $set: data }, { upsert: true, runValidators: true });
    return { preferences: data };
  });
  fastify.post('/devices', async request => {
    if (!pushConfigured()) throw httpError(503, 'PUSH_NOT_CONFIGURED');
    const token = request.body?.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || /\s/.test(token)) throw httpError(400, 'BAD_REQUEST');
    const user = request.user.userId;
    const expiresAt = new Date(Math.min(Date.now() + 30 * 86400000, request.user.exp * 1000));
    const device = await PushDevice.findOneAndUpdate({ token }, { $set: { user, expiresAt } }, { upsert: true, new: true });
    await Preferences.updateOne({ user }, { $setOnInsert: { user, ...defaultPreferences() } }, { upsert: true });
    return { device: { _id: device._id } };
  });
  fastify.delete('/devices/:id', async request => {
    if (!/^[a-f\d]{24}$/i.test(request.params.id)) throw httpError(400, 'BAD_REQUEST');
    await PushDevice.deleteOne({ _id: request.params.id, user: request.user.userId });
    return { ok: true };
  });
  fastify.post('/devices/:id/test', async request => {
    if (!pushConfigured()) throw httpError(503, 'PUSH_NOT_CONFIGURED');
    if (!/^[a-f\d]{24}$/i.test(request.params.id)) throw httpError(400, 'BAD_REQUEST');
    const device = await PushDevice.findOneAndUpdate({ _id: request.params.id, user: request.user.userId,
      expiresAt: { $gt: new Date() }, $or: [{ lastTestAt: null }, { lastTestAt: { $lt: new Date(Date.now() - 60000) } }] },
    { lastTestAt: new Date() }, { new: true }).select('+token');
    if (!device) throw httpError(429, 'PUSH_TEST_UNAVAILABLE');
    try {
      await fastify.pushSender(device, { body: request.headers['accept-language']?.startsWith('en') ? 'Notifications are working.' : 'As notificações estão funcionando.', path: '/notifications', tag: 'yper-test' });
    } catch { throw httpError(502, 'PUSH_SEND_FAILED'); }
    return { ok: true };
  });
}
