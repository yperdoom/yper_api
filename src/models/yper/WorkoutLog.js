import mongoose from 'mongoose';

const SetLogSchema = new mongoose.Schema(
  {
    reps: { type: Number, required: true, min: 0 },
    weight: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const EntryLogSchema = new mongoose.Schema(
  {
    exercise: { type: mongoose.Schema.Types.ObjectId, ref: 'Exercise', required: true },
    sets: { type: [SetLogSchema], default: [] },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const WorkoutLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    workout: { type: mongoose.Schema.Types.ObjectId, ref: 'Workout', default: null },
    date: { type: Date, required: true, default: Date.now },
    entries: { type: [EntryLogSchema], default: [] },
    durationMinutes: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

WorkoutLogSchema.index({ user: 1, date: -1 });

/** Volume total da sessao: soma de reps x carga de todas as series. */
WorkoutLogSchema.virtual('totalVolume').get(function totalVolume() {
  return this.entries.reduce(
    (sum, entry) => sum + entry.sets.reduce((s, set) => s + set.reps * set.weight, 0),
    0
  );
});

WorkoutLogSchema.set('toJSON', { virtuals: true });
WorkoutLogSchema.set('toObject', { virtuals: true });

export default mongoose.models.WorkoutLog || mongoose.model('WorkoutLog', WorkoutLogSchema);
