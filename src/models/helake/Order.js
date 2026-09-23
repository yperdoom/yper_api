import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    recipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', required: true },
    quantity: { type: Number, required: true, min: 1 },
    deliveryDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['new', 'in_production', 'ready', 'delivered', 'cancelled'],
      default: 'new',
    },
    paidPrice: { type: Number, default: 0 },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.models.Order || mongoose.model('Order', OrderSchema);
