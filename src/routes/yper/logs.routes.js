import WorkoutLog from '../../models/yper/WorkoutLog.js';
import { crudRoutes } from '../../lib/crud.js';

/** Historico de treinos. Aceita ?from=&to=&limit=. */
async function list(request) {
  const filter = { user: request.user.userId };

  if (request.query.from || request.query.to) {
    filter.date = {};
    if (request.query.from) filter.date.$gte = new Date(request.query.from);
    if (request.query.to) filter.date.$lte = new Date(request.query.to);
  }

  const logs = await WorkoutLog.find(filter)
    .populate('workout', 'name focus')
    .populate('entries.exercise', 'name muscleGroup')
    .sort({ date: -1 })
    .limit(Number(request.query.limit) || 100);

  // toJSON traz o virtual totalVolume, que o lean() descartaria.
  return { logs: logs.map((log) => log.toJSON()) };
}

export default crudRoutes(WorkoutLog, {
  plural: 'logs',
  single: 'log',
  sort: { date: -1 },
  populate: ['workout', 'entries.exercise'],
  scoped: true,
  list,
});
