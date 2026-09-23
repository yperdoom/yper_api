import Supplier from '../../models/movix/Supplier.js';
import { crudRoutes } from '../../lib/crud.js';

export default crudRoutes(Supplier, {
  plural: 'suppliers',
  single: 'supplier',
  sort: { name: 1 },
});
