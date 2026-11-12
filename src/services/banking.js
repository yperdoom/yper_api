import mongoose from 'mongoose';
import { BankLink, BankMovement as Movement, BankRule as Rule, BankAudit, BankSyncGuard } from '../models/yper/Banking.js';
import { FinanceAccount as Account, FinanceEntry as Entry } from '../models/yper/Finance.js';
import { httpError } from '../lib/errors.js';
import { occurrence, validMonth, addMonth } from './financeProjection.js';
import { canRemember, normalizedPattern } from './pluggy.js';

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
async function ensureGuard(user) {
  await BankSyncGuard.init();
  try { await BankSyncGuard.updateOne({ user }, { $setOnInsert: { revision: 0 } }, { upsert: true }); }
  catch (e) { if (e.code !== 11000) throw e; }
}
const plain = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function mentionsOwner(row) {
  const owner = plain(process.env.OPEN_FINANCE_OWNER_NAME || '');
  return Boolean(owner) && plain(row.description || row.pattern).includes(owner);
}
function specialReason(row) {
  if (row.sameOwner === true) return 'transfer';
  const description = row.pattern.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/FATURA|ESTORNO|RESGATE|APLIC|PORTABILIDADE|CREDITO_CONTRATADO/.test(row.operationType || '')
    || /\b(fatura|estorno|resgate|aplicacao|portabilidade)\b/.test(description)
    || /\b(pagamento|pagto|pgto)\b.*\bcartao\b/.test(description)) return 'special';
  if (row.sameOwner !== false && (/^(PIX|TED|DOC|TRANSFERENCIA)/.test(row.operationType || '')
    || /\b(pix|ted|doc|transferencia)\b/.test(description))) {
    // Without ownership data, a configured owner name separates own transfers from payments to third parties.
    return !process.env.OPEN_FINANCE_OWNER_NAME || mentionsOwner(row) ? 'transfer' : '';
  }
  return '';
}
const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * 86400000;
function candidateOccurrences(entry, row) {
  const month = row.date.slice(0, 7);
  const months = [...new Set([addMonth(month, -1), month, addMonth(month, 1),
    ...(entry.overrides || []).filter(o => o.paidDate === row.date).map(o => o.month)])];
  return months.map(m => occurrence(entry, m)).filter(item => item && item.status !== 'cancelled'
    && (item.month === month || near(item.paidDate || item.dueDate, row.date)));
}

