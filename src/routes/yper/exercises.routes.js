import Exercise, { MUSCLE_GROUPS } from '../../models/yper/Exercise.js';
import { crudRoutes } from '../../lib/crud.js';
import { httpError } from '../../lib/errors.js';
import { withExerciseWeights } from '../../lib/exerciseWeights.js';

export default crudRoutes(Exercise, {
  plural: 'exercises',
  single: 'exercise',
  sort: { muscleGroup: 1, name: 1 },
  scoped: true,
  async list(request) {
    const { muscleGroup } = request.query;
    if ((muscleGroup !== undefined && !MUSCLE_GROUPS.includes(muscleGroup))
      || Object.keys(request.query).some((key) => key.startsWith('muscleGroup['))) {
      throw httpError(400, 'INVALID_VALUE', { field: 'muscleGroup' });
    }
    const filter = { user: request.user.userId };
    if (muscleGroup !== undefined) filter.muscleGroup = muscleGroup;
    const exercises = await Exercise.find(filter).sort({ muscleGroup: 1, name: 1 }).lean();
    return { exercises: await withExerciseWeights(exercises, request.user.userId) };
  },
});
