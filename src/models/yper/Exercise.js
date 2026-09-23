import mongoose from 'mongoose';

export const MUSCLE_GROUPS = [
  'Peito', 'Costas', 'Pernas', 'Gluteos', 'Ombros',
  'Biceps', 'Triceps', 'Abdomen', 'Panturrilha',
  'Cardio', 'Corpo inteiro', 'Outro',
];

const ExerciseSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    muscleGroup: { type: String, enum: MUSCLE_GROUPS, default: 'Outro' },
    equipment: { type: String, default: '', trim: true },
    videoUrl: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

ExerciseSchema.index({ user: 1, name: 1 }, { unique: true });

export default mongoose.models.Exercise || mongoose.model('Exercise', ExerciseSchema);
