import Product from '../../models/movix/Product.js';
import Invoice from '../../models/movix/Invoice.js';
import StockMovement from '../../models/movix/StockMovement.js';

export default async function dashboardRoutes(fastify) {
  fastify.get('/', async () => {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [products, recentMovements, invoicesThisMonth] = await Promise.all([
      Product.find({ active: true }).lean(),
      StockMovement.find()
        .populate('product', 'name sku unit')
        .sort({ occurredAt: -1, createdAt: -1 })
        .limit(10)
        .lean(),
      Invoice.aggregate([
        { $match: { status: 'confirmed', issueDate: { $gte: startOfMonth } } },
        { $group: { _id: '$type', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const byType = Object.fromEntries(invoicesThisMonth.map((row) => [row._id, row]));

    return {
      totalProducts: products.length,
      stockValue: products.reduce((sum, product) => sum + product.currentStock * product.costPrice, 0),
      lowStock: products
        .filter((product) => product.currentStock < product.minimumStock)
        .sort((a, b) => a.currentStock - b.currentStock),
      purchasesThisMonth: byType.in?.total || 0,
      salesThisMonth: byType.out?.total || 0,
      invoicesThisMonth: (byType.in?.count || 0) + (byType.out?.count || 0),
      recentMovements,
    };
  });
}
