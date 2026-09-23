import mongoose from 'mongoose';

const WorkoutItemSchema = new mongoose.Schema(
  {
    exercise: { type: mongoose.Schema.Types.ObjectId, ref: 'Exercise', required: true },
    sets: { type: Number, default: 3, min: 1 },
    reps: { type: String, default: '10' }, // texto: aceita "8-12", "ate a falha"
    weight: { type: Number, default: 0, min: 0 },
    restSeconds: { type: Number, default: 60, min: 0 },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const WorkoutSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true }, // ex: "Treino A"
    focus: { type: String, default: '', trim: true }, // ex: "Peito e triceps"
    weekdays: { type: [Number], default: [] }, // 0 = domingo
    items: { type: [WorkoutItemSchema], default: [] },
    notes: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.models.Workout || mongoose.model('Workout', WorkoutSchema);
