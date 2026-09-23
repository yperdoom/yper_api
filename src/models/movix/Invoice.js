import mongoose from 'mongoose';

export const INVOICE_TYPES = ['in', 'out'];
export const INVOICE_STATUSES = ['draft', 'confirmed', 'cancelled'];

const InvoiceItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    description: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const InvoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, trim: true },
    series: { type: String, default: '1', trim: true },
    accessKey: { type: String, default: '', trim: true }, // chave de acesso da NF-e
    type: { type: String, enum: INVOICE_TYPES, required: true },
    status: { type: String, enum: INVOICE_STATUSES, default: 'draft' },

    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    counterpartName: { type: String, default: '' }, // destinatario, em notas de saida

    issueDate: { type: Date, required: true },
    items: { type: [InvoiceItemSchema], default: [] },
    totalAmount: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },

    confirmedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

InvoiceSchema.index({ number: 1, series: 1, type: 1 }, { unique: true });

// O total sempre deriva dos itens: nao aceita valor enviado pelo cliente.
InvoiceSchema.pre('validate', function setTotal() {
  this.totalAmount = this.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  );
});

export default mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);
