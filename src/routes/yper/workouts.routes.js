import Workout from '../../models/yper/Workout.js';
import { crudRoutes } from '../../lib/crud.js';

export default crudRoutes(Workout, {
  plural: 'workouts',
  single: 'workout',
  sort: { name: 1 },
  populate: ['items.exercise'],
  scoped: true,
});
