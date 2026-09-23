import Order from '../../models/helake/Order.js';
import Ingredient from '../../models/helake/Ingredient.js';
import { reservedByIngredient } from './ingredients.routes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['new', 'in_production', 'ready'];
const SEVERITY_RANK = { critical: 0, low: 1 };

export default async function dashboardRoutes(fastify) {
  fastify.get('/', async () => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const in7Days = new Date(now.getTime() + 7 * DAY_MS);

    const [activeOrders, ingredients, revenueData, reserved] = await Promise.all([
      Order.find({ status: { $in: ACTIVE_STATUSES } })
        .populate('customer', 'name phone')
        .populate({
          path: 'recipe',
          populate: {
            path: 'ingredients.ingredient',
            select: 'name unit costPerUnit currentStock minimumStock',
          },
        })
        .sort({ deliveryDate: 1 })
        .lean(),
      Ingredient.find().lean(),
      Order.aggregate([
        { $match: { status: 'delivered', deliveryDate: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$paidPrice' } } },
      ]),
      reservedByIngredient(),
    ]);

    const ingredientAlerts = ingredients
      .map((ingredient) => {
        const projectedStock = ingredient.currentStock - (reserved[ingredient._id.toString()] || 0);
        const severity =
          projectedStock < 0 ? 'critical' : projectedStock < ingredient.minimumStock ? 'low' : null;

        return severity
          ? { ingredient, currentStock: ingredient.currentStock, projectedStock, severity }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    return {
      activeOrders: activeOrders.length,
      revenueThisMonth: revenueData[0]?.total || 0,
      upcomingDeadlines: activeOrders.filter((order) => new Date(order.deliveryDate) <= in7Days),
      pendingOrders: activeOrders.filter((order) => order.status === 'new'),
      ingredientAlerts,
    };
  });
}
