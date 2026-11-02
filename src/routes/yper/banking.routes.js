import { BankLink, BankMovement, BankRule } from '../../models/yper/Banking.js';
import { FinanceAccount } from '../../models/yper/Finance.js';
import { personalBankConfig, pluggy, canRemember } from '../../services/pluggy.js';
import { bankTransaction, ingestBankRows, decideMovement, bankCandidates } from '../../services/banking.js';
import { httpError } from '../../lib/errors.js';

const id = value => { if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw httpError(400, 'INVALID_VALUE', { field: 'id' }); return value; };
const config = user => { const items = personalBankConfig(user); if (!items) throw httpError(503, 'BANK_NOT_CONFIGURED'); return items; };
export default async function bankingRoutes(app) {
  const provider = app.bankProvider || pluggy;
  app.get('/', async r => {
    const user = r.user.userId;
    const [links, rules, pending] = await Promise.all([
      BankLink.find({ user }).select('-lease -itemId -externalId').lean(),
      BankRule.find({ user }).sort({ createdAt: -1 }).lean(),
      BankMovement.countDocuments({ user, state: { $in: ['review', 'changed'] } }),
    ]);
    return { configured: Boolean(personalBankConfig(user)), links, rules, pending };
  });
  // Discovery is explicit, not triggered on every page load.
  app.post('/discover', async r => ({ accounts: await provider.accounts(config(r.user.userId)) }));
  app.post('/links', async r => {
    const user = r.user.userId; const accountId = id(r.body?.account);
    const available = await provider.accounts(config(user));
    const external = available.find(a => a.externalId === r.body.externalId);
    if (!external) throw httpError(400, 'INVALID_VALUE', { field: 'externalId' });
    return bankTransaction(async session => {
      const account = await FinanceAccount.findOne({ _id: accountId, user }).session(session);
      if (!account) throw httpError(404, 'NOT_FOUND');
      account.revision++; await account.save({ session });
      const existing = await BankLink.findOne({ user, $or: [{ account: accountId }, { externalId: external.externalId }] }).session(session);
      if (existing) throw httpError(409, 'BANK_ALREADY_LINKED');
      const [link] = await BankLink.create([{ ...external, account: accountId, user }], { session });
      return { id: link._id };
    });
  });
  app.put('/links/:id', async r => {
    if (typeof r.body?.active !== 'boolean') throw httpError(400, 'INVALID_VALUE', { field: 'active' });
    const link = await BankLink.findOneAndUpdate({ _id: id(r.params.id), user: r.user.userId,
      $or: [{ lease: null }, { lease: { $lt: new Date() } }] }, { $set: { active: r.body.active } }, { new: true });
    if (!link) throw httpError(409, 'FINANCE_CHANGED');
    return { ok: true };
  });
  app.post('/links/:id/sync', async r => {
    const user = r.user.userId; const items = config(user); const now = new Date();
    const lease = new Date(now.getTime() + 10 * 60 * 1000);
    const link = await BankLink.findOneAndUpdate({ _id: id(r.params.id), user, active: true,
      itemId: { $in: items.map(i => i.id) }, $and: [
        { $or: [{ lease: null }, { lease: { $lt: now } }] },
        { $or: [{ lastAttempt: null }, { lastAttempt: { $lt: new Date(now.getTime() - 60000) } }] },
      ] }, { $set: { lease, lastAttempt: now } }, { new: true });
    if (!link) throw httpError(409, 'BANK_SYNC_BUSY');
    try {
      const accounts = await provider.accounts(items);
      const external = accounts.find(a => a.externalId === link.externalId && a.itemId === link.itemId);
      if (!external) throw httpError(502, 'BANK_DATA_INVALID');
      const rows = await provider.movements(link.externalId);
      const result = await ingestBankRows(link, rows);
      await BankLink.updateOne({ _id: link._id, user, lease }, { $set: { lease: null, lastSuccess: new Date(), error: '',
        balanceCents: external.balanceCents, balanceAt: external.balanceAt } });
      return result;
    } catch (err) {
      await BankLink.updateOne({ _id: link._id, user, lease }, { $set: { lease: null, error: 'BANK_SYNC_FAILED' } });
      throw err;
    }
  });
  app.get('/movements', async r => {
    const state = r.query.state || 'review';
    if (!['review', 'accepted', 'ignored', 'changed'].includes(state)) throw httpError(400, 'INVALID_VALUE', { field: 'state' });
    const page = Number(r.query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw httpError(400, 'INVALID_VALUE', { field: 'page' });
    const filter = { user: r.user.userId, state };
    const [rows, total] = await Promise.all([BankMovement.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * 30).limit(30).lean(), BankMovement.countDocuments(filter)]);
    return { rows: rows.map(row => ({ ...row, canRemember: canRemember(row.pattern) })), total };
  });
  app.get('/movements/:id/candidates', async r => {
    const row = await BankMovement.findOne({ _id: id(r.params.id), user: r.user.userId }).lean();
    if (!row) throw httpError(404, 'NOT_FOUND');
    return bankCandidates(row);
  });
  app.post('/movements/:id/decision', async r => {
    if (!Number.isInteger(r.body?.revision) || r.body.revision < 0) throw httpError(400, 'INVALID_VALUE', { field: 'revision' });
    if (r.body.action === 'transfer') id(r.body.peer);
    if (r.body.action === 'link') id(r.body.entry);
    await decideMovement(r.user.userId, id(r.params.id), r.body);
    return { ok: true };
  });
  app.put('/rules/:id', async r => {
    // Updating a category is explicit when remembering a new decision; this endpoint only deactivates a rule.
    const rule = await BankRule.findOneAndUpdate({ _id: id(r.params.id), user: r.user.userId }, { $set: { active: false } });
    if (!rule) throw httpError(404, 'NOT_FOUND');
    return { ok: true };
  });
}
