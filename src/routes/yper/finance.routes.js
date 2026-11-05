import { FinanceAccount as Account, FinanceEntry as Entry, FinanceEstimate as Estimate } from '../../models/yper/Finance.js';
import { httpError } from '../../lib/errors.js';
import { BankLink, BankMovement } from '../../models/yper/Banking.js';
import { validDate, validMonth, occurrence, projectFinance, addMonth } from '../../services/financeProjection.js';

const fail = field => { throw httpError(400, 'INVALID_VALUE', { field }); };
const text = (value, field, required = false) => {
  if (typeof value !== 'string' || value.length > 160 || (required && !value.trim())) fail(field);
  return value.trim();
};
function cents(value, field, signed = false) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1e9 || (!signed && value < 0)) fail(field);
  return value;
}
function choose(value, values, field) { if (!values.includes(value)) fail(field); return value; }
function day(value, field) { if (!validDate(value)) fail(field); return value; }
function revision(value) { if (!Number.isInteger(value) || value < 0) fail('revision'); return value; }
async function owned(Model, user, id) {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) fail('id');
  const doc = await Model.findOne({ _id: id, user }).lean();
  if (!doc) throw httpError(404, 'NOT_FOUND');
  return doc;
}
async function save(Model, request, data) {
  const user = request.user.userId;
  if (!request.params.id) return Model.create({ ...data, user });
  await owned(Model, user, request.params.id);
  const doc = await Model.findOneAndUpdate({ _id: request.params.id, user, revision: revision(request.body.revision) },
    { $set: data, $inc: { revision: 1 } }, { new: true, runValidators: true });
  if (!doc) throw httpError(409, 'FINANCE_CHANGED');
  return doc;
}

