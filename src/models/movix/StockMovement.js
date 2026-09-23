import mongoose from 'mongoose';

export const MOVEMENT_TYPES = ['in', 'out', 'adjustment'];

const StockMovementSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },

    // Quantidade informada pelo usuario, sempre positiva.
    // Em 'adjustment' ela representa o novo saldo, nao a variacao.
    quantity: { type: Number, required: true, min: 0 },

    // Variacao realmente aplicada no saldo do produto (pode ser negativa).
    delta: { type: Number, required: true },

    // Saldo do produto depois do movimento, congelado para auditoria.
    balanceAfter: { type: Number, required: true },

    unitCost: { type: Number, default: 0, min: 0 },
    reason: { type: String, default: '' },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

StockMovementSchema.index({ product: 1, occurredAt: -1 });

export default mongoose.models.StockMovement || mongoose.model('StockMovement', StockMovementSchema);
