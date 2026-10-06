import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  workout: { type: mongoose.Schema.Types.ObjectId, ref: 'Workout', required: true },
  day: { type: String, required: true }, // Local calendar date supplied by the client.
  workoutName: { type: String, default: '' },
  completedExercises: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Exercise' }],
}, { timestamps: true });
schema.index({ user: 1, workout: 1, day: 1 }, { unique: true });

export default mongoose.models.WorkoutProgress || mongoose.model('WorkoutProgress', schema);
