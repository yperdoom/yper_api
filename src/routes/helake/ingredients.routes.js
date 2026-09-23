import Ingredient from '../../models/helake/Ingredient.js';
import Order from '../../models/helake/Order.js';
import Recipe from '../../models/helake/Recipe.js';
import { crudRoutes } from '../../lib/crud.js';
import { httpError } from '../../lib/errors.js';

/**
 * Soma, por ingrediente, a quantidade ja comprometida com pedidos ainda nao
 * produzidos. O estoque so e debitado quando o pedido entra em producao, entao
 * essa reserva e o que separa o saldo real do saldo projetado.
 */
export async function reservedByIngredient() {
  const pendingOrders = await Order.find({ status: 'new' })
    .populate({ path: 'recipe', populate: { path: 'ingredients.ingredient' } })
    .lean();

  const reserved = {};
  for (const order of pendingOrders) {
    for (const item of order.recipe?.ingredients || []) {
      const id = item.ingredient?._id?.toString();
      if (!id) continue;
      reserved[id] = (reserved[id] || 0) + item.quantity * order.quantity;
    }
  }
  return reserved;
}

async function list() {
  const [ingredients, reserved] = await Promise.all([
    Ingredient.find().sort({ name: 1 }).lean(),
    reservedByIngredient(),
  ]);

  return {
    ingredients: ingredients.map((ingredient) => {
      const amount = reserved[ingredient._id.toString()] || 0;
      return {
        ...ingredient,
        reserved: amount,
        projectedStock: ingredient.currentStock - amount,
      };
    }),
  };
}

/** Impede apagar um ingrediente que ainda e usado por alguma receita. */
async function beforeDelete(request) {
  const linked = await Recipe.countDocuments({ 'ingredients.ingredient': request.params.id });
  if (linked > 0) {
    throw httpError(409, `Ingredient is used by ${linked} recipe(s) and cannot be deleted`);
  }
}

export default crudRoutes(Ingredient, {
  plural: 'ingredients',
  single: 'ingredient',
  sort: { name: 1 },
  list,
  beforeDelete,
});
