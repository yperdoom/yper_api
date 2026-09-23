import mongoose from 'mongoose';

const ProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    birthDate: { type: Date, default: null },
    heightCm: { type: Number, default: 0, min: 0 },
    goal: { type: String, enum: ['cut', 'maintain', 'bulk'], default: 'maintain' },

    dailyCalories: { type: Number, default: 2000, min: 0 },
    proteinTarget: { type: Number, default: 150, min: 0 },
    carbsTarget: { type: Number, default: 200, min: 0 },
    fatTarget: { type: Number, default: 60, min: 0 },

    workoutDaysPerWeek: { type: Number, default: 4, min: 0, max: 7 },
  },
  { timestamps: true }
);

ProfileSchema.statics.getOrCreate = function getOrCreate(userId) {
  return this.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

export default mongoose.models.Profile || mongoose.model('Profile', ProfileSchema);
