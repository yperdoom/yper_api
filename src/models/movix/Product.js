import mongoose from 'mongoose';

export const PRODUCT_UNITS = ['un', 'cx', 'kg', 'g', 'L', 'ml', 'm', 'pct'];

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true, uppercase: true },
    barcode: { type: String, default: '', trim: true },
    category: { type: String, default: 'Geral', trim: true },
    unit: { type: String, enum: PRODUCT_UNITS, default: 'un' },
    costPrice: { type: Number, default: 0, min: 0 },
    salePrice: { type: Number, default: 0, min: 0 },
    currentStock: { type: Number, default: 0 },
    minimumStock: { type: Number, default: 0, min: 0 },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// SKU e opcional, mas quando preenchido nao pode repetir.
ProductSchema.index(
  { sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $gt: '' } } }
);

export default mongoose.models.Product || mongoose.model('Product', ProductSchema);
