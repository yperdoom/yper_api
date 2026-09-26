import mongoose from 'mongoose';

export const MUSCLE_GROUPS = [
  'chest', 'back', 'legs', 'glutes', 'shoulders',
  'biceps', 'triceps', 'abs', 'calves',
  'cardio', 'fullBody', 'other',
];

const ExerciseSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    muscleGroup: { type: String, enum: MUSCLE_GROUPS, default: 'other' },
    equipment: { type: String, default: '', trim: true },
    videoUrl: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

ExerciseSchema.index({ user: 1, name: 1 }, { unique: true });

export default mongoose.models.Exercise || mongoose.model('Exercise', ExerciseSchema);
