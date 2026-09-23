import Meal from '../../models/yper/Meal.js';
import { crudRoutes } from '../../lib/crud.js';
import { mealTotals, sumTotals, dayRange } from '../../services/nutrition.service.js';

/**
 * Lista refeicoes com os macros ja calculados.
 * Aceita ?date=YYYY-MM-DD para um dia, ou ?from=&to= para um intervalo.
 */
async function list(request) {
  const filter = { user: request.user.userId };

  if (request.query.date) {
    const { start, end } = dayRange(new Date(request.query.date));
    filter.date = { $gte: start, $lt: end };
  } else if (request.query.from || request.query.to) {
    filter.date = {};
    if (request.query.from) filter.date.$gte = new Date(request.query.from);
    if (request.query.to) filter.date.$lte = new Date(request.query.to);
  }

  const meals = await Meal.find(filter).populate('items.food').sort({ date: -1 }).lean();
  const withTotals = meals.map((meal) => ({ ...meal, totals: mealTotals(meal) }));

  return {
    meals: withTotals,
    totals: sumTotals(withTotals.map((meal) => meal.totals)),
  };
}

export default crudRoutes(Meal, {
  plural: 'meals',
  single: 'meal',
  sort: { date: -1 },
  populate: ['items.food'],
  scoped: true,
  list,
});
