import Recipe from '../../models/helake/Recipe.js';
import Order from '../../models/helake/Order.js';
import Settings from '../../models/helake/Settings.js';
import { crudRoutes } from '../../lib/crud.js';
import { httpError } from '../../lib/errors.js';

/**
 * Custo de uma receita: ingredientes + rateio de infraestrutura + mao de obra.
 * A receita pode sobrescrever o percentual de infra; quando nao sobrescreve,
 * vale o padrao das configuracoes.
 */
export function calcCosts(recipe, defaultInfraPercentage, defaultMargin) {
  const ingredientCost = (recipe.ingredients || []).reduce(
    (sum, item) => sum + (item.ingredient?.costPerUnit || 0) * item.quantity,
    0
  );

  const infraPct = recipe.infraCostPercentage ?? defaultInfraPercentage;
  const infraCost = ingredientCost * (infraPct / 100);
  const totalCost = ingredientCost + infraCost + (recipe.laborCost || 0);
  const suggestedPrice = totalCost * (1 + defaultMargin / 100);
  const margin =
    recipe.sellingPrice > 0
      ? ((recipe.sellingPrice - totalCost) / recipe.sellingPrice) * 100
      : null;

  return { ingredientCost, infraCost, totalCost, suggestedPrice, margin };
}

async function list() {
  const [recipes, settings] = await Promise.all([
    Recipe.find().populate('ingredients.ingredient').sort({ name: 1 }).lean(),
    Settings.getOrCreate(),
  ]);

  return {
    recipes: recipes.map((recipe) => ({
      ...recipe,
      ...calcCosts(recipe, settings.defaultInfraPercentage, settings.defaultMargin),
    })),
  };
}

/** Impede apagar uma receita que ainda tem pedidos vinculados. */
async function beforeDelete(request) {
  const linked = await Order.countDocuments({ recipe: request.params.id });
  if (linked > 0) {
    throw httpError(409, 'RECIPE_HAS_ORDERS', { count: linked });
  }
}

export default crudRoutes(Recipe, {
  plural: 'recipes',
  single: 'recipe',
  sort: { name: 1 },
  populate: ['ingredients.ingredient'],
  list,
  beforeDelete,
});
