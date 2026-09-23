import Order from '../../models/helake/Order.js';
import Ingredient from '../../models/helake/Ingredient.js';
import { httpError } from '../../lib/errors.js';

/**
 * Debita (direction -1) ou devolve (direction +1) os ingredientes da receita
 * multiplicados pela quantidade do pedido.
 */
async function adjustStock(recipe, orderQuantity, direction) {
  const items = recipe?.ingredients || [];
  await Promise.all(
    items.map((item) =>
      Ingredient.findByIdAndUpdate(item.ingredient, {
        $inc: { currentStock: direction * item.quantity * orderQuantity },
      })
    )
  );
}

export default async function orderRoutes(fastify) {
  fastify.get('/', async () => {
    const orders = await Order.find()
      .populate('customer', 'name phone')
      .populate({ path: 'recipe', populate: { path: 'ingredients.ingredient', select: 'name unit' } })
      .sort({ deliveryDate: 1 })
      .lean();

    return { orders };
  });

  fastify.post('/', async (request, reply) => {
    const order = await Order.create(request.body);
    await order.populate(['customer', 'recipe']);
    return reply.code(201).send({ order });
  });

  fastify.get('/:id', async (request) => {
    const order = await Order.findById(request.params.id)
      .populate('customer', 'name phone')
      .populate({ path: 'recipe', populate: { path: 'ingredients.ingredient', select: 'name unit' } })
      .lean();

    if (!order) throw httpError(404, 'Not found');
    return { order };
  });

  fastify.put('/:id', async (request) => {
    const current = await Order.findById(request.params.id).populate('recipe');
    if (!current) throw httpError(404, 'Not found');

    const newStatus = request.body?.status;

    if (newStatus && newStatus !== current.status) {
      if (newStatus === 'in_production' && current.status === 'new') {
        await adjustStock(current.recipe, current.quantity, -1);
      }
      if (newStatus === 'cancelled' && current.status === 'in_production') {
        await adjustStock(current.recipe, current.quantity, +1);
      }
    }

    const order = await Order.findByIdAndUpdate(request.params.id, request.body, {
      new: true,
      runValidators: true,
    })
      .populate('customer', 'name phone')
      .populate({ path: 'recipe', select: 'name category' });

    return { order };
  });

  fastify.delete('/:id', async (request) => {
    const order = await Order.findById(request.params.id).populate('recipe');
    if (!order) throw httpError(404, 'Not found');

    // Pedido em producao ja debitou estoque: devolve antes de apagar.
    if (order.status === 'in_production') {
      await adjustStock(order.recipe, order.quantity, +1);
    }

    await order.deleteOne();
    return { success: true };
  });
}