export default async function financeRoutes(app) {
  app.get('/accounts', async r => ({ accounts: await Account.find({ user: r.user.userId }).sort({ createdAt: 1 }).lean() }));
  for (const method of ['post', 'put']) {
    app[method](`/accounts${method === 'put' ? '/:id' : ''}`, async r => {
      const b = r.body || {};
      return { account: await save(Account, r, { name: text(b.name, 'name', true), kind: choose(b.kind, ['operational', 'reserve'], 'kind'),
        openingDate: day(b.openingDate, 'openingDate'), openingBalanceCents: b.openingBalanceCents === null ? null : cents(b.openingBalanceCents, 'openingBalanceCents', true) }) };
    });
  }
  app.get('/entries', async r => ({ entries: await Entry.find({ user: r.user.userId }).sort({ date: -1 }).limit(2001).lean() }));
  for (const method of ['post', 'put']) {
    app[method](`/entries${method === 'put' ? '/:id' : ''}`, async r => {
      const b = r.body || {}; const user = r.user.userId;
      const account = await owned(Account, user, b.account);
      const type = choose(b.type, ['income', 'expense', 'transfer', 'reimbursement'], 'type');
      if (type === 'transfer') {
        await owned(Account, user, b.toAccount);
        if (String(account._id) === b.toAccount) fail('toAccount');
      }
      const repeat = choose(b.repeat, ['once', 'monthly', 'installments'], 'repeat');
      const date = day(b.date, 'date');
      const amountCents = cents(b.amountCents, 'amountCents'); if (!amountCents) fail('amountCents');
      const endDate = b.endDate ? day(b.endDate, 'endDate') : '';
      if (endDate && endDate < date) fail('endDate');
      const installment = repeat === 'installments' ? b.installment : 1;
      const totalInstallments = repeat === 'installments' ? b.totalInstallments : 1;
      if (![installment, totalInstallments].every(n => Number.isInteger(n) && n >= 1 && n <= 600) || installment > totalInstallments
        || !validMonth(addMonth(date.slice(0, 7), totalInstallments - installment))) fail('installments');
      const group = type === 'expense' ? choose(b.group, ['direct', 'card', 'financing'], 'group') : 'direct';
      const creditor = text(b.creditor || '', 'creditor', group !== 'direct');
      if (r.params.id) {
        const previous = await owned(Entry, user, r.params.id);
        if (previous.overrides.length) throw httpError(409, 'FINANCE_HISTORY_LOCKED');
      }
      return { entry: await save(Entry, r, { description: text(b.description, 'description', true), type, account: account._id,
        toAccount: type === 'transfer' ? b.toAccount : null, category: text(b.category || '', 'category', type === 'expense'),
        counterpart: text(b.counterpart || '', 'counterpart'), group, creditor, amountCents, date, repeat, installment, totalInstallments, endDate }) };
    });
  }
  app.put('/entries/:id/occurrences/:month', async r => {
    const entry = await owned(Entry, r.user.userId, r.params.id);
    if (entry.bankSource || entry.overrides.some(o => o.month === r.params.month && o.bankMovement)) throw httpError(409, 'BANK_MANAGED_ENTRY');
    if (!validMonth(r.params.month) || !occurrence(entry, r.params.month)) fail('month');
    const status = choose(r.body?.status, ['planned', 'paid', 'cancelled'], 'status');
    const paidDate = status === 'paid' ? day(r.body.paidDate, 'paidDate') : '';
    const overrides = entry.overrides.filter(o => o.month !== r.params.month);
    if (status !== 'planned') overrides.push({ month: r.params.month, status, paidDate });
    return { entry: await save(Entry, r, { overrides }) };
  });
  app.get('/estimates', async r => ({ estimates: await Estimate.find({ user: r.user.userId }).sort({ month: 1 }).lean() }));
  for (const method of ['post', 'put']) {
    app[method](`/estimates${method === 'put' ? '/:id' : ''}`, async r => {
      const b = r.body || {};
      await owned(Account, r.user.userId, b.account);
      if (!validMonth(b.month)) fail('month');
      return { estimate: await save(Estimate, r, { month: b.month, category: text(b.category, 'category', true), account: b.account, amountCents: cents(b.amountCents, 'amountCents') }) };
    });
  }
  for (const [path, Model] of [['accounts', Account], ['entries', Entry], ['estimates', Estimate]]) {
    app.delete(`/${path}/:id`, async r => {
      const doc = await owned(Model, r.user.userId, r.params.id);
      if (Model === Account && (await Entry.exists({ user: r.user.userId, $or: [{ account: doc._id }, { toAccount: doc._id }] })
        || await Estimate.exists({ user: r.user.userId, account: doc._id })
        || await BankLink.exists({ user: r.user.userId, account: doc._id }))) throw httpError(409, 'FINANCE_ACCOUNT_USED');
      if (Model === Entry && doc.overrides.some(o => o.status === 'paid')) throw httpError(409, 'FINANCE_HISTORY_LOCKED');
      const result = await Model.deleteOne({ _id: doc._id, user: r.user.userId, revision: revision(Number(r.query.revision)) });
      if (!result.deletedCount) throw httpError(409, 'FINANCE_CHANGED');
      return { ok: true };
    });
  }
  app.get('/projection', async r => {
    const from = r.query.from; const count = Number(r.query.count || 12);
    const today = r.query.today || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (!validMonth(from) || ![3, 6, 12].includes(count) || !validMonth(addMonth(from, count - 1)) || !validDate(today)) fail('period');
    const user = r.user.userId;
    if (r.query.account) await owned(Account, user, r.query.account);
    const [accounts, entries, estimates, bankLinks] = await Promise.all([Account.find({ user }).lean(), Entry.find({ user }).limit(2001).lean(), Estimate.find({ user }).lean(), BankLink.find({ user }).lean()]);
    if (entries.length > 2000) throw httpError(400, 'FINANCE_TOO_LARGE');
    const bankPending = await BankMovement.countDocuments({ user, state: { $in: ['review', 'changed'] } });
    const projection = projectFinance({ accounts, entries, estimates, from, count, today, accountId: r.query.account || '' });
    projection.accounts = projection.accounts.map(account => {
      const link = bankLinks.find(l => String(l.account) === String(account._id));
      return link ? { ...account, bankBalanceCents: link.balanceCents ?? null, bankBalanceAt: link.balanceAt,
        bankLastSuccess: link.lastSuccess, bankError: link.error || '' } : account;
    });
    return { ...projection, bankPending };
  });
}
