import BodyMeasurement from '../../models/yper/BodyMeasurement.js';
import { crudRoutes } from '../../lib/crud.js';

export default crudRoutes(BodyMeasurement, {
  plural: 'measurements',
  single: 'measurement',
  sort: { date: -1 },
  scoped: true,
});
