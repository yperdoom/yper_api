import Workout from '../../models/yper/Workout.js';
import { crudRoutes } from '../../lib/crud.js';
import WorkoutProgress from '../../models/yper/WorkoutProgress.js';
import Exercise from '../../models/yper/Exercise.js';
import WorkoutLog from '../../models/yper/WorkoutLog.js';
import { httpError } from '../../lib/errors.js';

const crud = crudRoutes(Workout, {
  plural: 'workouts',
  single: 'workout',
  sort: { name: 1 },
  populate: ['items.exercise'],
  scoped: true,
});

function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}

export default async function routes(fastify) {
  await crud(fastify);
  fastify.get('/activity', async (request) => {
    const { from, to, timezone = 'UTC' } = request.query;
    if (typeof timezone !== 'string') throw httpError(400, 'INVALID_VALUE', { field: 'timezone' });
    if (!validDay(from) || !validDay(to) || from > to
      || new Date(to) - new Date(from) > 366 * 86400000) {
      throw httpError(400, 'INVALID_VALUE', { field: 'day' });
    }
    let formatter;
    try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { throw httpError(400, 'INVALID_VALUE', { field: 'timezone' }); }
    const user = request.user.userId;
    const [progress, logs] = await Promise.all([
      WorkoutProgress.find({ user, day: { $gte: from, $lte: to }, 'completedExercises.0': { $exists: true } }).sort({ day: 1 }).lean(),
      WorkoutLog.find({ user, date: { $gte: new Date(new Date(from).valueOf() - 86400000), $lt: new Date(new Date(to).valueOf() + 2 * 86400000) } })
        .populate('workout', 'name').select('date workout').lean(),
    ]);
    const activity = progress.map(entry => ({ day: entry.day, workoutName: entry.workoutName, completedCount: entry.completedExercises.length, source: 'checklist' }));
    for (const log of logs) {
      // Date-only entries from the manual history form are stored at UTC midnight.
      const iso = log.date.toISOString();
      const parts = Object.fromEntries(formatter.formatToParts(log.date).map(part => [part.type, part.value]));
      const day = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${parts.year}-${parts.month}-${parts.day}`;
      if (day >= from && day <= to) activity.push({ day, workoutName: log.workout?.name || '', source: 'log' });
    }
    return { activity };
  });
  async function scope(request, day) {
    if (!validDay(day)) throw httpError(400, 'INVALID_VALUE', { field: 'day' });
    const workout = await Workout.findOne({ _id: request.params.id, user: request.user.userId }).lean();
    if (!workout) throw httpError(404, 'NOT_FOUND');
    return { workout, filter: { user: request.user.userId, workout: workout._id, day } };
  }
  fastify.get('/:id/progress', async (request) => {
    const { workout, filter } = await scope(request, request.query.day);
    const progress = await WorkoutProgress.findOne(filter).lean();
    const ids = new Set(workout.items.map(item => String(item.exercise)));
    return { completedExercises: (progress?.completedExercises || []).filter(id => ids.has(String(id))) };
  });
  fastify.put('/:id/progress', async (request) => {
    const { day, exercise, completed } = request.body || {};
    const { workout, filter } = await scope(request, day);
    if (typeof exercise !== 'string' || typeof completed !== 'boolean'
      || !workout.items.some(item => String(item.exercise) === exercise)
      || !await Exercise.exists({ _id: exercise, user: request.user.userId })) {
      throw httpError(400, 'INVALID_VALUE', { field: 'exercise' });
    }
    const update = completed ? { $addToSet: { completedExercises: exercise } } : { $pull: { completedExercises: exercise } };
    update.$setOnInsert = { workoutName: workout.name };
    let progress;
    try {
      progress = await WorkoutProgress.findOneAndUpdate(filter, update, { new: true, upsert: true, runValidators: true }).lean();
    } catch (err) {
      // Concurrent first writes may race on the unique day index; retry on the created document.
      if (err.code !== 11000) throw err;
      progress = await WorkoutProgress.findOneAndUpdate(filter, update, { new: true, runValidators: true }).lean();
    }
    return { completedExercises: progress.completedExercises };
  });
}
