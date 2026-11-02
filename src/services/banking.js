import mongoose from 'mongoose';
import { BankLink, BankMovement as Movement, BankRule as Rule, BankAudit } from '../models/yper/Banking.js';
import { FinanceAccount as Account, FinanceEntry as Entry } from '../models/yper/Finance.js';
import { httpError } from '../lib/errors.js';
import { occurrence, validMonth } from './financeProjection.js';
import { canRemember } from './pluggy.js';

export const bankToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const changed = () => { throw httpError(409, 'FINANCE_CHANGED'); };
export async function bankTransaction(fn) {
  try { return await mongoose.connection.transaction(fn); }
  catch (err) {
    if (err.code === 20 || err.codeName === 'IllegalOperation') throw httpError(503, 'BANK_REPLICA_REQUIRED');
    throw err;
  }
}
export function ruleFor(row, rules) {
  const matches = rules.filter(r => r.active && r.pattern === row.pattern && r.direction === row.direction
    && row.date >= r.since && (r.scope === '*' || r.scope === String(row.account)));
  return matches.find(r => r.scope !== '*') || matches.find(r => r.scope === '*');
}
export async function ingestBankRows(link, rows) {
  return bankTransaction(async session => {
    const rules = await Rule.find({ user: link.user, active: true }).session(session).lean();
    let added = 0;
    for (const row of rows) {
      const alternatives = [{ aliases: row.aliases[0] }];
      if (row.providerId) alternatives.push({ providerId: row.providerId });
      const matches = await Movement.find({ user: link.user, link: link._id, $or: alternatives }).session(session);
      if (matches.length > 1) throw httpError(409, 'BANK_IDENTITY_CONFLICT');
      const existing = matches[0];
      if (existing) {
        const financialChange = ['date', 'amountCents', 'direction', 'bankStatus'].some(k => existing[k] !== row[k]);
        const difference = financialChange || ['description', 'pattern', 'providerId'].some(k => existing[k] !== row[k]);
        const aliases = [...new Set([...existing.aliases, ...row.aliases])];
        const rule = !existing.category && existing.state === 'review' ? ruleFor({ ...row, account: link.account }, rules) : null;
        if (difference || aliases.length !== existing.aliases.length || rule) {
          if (financialChange && existing.state === 'accepted') existing.state = 'changed';
          // Keep the original manual classification and the accepted ledger until explicit review.
          Object.assign(existing, row, { aliases, revision: existing.revision + 1 });
          if (rule) Object.assign(existing, { category: rule.category, categorySource: 'rule', rule: rule._id });
          await existing.save({ session });
        }
        continue;
      }
      const data = { ...row, user: link.user, link: link._id, account: link.account };
      const rule = ruleFor(data, rules);
      if (rule) Object.assign(data, { category: rule.category, categorySource: 'rule', rule: rule._id });
      await Movement.create([data], { session }); added++;
    }
    return { added };
  });
}
export async function bankCandidates(row) {
  const from = new Date(`${row.date}T12:00:00Z`); from.setUTCDate(from.getUTCDate() - 3);
  const to = new Date(`${row.date}T12:00:00Z`); to.setUTCDate(to.getUTCDate() + 3);
  const nearby = await Movement.find({ user: row.user, _id: { $ne: row._id }, amountCents: row.amountCents,
    date: { $gte: from.toISOString().slice(0, 10), $lte: to.toISOString().slice(0, 10) } }).limit(30).lean();
  const entries = await Entry.find({ user: row.user, account: row.account, type: row.direction, bankSource: { $exists: false },
    amountCents: row.amountCents }).limit(100).lean();
  const manual = entries.map(e => occurrence(e, row.date.slice(0, 7))).filter(e => e && e.status !== 'cancelled');
  return { manual, similar: nearby.filter(r => String(r.account) === String(row.account) && r.direction === row.direction),
    transfers: nearby.filter(r => String(r.account) !== String(row.account) && r.direction !== row.direction && r.state === 'review' && r.bankStatus === 'POSTED') };
}
async function audit(user, row, action, detail, session) {
  await BankAudit.create([{ user, movement: row._id, action, detail }], { session });
}
async function readyAccount(id, user, session) {
  const account = await Account.findOne({ _id: id, user }).session(session);
  if (!account) throw httpError(404, 'NOT_FOUND');
  // Touch the account so concurrent deletion conflicts with this transaction.
  account.revision++; await account.save({ session }); return account;
}
export async function decideMovement(user, id, body) {
  return bankTransaction(async session => {
    const row = await Movement.findOne({ _id: id, user }).session(session);
    if (!row) throw httpError(404, 'NOT_FOUND');
    if (row.revision !== body.revision) changed();
    const action = body.action;
    if (action === 'undo') {
      if (!['accepted', 'changed', 'ignored'].includes(row.state)) changed();
      if (row.entry) {
        const entry = await Entry.findOne({ _id: row.entry, user }).session(session);
        if (!entry) changed();
        if (row.decision === 'link') {
          const state = entry.overrides.find(o => o.month === row.month);
          if (String(state?.bankMovement) !== String(row._id)) changed();
          entry.overrides = entry.overrides.filter(o => o.month !== row.month);
          if (row.previousOverride) entry.overrides.push(row.previousOverride);
          entry.revision++; await entry.save({ session });
        } else {
          if (entry.bankSource !== String(row._id) && (!row.peer || entry.bankSource !== String(row.peer))) changed();
          await Entry.deleteOne({ _id: entry._id, user }).session(session);
        }
        if (row.peer) {
          const peer = await Movement.findOne({ _id: row.peer, user, entry: row.entry }).session(session);
          if (!peer) changed();
          peer.state = 'review'; peer.entry = undefined; peer.peer = undefined; peer.decision = ''; peer.revision++;
          await peer.save({ session }); await audit(user, peer, 'undo', {}, session);
        }
      }
      await audit(user, row, action, { entry: row.entry, previous: row.state }, session);
      row.state = 'review'; row.entry = undefined; row.peer = undefined; row.decision = ''; row.previousOverride = undefined;
    } else if (action === 'ignore') {
      if (row.state !== 'review' || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 160) throw httpError(400, 'INVALID_VALUE', { field: 'reason' });
      row.state = 'ignored'; row.decision = 'ignore';
      await audit(user, row, action, { reason: body.reason.trim() }, session);
    } else {
      if (row.state !== 'review' || row.bankStatus !== 'POSTED') changed();
      await readyAccount(row.account, user, session);
      if (['new', 'transfer'].includes(action) && await Entry.countDocuments({ user }).session(session) >= 2000) throw httpError(400, 'FINANCE_TOO_LARGE');
      if (action === 'transfer') {
        const peer = await Movement.findOne({ _id: body.peer, user }).session(session);
        if (!peer || peer.state !== 'review' || peer.bankStatus !== 'POSTED' || peer.amountCents !== row.amountCents
          || peer.direction === row.direction || String(peer.account) === String(row.account)) throw httpError(400, 'BANK_TRANSFER_INVALID');
        // Until the ledger supports separate settlement dates, do not flatten dates silently.
        if (peer.date !== row.date) throw httpError(400, 'BANK_TRANSFER_DATE');
        await readyAccount(peer.account, user, session);
        const debit = row.direction === 'expense' ? row : peer; const credit = row.direction === 'income' ? row : peer;
        const [entry] = await Entry.create([{ user, bankSource: String(debit._id), description: debit.description.slice(0, 160),
          type: 'transfer', account: debit.account, toAccount: credit.account, amountCents: debit.amountCents, date: debit.date,
          overrides: [{ month: debit.date.slice(0, 7), status: 'paid', paidDate: debit.date }] }], { session });
        row.entry = entry._id; peer.entry = entry._id; row.peer = peer._id; peer.peer = row._id;
        peer.state = 'accepted'; peer.decision = 'transfer'; peer.revision++;
        await peer.save({ session }); await audit(user, peer, action, { entry: entry._id }, session);
      } else if (action === 'link') {
        if (!validMonth(body.month)) throw httpError(400, 'INVALID_VALUE', { field: 'month' });
        const entry = await Entry.findOne({ _id: body.entry, user, bankSource: { $exists: false } }).session(session);
        const item = entry && occurrence(entry.toObject(), body.month);
        if (!item || item.status === 'cancelled' || item.type !== row.direction || item.account !== String(row.account)
          || item.amountCents !== row.amountCents || item.group !== 'direct') throw httpError(400, 'BANK_MATCH_INVALID');
        const previous = entry.overrides.find(o => o.month === body.month);
        if (previous?.bankMovement) changed();
        row.previousOverride = previous?.toObject(); row.month = body.month;
        entry.overrides = entry.overrides.filter(o => o.month !== body.month);
        entry.overrides.push({ month: body.month, status: 'paid', paidDate: row.date, bankMovement: row._id });
        entry.revision++; await entry.save({ session }); row.entry = entry._id; row.category = entry.category;
      } else if (action === 'new') {
        if (typeof body.category !== 'string' || !body.category.trim() || body.category.length > 160) throw httpError(400, 'INVALID_VALUE', { field: 'category' });
        row.categorySource = row.categorySource === 'rule' && body.category.trim() === row.category ? 'rule' : 'manual';
        row.category = body.category.trim();
        const [entry] = await Entry.create([{ user, bankSource: String(row._id), description: row.description.slice(0, 160),
          type: row.direction, account: row.account, category: row.category, amountCents: row.amountCents, date: row.date,
          overrides: [{ month: row.date.slice(0, 7), status: 'paid', paidDate: row.date }] }], { session });
        row.entry = entry._id;
        if (body.remember) {
          if (!canRemember(row.pattern) || !['account', 'all'].includes(body.scope)) throw httpError(400, 'BANK_RULE_INVALID');
          const scope = body.scope === 'all' ? '*' : String(row.account);
          // Explicit category choices may update the rule for future facts, never old entries.
          const rule = await Rule.findOneAndUpdate({ user, pattern: row.pattern, direction: row.direction, scope },
            { $set: { category: row.category, since: bankToday(), active: true } }, { upsert: true, new: true, session });
          await audit(user, row, 'remember', { rule: rule._id, category: row.category, since: rule.since, scope }, session);
        }
      } else throw httpError(400, 'INVALID_VALUE', { field: 'action' });
      row.state = 'accepted'; row.decision = action;
      await audit(user, row, action, { entry: row.entry, category: row.category }, session);
    }
    row.revision++; await row.save({ session }); return row;
  });
}