async function applyAutomatic(user, session) {
  // The caller holds this owner's transactional guard, including reads of different banks.
  const activeLinks = await BankLink.find({ user, active: true }).session(session).lean();
  const activeIds = activeLinks.map(l => l._id);
  const rows = await Movement.find({ user }).session(session);
  const entries = await Entry.find({ user }).session(session);
  const rules = await Rule.find({ user, active: true }).session(session).lean();
  const stats = { imported: 0, transfers: 0, categorized: 0, updated: 0 };
  // Writes are collected and flushed in bulk: one round trip per collection instead of several per movement.
  const audits = []; const prepared = new Map();
  const note = (row, action, detail) => audits.push({ user, movement: row._id, action, detail });
  const ready = async accountId => {
    const key = String(accountId);
    if (!prepared.has(key)) prepared.set(key, await readyAccount(accountId, user, session));
  };
  const active = row => activeIds.some(id => String(id) === String(row.link));
  const eligible = row => active(row) && row.state === 'review' && !row.manualHold && row.bankStatus === 'POSTED' && row.date <= bankToday();
  for (const row of rows) {
    if (active(row) && row.state === 'changed' && ['new', 'auto'].includes(row.decision) && !row.peer
      && row.bankStatus === 'POSTED' && row.date <= bankToday() && !specialReason(row)) {
      const entry = entries.find(e => String(e._id) === String(row.entry) && e.bankSource === String(row._id) && e.type === row.direction);
      if (entry) {
        const previous = { amountCents: entry.amountCents, date: entry.date };
        entry.amountCents = row.amountCents; entry.date = row.date; entry.description = row.description.slice(0, 160);
        entry.overrides = [{ month: row.date.slice(0, 7), status: 'paid', paidDate: row.date }]; entry.revision++;
        row.state = 'accepted'; row.reviewReason = ''; row.revision++;
        note(row, 'auto-update', { previous, amountCents: row.amountCents, date: row.date }); stats.updated++;
      }
    }
    if (active(row) && row.state === 'accepted' && !row.category && ['new', 'auto'].includes(row.decision)) {
      const rule = ruleFor(row, rules);
      const entry = rule && entries.find(e => String(e._id) === String(row.entry) && e.bankSource === String(row._id));
      if (entry) {
        row.category = rule.category; row.categorySource = 'rule'; row.rule = rule._id; row.revision++;
        entry.category = rule.category; entry.revision++;
        note(row, 'auto-category', { category: rule.category, rule: rule._id }); stats.categorized++;
      }
    }
    if (!eligible(row)) continue;
    const reason = specialReason(row);
    // A common reference + equal ownership on both legs is stronger than value/date similarity.
    const opposite = p => p !== row && eligible(p) && p.direction !== row.direction
      && String(p.account) !== String(row.account) && p.amountCents === row.amountCents;
    const peers = reason !== 'transfer' ? []
      : row.sameOwner === true && row.transferReference
        ? rows.filter(p => opposite(p) && p.sameOwner === true && p.transferReference === row.transferReference && p.date === row.date)
        : mentionsOwner(row) ? rows.filter(p => opposite(p) && mentionsOwner(p) && Math.abs(Date.parse(p.date) - Date.parse(row.date)) <= 86400000) : [];
    const manualMatches = entries.filter(e => !e.bankSource && (String(e.account) === String(row.account) || String(e.toAccount) === String(row.account)))
      .flatMap(e => candidateOccurrences(e, row).map(item => ({ entry: e, item })))
      .filter(({ entry: e, item }) => item && item.status !== 'cancelled' && (e.type === row.direction || e.type === 'transfer')
        && (item.amountCents === row.amountCents || normalizedPattern(e.description) === row.pattern));
    const duplicate = rows.some(p => p !== row && p.state !== 'ignored' && String(p.account) === String(row.account)
      && p.direction === row.direction && p.pattern === row.pattern && (p.amountCents === row.amountCents ? near(p.date, row.date) : p.date === row.date)
      && !(p.transferReference && row.transferReference && p.transferReference !== row.transferReference)
      && !(p.providerId && row.providerId && p.providerId !== row.providerId));
    let hold = manualMatches.length ? 'existing' : reason || (duplicate ? 'duplicate' : '');
    if (peers.length === 1 && !manualMatches.length && !duplicate) {
      const peer = peers[0];
      const peerManual = entries.some(e => !e.bankSource && (String(e.account) === String(peer.account) || String(e.toAccount) === String(peer.account))
        && candidateOccurrences(e, peer).some(item => item.amountCents === peer.amountCents));
      if (!peerManual && entries.length < 2000) {
        const debit = row.direction === 'expense' ? row : peer; const credit = row.direction === 'income' ? row : peer;
        await ready(debit.account); await ready(credit.account);
        const entry = new Entry({ user, bankSource: String(debit._id), description: debit.description.slice(0, 160),
          type: 'transfer', account: debit.account, toAccount: credit.account, amountCents: debit.amountCents, date: debit.date,
          overrides: [{ month: debit.date.slice(0, 7), status: 'paid', paidDate: debit.date }] });
        entries.push(entry);
        for (const [movement, other] of [[row, peer], [peer, row]]) {
          movement.entry = entry._id; movement.peer = other._id; movement.state = 'accepted'; movement.decision = 'transfer'; movement.reviewReason = ''; movement.revision++;
          note(movement, 'auto-transfer', { entry: entry._id });
        }
        stats.transfers++; continue;
      }
    }
    if (!hold && entries.length >= 2000) hold = 'limit';
    if (hold) {
      if (row.reviewReason !== hold) { row.reviewReason = hold; row.revision++; }
      continue;
    }
    await ready(row.account);
    const rule = !row.category && ruleFor(row, rules);
    if (rule) { row.category = rule.category; row.categorySource = 'rule'; row.rule = rule._id; }
    const entry = new Entry({ user, bankSource: String(row._id), description: row.description.slice(0, 160),
      type: row.direction, account: row.account, category: row.category || '', amountCents: row.amountCents, date: row.date,
      overrides: [{ month: row.date.slice(0, 7), status: 'paid', paidDate: row.date }] });
    entries.push(entry); row.entry = entry._id; row.state = 'accepted'; row.decision = 'auto'; row.reviewReason = ''; row.revision++;
    note(row, 'auto-import', { entry: entry._id }); stats.imported++;
  }
  await Entry.bulkSave(entries, { session });
  await Movement.bulkSave(rows, { session });
  if (audits.length) await BankAudit.insertMany(audits, { session });
  return stats;
}

