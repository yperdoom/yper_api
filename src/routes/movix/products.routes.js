import Product from '../../models/movix/Product.js';
import StockMovement from '../../models/movix/StockMovement.js';
import { crudRoutes } from '../../lib/crud.js';
import { httpError } from '../../lib/errors.js';

async function list() {
  const products = await Product.find()
    .populate('supplier', 'name document')
    .sort({ name: 1 })
    .lean();

  return {
    products: products.map((product) => ({
      ...product,
      belowMinimum: product.currentStock < product.minimumStock,
      stockValue: product.currentStock * product.costPrice,
    })),
  };
}

/** Produto com historico nao pode ser apagado: desative em vez disso. */
async function beforeDelete(request) {
  const linked = await StockMovement.countDocuments({ product: request.params.id });
  if (linked > 0) {
    throw httpError(409, `Product has ${linked} stock movement(s); deactivate it instead`);
  }
}

const crud = crudRoutes(Product, {
  plural: 'products',
  single: 'product',
  sort: { name: 1 },
  populate: ['supplier'],
  list,
  beforeDelete,
});

export default async function productRoutes(fastify) {
  /** Extrato de movimentacoes de um produto. */
  fastify.get('/:id/movements', async (request) => {
    const movements = await StockMovement.find({ product: request.params.id })
      .populate('invoice', 'number series type')
      .sort({ occurredAt: -1, createdAt: -1 })
      .limit(200)
      .lean();

    return { movements };
  });

  await fastify.register(crud);
}
