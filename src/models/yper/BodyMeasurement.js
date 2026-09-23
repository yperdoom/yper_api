import mongoose from 'mongoose';

const BodyMeasurementSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true, default: Date.now },
    weightKg: { type: Number, default: 0, min: 0 },
    bodyFatPercentage: { type: Number, default: null, min: 0, max: 100 },
    chestCm: { type: Number, default: null },
    waistCm: { type: Number, default: null },
    hipCm: { type: Number, default: null },
    armCm: { type: Number, default: null },
    thighCm: { type: Number, default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

BodyMeasurementSchema.index({ user: 1, date: -1 });

export default mongoose.models.BodyMeasurement ||
  mongoose.model('BodyMeasurement', BodyMeasurementSchema);
