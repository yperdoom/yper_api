import Customer from '../../models/helake/Customer.js';
import Order from '../../models/helake/Order.js';
import { crudRoutes } from '../../lib/crud.js';
import { httpError } from '../../lib/errors.js';

/** Lista clientes com o resumo de pedidos agregado. */
async function list() {
  const [customers, orderStats] = await Promise.all([
    Customer.find().sort({ name: 1 }).lean(),
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: '$customer',
          totalOrders: { $sum: 1 },
          totalSpent: { $sum: '$paidPrice' },
          lastOrder: { $max: '$deliveryDate' },
        },
      },
    ]),
  ]);

  const statsById = new Map(orderStats.map((stats) => [stats._id.toString(), stats]));

  return {
    customers: customers.map((customer) => {
      const stats = statsById.get(customer._id.toString());
      return {
        ...customer,
        totalOrders: stats?.totalOrders || 0,
        totalSpent: stats?.totalSpent || 0,
        lastOrder: stats?.lastOrder || null,
      };
    }),
  };
}

/** Impede apagar um cliente que ainda tem pedidos vinculados. */
async function beforeDelete(request) {
  const linked = await Order.countDocuments({ customer: request.params.id });
  if (linked > 0) {
    throw httpError(409, `Customer has ${linked} order(s) and cannot be deleted`);
  }
}

export default crudRoutes(Customer, {
  plural: 'customers',
  single: 'customer',
  sort: { name: 1 },
  list,
  beforeDelete,
});
