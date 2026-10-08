import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  device: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, required: true },
  day: { type: String, required: true },
  state: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  retryAt: { type: Date, default: Date.now },
  expireAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ user: 1, device: 1, kind: 1, day: 1 }, { unique: true });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.NotificationDelivery || mongoose.model('NotificationDelivery', schema);