export async function ingestBankRows(link, rows, { automatic = false } = {}) {
  if (automatic) await ensureGuard(link.user);
  return bankTransaction(async session => {
    if (automatic) await BankSyncGuard.updateOne({ user: link.user }, { $inc: { revision: 1 } }, { session });
    const rules = await Rule.find({ user: link.user, active: true }).session(session).lean();
    let added = 0;
    // One read for the link's history; identity lookups then happen in memory.
    const known = await Movement.find({ user: link.user, link: link._id }).session(session);
    const byAlias = new Map(); const byProvider = new Map();
    const index = doc => { for (const alias of doc.aliases) byAlias.set(alias, doc); if (doc.providerId) byProvider.set(doc.providerId, doc); };
    known.forEach(index);
    for (const row of rows) {
      const matches = [...new Set([byAlias.get(row.aliases[0]), row.providerId && byProvider.get(row.providerId)].filter(Boolean))];
      if (matches.length > 1) throw httpError(409, 'BANK_IDENTITY_CONFLICT');
      const existing = matches[0];
      if (existing) {
        const financialChange = ['date', 'amountCents', 'direction', 'bankStatus'].some(k => existing[k] !== row[k]);
        const difference = financialChange || ['description', 'pattern', 'providerId', 'operationType', 'transferReference', 'sameOwner'].some(k => existing[k] !== row[k]);
        const aliases = [...new Set([...existing.aliases, ...row.aliases])];
        const rule = !existing.category && existing.state === 'review' ? ruleFor({ ...row, account: link.account }, rules) : null;
        if (difference || aliases.length !== existing.aliases.length || rule) {
          if (existing.state === 'accepted' && (financialChange || (existing.decision === 'auto' && specialReason(row)))) {
            existing.state = 'changed'; existing.reviewReason = 'changed';
          }
          // Keep the original manual classification and the accepted ledger until explicit review.
          Object.assign(existing, row, { aliases, revision: existing.revision + 1 });
          if (rule) Object.assign(existing, { category: rule.category, categorySource: 'rule', rule: rule._id });
          index(existing);
        }
        continue;
      }
      const data = { ...row, user: link.user, link: link._id, account: link.account };
      const rule = ruleFor(data, rules);
      if (rule) Object.assign(data, { category: rule.category, categorySource: 'rule', rule: rule._id });
      const created = new Movement(data); known.push(created); index(created); added++;
    }
    await Movement.bulkSave(known, { session });
    return { added, ...(automatic ? await applyAutomatic(link.user, session) : {}) };
  });
}
export async function bankCandidates(row) {
  const from = new Date(`${row.date}T12:00:00Z`); from.setUTCDate(from.getUTCDate() - 3);
  const to = new Date(`${row.date}T12:00:00Z`); to.setUTCDate(to.getUTCDate() + 3);
  const nearby = await Movement.find({ user: row.user, _id: { $ne: row._id }, amountCents: row.amountCents,
    date: { $gte: from.toISOString().slice(0, 10), $lte: to.toISOString().slice(0, 10) } }).limit(30).lean();
  const entries = await Entry.find({ user: row.user, account: row.account, type: row.direction, bankSource: { $exists: false },
    amountCents: row.amountCents }).limit(100).lean();
  const manual = entries.flatMap(e => candidateOccurrences(e, row));
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
          peer.manualHold = true;
          await peer.save({ session }); await audit(user, peer, 'undo', {}, session);
        }
      }
      await audit(user, row, action, { entry: row.entry, previous: row.state }, session);
      row.state = 'review'; row.entry = undefined; row.peer = undefined; row.decision = ''; row.previousOverride = undefined;
      row.manualHold = true;
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

export async function categorizeMovements(user, body) {
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100
    || body.items.some(i => !i || typeof i.id !== 'string' || !/^[a-f\d]{24}$/i.test(i.id) || !Number.isInteger(i.revision) || i.revision < 0)
    || new Set(body.items.map(i => i.id)).size !== body.items.length
    || typeof body.category !== 'string' || !body.category.trim() || body.category.length > 160
    || (body.remember && !['account', 'all'].includes(body.scope))) throw httpError(400, 'INVALID_VALUE', { field: 'category' });
  return bankTransaction(async session => {
    for (const item of body.items) {
      const row = await Movement.findOne({ _id: item.id, user }).session(session);
      if (!row) throw httpError(404, 'NOT_FOUND');
      if (row.revision !== item.revision || row.state !== 'accepted' || !['new', 'auto'].includes(row.decision)) changed();
      const entry = await Entry.findOne({ _id: row.entry, user, bankSource: String(row._id) }).session(session);
      if (!entry) changed();
      const previous = row.category;
      row.category = body.category.trim(); row.categorySource = 'manual'; row.rule = undefined; row.revision++;
      entry.category = row.category; entry.revision++;
      await entry.save({ session }); await row.save({ session });
      await audit(user, row, 'category', { previous, category: row.category }, session);
      if (body.remember) {
        if (!canRemember(row.pattern)) throw httpError(400, 'BANK_RULE_INVALID');
        const scope = body.scope === 'all' ? '*' : String(row.account);
        const rule = await Rule.findOneAndUpdate({ user, pattern: row.pattern, direction: row.direction, scope },
          { $set: { category: row.category, since: bankToday(), active: true } }, { upsert: true, new: true, session });
        await audit(user, row, 'remember', { rule: rule._id, category: row.category, since: rule.since, scope }, session);
      }
    }
    return { categorized: body.items.length };
  });
}
