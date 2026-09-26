import StockMovement from '../../models/movix/StockMovement.js';
import { applyMovement } from '../../services/stock.service.js';
import { httpError } from '../../lib/errors.js';

export default async function movementRoutes(fastify) {
  fastify.get('/', async (request) => {
    const filter = {};
    if (request.query.product) filter.product = request.query.product;
    if (request.query.type) filter.type = request.query.type;

    const movements = await StockMovement.find(filter)
      .populate('product', 'name sku unit')
      .populate('invoice', 'number series type')
      .sort({ occurredAt: -1, createdAt: -1 })
      .limit(Number(request.query.limit) || 200)
      .lean();

    return { movements };
  });

  fastify.post('/', async (request, reply) => {
    const movement = await applyMovement({
      ...request.body,
      user: request.user.userId,
      invoice: null,
    });
    await movement.populate('product', 'name sku unit currentStock');
    return reply.code(201).send({ movement });
  });

  /**
   * Movimento e historico: nao ha update nem delete. Para corrigir um saldo,
   * lance um movimento do tipo 'adjustment'.
   */
  const immutable = async () => {
    throw httpError(405, 'MOVEMENTS_IMMUTABLE');
  };

  fastify.put('/:id', immutable);
  fastify.delete('/:id', immutable);
}
