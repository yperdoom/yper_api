import mongoose from 'mongoose';

const SupplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    document: { type: String, default: '', trim: true }, // CNPJ / CPF
    email: { type: String, default: '', lowercase: true, trim: true },
    phone: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.models.Supplier || mongoose.model('Supplier', SupplierSchema);
