import Product from '../models/movix/Product.js';
import StockMovement from '../models/movix/StockMovement.js';
import { httpError } from '../lib/errors.js';

/**
 * Aplica um movimento de estoque e registra o historico.
 *
 * 'in' soma, 'out' subtrai e 'adjustment' trata a quantidade como o novo saldo
 * do produto, gravando a diferenca em delta. O saldo resultante fica congelado
 * em balanceAfter para que o extrato nao dependa do estado atual do produto.
 *
 * O M0 do Atlas e um replica set, entao transacao funciona; ainda assim o
 * ajuste usa $inc para nao perder movimentos concorrentes.
 */
export async function applyMovement({
  product: productId,
  type,
  quantity,
  unitCost = 0,
  reason = '',
  invoice = null,
  user = null,
  occurredAt,
}) {
  if (!['in', 'out', 'adjustment'].includes(type)) {
    throw httpError(400, 'INVALID_MOVEMENT_TYPE', { type });
  }
  if (typeof quantity !== 'number' || Number.isNaN(quantity) || quantity < 0) {
    throw httpError(400, 'INVALID_QUANTITY');
  }

  const product = await Product.findById(productId);
  if (!product) throw httpError(404, 'PRODUCT_NOT_FOUND', { id: String(productId) });

  let delta;
  if (type === 'in') delta = quantity;
  else if (type === 'out') delta = -quantity;
  else delta = quantity - product.currentStock;

  const updated = await Product.findByIdAndUpdate(
    productId,
    { $inc: { currentStock: delta } },
    { new: true }
  );

  return StockMovement.create({
    product: productId,
    type,
    quantity,
    delta,
    balanceAfter: updated.currentStock,
    unitCost,
    reason,
    invoice,
    user,
    occurredAt: occurredAt || new Date(),
  });
}

/** Desfaz um movimento aplicando a variacao inversa. */
export async function revertMovement(movement, { user = null, reason = '' } = {}) {
  const updated = await Product.findByIdAndUpdate(
    movement.product,
    { $inc: { currentStock: -movement.delta } },
    { new: true }
  );

  return StockMovement.create({
    product: movement.product,
    type: movement.delta >= 0 ? 'out' : 'in',
    quantity: Math.abs(movement.delta),
    delta: -movement.delta,
    balanceAfter: updated.currentStock,
    unitCost: movement.unitCost,
    reason: reason || `Estorno do movimento ${movement._id}`,
    invoice: movement.invoice,
    user,
  });
}
