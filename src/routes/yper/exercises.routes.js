import Exercise from '../../models/yper/Exercise.js';
import { crudRoutes } from '../../lib/crud.js';

export default crudRoutes(Exercise, {
  plural: 'exercises',
  single: 'exercise',
  sort: { muscleGroup: 1, name: 1 },
  scoped: true,
});
