import User from '../models/User.js';
import PushDevice from '../models/yper/PushDevice.js';
import Preferences from '../models/yper/NotificationPreferences.js';
import Delivery from '../models/yper/NotificationDelivery.js';
import BodyMeasurement from '../models/yper/BodyMeasurement.js';
import Meal from '../models/yper/Meal.js';
import { sendPush } from './push.service.js';

export function localTime(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function reminderDue(reminder, clock) {
  const [hour, minute] = reminder.time.split(':').map(Number);
  const elapsed = clock.minute - (hour * 60 + minute);
  // A late server wake must not send an entire day's old reminders.
  return reminder.enabled && reminder.days.includes(clock.weekday) && elapsed >= 0 && elapsed < 30;
}

async function alreadyRecorded(user, kind, day, timezone) {
  const model = kind === 'weight' ? BodyMeasurement : Meal;
  const records = await model.find({ user,
    ...(kind === 'weight' ? { weightKg: { $gt: 0 } } : { type: kind }),
    date: { $gte: new Date(new Date(`${day}T00:00:00Z`).valueOf() - 86400000),
      $lt: new Date(new Date(`${day}T00:00:00Z`).valueOf() + 2 * 86400000) },
  }).select('date').lean();
  return records.some(({ date }) => {
    const iso = date.toISOString();
    // Matches the calendar-date convention already used by measurements/history.
    const recordDay = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : localTime(date, timezone).day;
    return recordDay === day;
  });
}

export async function runNotifications({ now = new Date(), send = sendPush } = {}) {
  await Delivery.init();
  const result = { sent: 0, failed: 0, skipped: 0 };
  for await (const pref of Preferences.find({ 'reminders.enabled': true }).lean().cursor()) {
    if (!await User.exists({ _id: pref.user, active: { $ne: false }, apps: 'yper' })) continue;
    const clock = localTime(now, pref.timezone);
    for (const reminder of pref.reminders.filter(item => reminderDue(item, clock))) {
      if (await alreadyRecorded(pref.user, reminder.kind, clock.day, pref.timezone)) { result.skipped++; continue; }
      const devices = await PushDevice.find({ user: pref.user, expiresAt: { $gt: now } }).select('+token').lean();
      for (const device of devices) {
        const key = { user: pref.user, device: device._id, kind: reminder.kind, day: clock.day };
        try {
          await Delivery.updateOne(key, { $setOnInsert: { ...key, retryAt: now, expireAt: new Date(now.valueOf() + 90 * 86400000) } }, { upsert: true });
        } catch (error) { if (error.code !== 11000) throw error; }
        const claim = await Delivery.findOneAndUpdate({ ...key, state: { $in: ['pending', 'failed', 'sending'] },
          attempts: { $lt: 3 }, retryAt: { $lte: now } },
        { $set: { state: 'sending', retryAt: new Date(now.valueOf() + 5 * 60000) }, $inc: { attempts: 1 } }, { new: true });
        if (!claim) continue;
        // Recheck preferences/device after claiming, so a concurrent opt-out is respected.
        const enabled = await Preferences.exists({ _id: pref._id, reminders: { $elemMatch: { kind: reminder.kind, enabled: true, time: reminder.time } } });
        if (!enabled || !await PushDevice.exists({ _id: device._id, user: pref.user, expiresAt: { $gt: now } })) {
          await Delivery.updateOne({ _id: claim._id }, { state: 'skipped' }); continue;
        }
        const en = pref.locale === 'en-US';
        const body = reminder.kind === 'weight'
          ? (en ? 'Time to record your body weight.' : 'Hora de registrar seu peso corporal.')
          : (en ? 'Record what you ate at this meal.' : 'Registre o que você comeu nesta refeição.');
        try {
          await send(device, { body, path: reminder.kind === 'weight' ? '/measurements' : '/nutrition', tag: `yper-${reminder.kind}-${clock.day}` });
          await Delivery.updateOne({ _id: claim._id, attempts: claim.attempts }, { state: 'sent' }); result.sent++;
        } catch {
          await Delivery.updateOne({ _id: claim._id, attempts: claim.attempts }, { state: 'failed' }); result.failed++;
        }
      }
    }
  }
  return result;
}
