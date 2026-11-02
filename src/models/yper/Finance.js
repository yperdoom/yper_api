import mongoose from 'mongoose';

const owner = { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true };
const accountSchema = new mongoose.Schema({
  user: owner, name: { type: String, required: true },
  kind: { type: String, enum: ['operational', 'reserve'], required: true },
  openingDate: { type: String, required: true },
  openingBalanceCents: { type: Number, default: null },
  revision: { type: Number, default: 0 },
}, { timestamps: true });
const override = new mongoose.Schema({
  month: String, status: { type: String, enum: ['planned', 'paid', 'cancelled'] }, paidDate: String,
  bankMovement: mongoose.Schema.Types.ObjectId,
}, { _id: false });
const entrySchema = new mongoose.Schema({
  bankSource: String,
  user: owner, description: { type: String, required: true },
  type: { type: String, enum: ['income', 'expense', 'transfer', 'reimbursement'], required: true },
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'FinanceAccount', required: true },
  toAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'FinanceAccount', default: null },
  category: { type: String, default: '' }, counterpart: { type: String, default: '' },
  group: { type: String, enum: ['direct', 'card', 'financing'], default: 'direct' },
  creditor: { type: String, default: '' },
  amountCents: { type: Number, required: true },
  date: { type: String, required: true },
  repeat: { type: String, enum: ['once', 'monthly', 'installments'], default: 'once' },
  installment: { type: Number, default: 1 }, totalInstallments: { type: Number, default: 1 },
  endDate: { type: String, default: '' },
  overrides: { type: [override], default: [] }, revision: { type: Number, default: 0 },
}, { timestamps: true });
entrySchema.index({ user: 1, date: 1 });
entrySchema.index({ user: 1, bankSource: 1 }, { unique: true, partialFilterExpression: { bankSource: { $type: 'string' } } });
const estimateSchema = new mongoose.Schema({
  user: owner, month: { type: String, required: true }, category: { type: String, required: true },
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'FinanceAccount', required: true },
  amountCents: { type: Number, required: true }, revision: { type: Number, default: 0 },
}, { timestamps: true });
estimateSchema.index({ user: 1, month: 1, category: 1, account: 1 }, { unique: true });

export const FinanceAccount = mongoose.models.FinanceAccount || mongoose.model('FinanceAccount', accountSchema);
export const FinanceEntry = mongoose.models.FinanceEntry || mongoose.model('FinanceEntry', entrySchema);
export const FinanceEstimate = mongoose.models.FinanceEstimate || mongoose.model('FinanceEstimate', estimateSchema);
