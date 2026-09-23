import Food from '../../models/yper/Food.js';
import { crudRoutes } from '../../lib/crud.js';

export default crudRoutes(Food, {
  plural: 'foods',
  single: 'food',
  sort: { name: 1 },
  scoped: true,
});
