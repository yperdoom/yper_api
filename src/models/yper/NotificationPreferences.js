import mongoose from 'mongoose';

export const REMINDER_KINDS = ['weight', 'breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner', 'supper'];
const reminder = new mongoose.Schema({
  kind: { type: String, enum: REMINDER_KINDS, required: true },
  enabled: { type: Boolean, default: false },
  time: { type: String, required: true },
  days: [{ type: Number, min: 0, max: 6 }],
}, { _id: false });
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  timezone: { type: String, default: 'America/Sao_Paulo' },
  locale: { type: String, enum: ['pt-BR', 'en-US'], default: 'pt-BR' },
  reminders: { type: [reminder], default: [] },
}, { timestamps: true });
export default mongoose.models.NotificationPreferences || mongoose.model('NotificationPreferences', schema);
