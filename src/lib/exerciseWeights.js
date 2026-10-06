import Workout from '../models/yper/Workout.js';

// Legacy fallback: the most recently edited workout wins, including an explicit zero.
// It is read-only; saves go to Exercise.weight and historical logs never change.
export async function withExerciseWeights(exercises, user) {
  const missing = exercises.filter((exercise) => exercise.weight == null);
  if (!missing.length) return exercises;
  const workouts = await Workout.find({ user, 'items.exercise': { $in: missing.map(e => e._id) } })
    .sort({ updatedAt: -1, _id: -1 }).select('items').lean();
  const weights = new Map();
  for (const workout of workouts) {
    for (const item of workout.items) {
      const id = String(item.exercise);
      if (!weights.has(id) && Number.isFinite(item.weight) && item.weight >= 0) weights.set(id, item.weight);
    }
  }
  return exercises.map(exercise => ({ ...exercise, weight: exercise.weight ?? weights.get(String(exercise._id)) ?? 0 }));
}
