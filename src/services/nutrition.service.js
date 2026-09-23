const MACROS = ['calories', 'protein', 'carbs', 'fat', 'fiber'];

const round = (value) => Math.round(value * 10) / 10;

/**
 * Converte os itens de uma refeicao em macros.
 * A quantidade do item esta na mesma unidade do servingUnit do alimento, entao
 * o fator e quantidade / servingSize. Exige os itens ja populados.
 */
export function mealTotals(meal) {
  const totals = Object.fromEntries(MACROS.map((macro) => [macro, 0]));

  for (const item of meal.items || []) {
    const food = item.food;
    if (!food?.servingSize) continue;

    const factor = item.quantity / food.servingSize;
    for (const macro of MACROS) {
      totals[macro] += (food[macro] || 0) * factor;
    }
  }

  return Object.fromEntries(MACROS.map((macro) => [macro, round(totals[macro])]));
}

export function sumTotals(list) {
  const totals = Object.fromEntries(MACROS.map((macro) => [macro, 0]));
  for (const entry of list) {
    for (const macro of MACROS) totals[macro] += entry[macro] || 0;
  }
  return Object.fromEntries(MACROS.map((macro) => [macro, round(totals[macro])]));
}

/** Intervalo [inicio, fim) do dia local de uma data. */
export function dayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
