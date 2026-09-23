import mongoose from 'mongoose';

const SINGLETON_ID = 'global';

const SettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    businessName: { type: String, default: 'Sweet Tooth' },
    ownerName: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
    currency: { type: String, default: 'BRL' },
    gas: { type: Number, default: 0 },
    electricity: { type: Number, default: 0 },
    water: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
    monthlyHours: { type: Number, default: 160 },
    defaultInfraPercentage: { type: Number, default: 15 },
    defaultMargin: { type: Number, default: 50 },
  },
  { timestamps: true }
);

SettingsSchema.statics.getOrCreate = function () {
  return this.findByIdAndUpdate(
    SINGLETON_ID,
    { $setOnInsert: {} },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

export default mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
