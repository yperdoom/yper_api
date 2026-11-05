import mongoose from 'mongoose';
const { Schema } = mongoose;
const owner = { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true };
const link = new Schema({
  user: owner, itemId: String, externalId: String, name: String, bank: String,
  account: { type: Schema.Types.ObjectId, ref: 'FinanceAccount', required: true },
  active: { type: Boolean, default: true }, lastAttempt: Date, lastSuccess: Date,
  error: String, lease: Date, balanceCents: Number, balanceAt: Date,
}, { timestamps: true });
link.index({ user: 1, externalId: 1 }, { unique: true });
link.index({ user: 1, account: 1 }, { unique: true });
const movement = new Schema({
  user: owner, link: { type: Schema.Types.ObjectId, required: true }, account: Schema.Types.ObjectId,
  aliases: [String], providerId: String, description: String, pattern: String,
  date: String, amountCents: Number, direction: String, bankStatus: String,
  operationType: String, transferReference: String, sameOwner: { type: Boolean, default: null },
  manualHold: { type: Boolean, default: false }, reviewReason: String,
  category: { type: String, default: '' }, categorySource: String, rule: Schema.Types.ObjectId,
  state: { type: String, enum: ['review', 'accepted', 'ignored', 'changed'], default: 'review' },
  entry: Schema.Types.ObjectId, month: String, peer: Schema.Types.ObjectId,
  decision: String, previousOverride: Schema.Types.Mixed,
  revision: { type: Number, default: 0 },
}, { timestamps: true });
movement.index({ user: 1, link: 1, aliases: 1 }, { unique: true });
movement.index({ user: 1, state: 1, date: -1 });
const rule = new Schema({
  user: owner, pattern: String, direction: String, scope: String,
  category: String, since: String, active: { type: Boolean, default: true },
}, { timestamps: true });
rule.index({ user: 1, pattern: 1, direction: 1, scope: 1 }, { unique: true });
const audit = new Schema({ user: owner, movement: Schema.Types.ObjectId, action: String, detail: Schema.Types.Mixed }, { timestamps: true });
const guard = new Schema({ user: { ...owner, unique: true }, revision: { type: Number, default: 0 } });
export const BankLink = mongoose.models.BankLink || mongoose.model('BankLink', link);
export const BankMovement = mongoose.models.BankMovement || mongoose.model('BankMovement', movement);
export const BankRule = mongoose.models.BankRule || mongoose.model('BankRule', rule);
export const BankAudit = mongoose.models.BankAudit || mongoose.model('BankAudit', audit);
export const BankSyncGuard = mongoose.models.BankSyncGuard || mongoose.model('BankSyncGuard', guard);
