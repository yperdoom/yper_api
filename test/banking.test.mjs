import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { BankLink, BankMovement, BankRule, BankAudit } from '../src/models/yper/Banking.js';
import { FinanceAccount, FinanceEntry } from '../src/models/yper/Finance.js';
import { createPluggyProvider, normalizeMovement, normalizeCardMovement, bankCents } from '../src/services/pluggy.js';
import { ingestBankRows, bankToday } from '../src/services/banking.js';

const today = bankToday();
const raw = (id, accountId = 'nubank-external', amount = -120) => ({ id, accountId, amount, description: 'Academia X', date: `${today}T00:00:00Z`, currencyCode: 'BRL', type: amount < 0 ? 'DEBIT' : 'CREDIT', status: 'POSTED' });
assert.equal(bankCents(0.29), 29);
assert.throws(() => bankCents(1.001));
assert.throws(() => normalizeMovement({ ...raw('x'), type: 'CREDIT' }, 'nubank-external'));
assert.throws(() => normalizeMovement({ ...raw('x'), currencyCode: 'USD' }, 'nubank-external'));
assert.equal(normalizeMovement(raw('x'), 'nubank-external').date, today);
const urls = [];
const realAdapter = createPluggyProvider(async (url, options) => {
  urls.push(url);
  assert.ok(url.startsWith('https://api.pluggy.ai/'));
  if (url.endsWith('/auth')) return { ok: true, json: async () => ({ apiKey: 'synthetic' }) };
  assert.equal(options.headers['X-API-KEY'], 'synthetic');
  return { ok: true, json: async () => ({ results: [raw(url.includes('after=') ? 'two' : 'one')], next: url.includes('after=') ? null : '?accountId=untrusted-other-account&after=a%2Bb%3D' }) };
});
assert.equal((await realAdapter.movements('nubank-external')).length, 2);
assert.ok(urls.at(-1).includes('accountId=nubank-external&after=a%2Bb%3D'));
const cardAdapter = createPluggyProvider(async url => url.endsWith('/auth') ? { ok: true, json: async () => ({ apiKey: 'synthetic' }) }
  : { ok: true, json: async () => ({ totalPages: 1, results: [
    { id: 'checking', itemId: 'nubank', type: 'BANK', currencyCode: 'BRL', name: 'Conta', number: '1234', balance: 10 },
    { id: 'card', itemId: 'nubank', type: 'CREDIT', subtype: 'CREDIT_CARD', currencyCode: 'BRL', name: 'Ultravioleta', number: '9876', balance: 3456.92 }] }) });
const discovered = await cardAdapter.accounts([{ id: 'nubank', bank: 'Nubank' }]);
assert.deepEqual(discovered.map(a => a.kind), ['account', 'card'], 'credit cards are discovered alongside accounts');
assert.equal(discovered[1].balanceCents, -345692, 'card balance is a debt');
const failingAdapter = createPluggyProvider(async () => ({ ok: false, json: async () => ({ secret: 'never-return' }) }));
await assert.rejects(() => failingAdapter.accounts([]), e => e.code === 'BANK_PROVIDER_UNAVAILABLE' && !e.message.includes('never-return'));

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.JWT_SECRET = 'banking-test-only';
process.env.PLUGGY_CLIENT_ID = 'test'; process.env.PLUGGY_CLIENT_SECRET = 'test';
process.env.PLUGGY_ITEMS_JSON = JSON.stringify([{ id: 'nubank', bank: 'Nubank' }, { id: 'inter', bank: 'Inter' }, { id: 'mp', bank: 'Mercado Pago' }]);
let failRead = false;
const sourceAccounts = ['nubank', 'inter', 'mp'].map((itemId, index) => ({ itemId, externalId: `${itemId}-external`, bank: ['Nubank','Inter','Mercado Pago'][index], name: itemId, balanceCents: 100000, balanceAt: new Date() }));
const thisMonth = today.slice(0, 7);
const nextMonth = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5)), 15)).toISOString().slice(0, 7);
const cardRaw = (id, description, amount, date, status, meta) => normalizeCardMovement({ id, accountId: 'nubank-card', description, amount,
  date: `${date}T00:00:00.000Z`, type: 'DEBIT', status, currencyCode: 'BRL', creditCardMetadata: meta }, 'nubank-card');
let cardRows = [];
const cardBills = [{ id: 'bill-now', closingDate: `${thisMonth}-09`, dueDate: `${thisMonth}-16`, totalCents: 50000 }];
const provider = { bills: async () => cardBills, accounts: async () => sourceAccounts, movements: async externalId => {
  if (failRead) throw new Error('synthetic-failure');
  if (externalId === 'nubank-card') return cardRows;
  return [normalizeMovement(raw('first', externalId), externalId)];
} };
const app = buildApp({ bankProvider: provider });
try {
  await mongoose.connect(mongo.getUri(), { dbName: 'banking-test' });
  await Promise.all([BankLink.init(), BankMovement.init(), BankRule.init(), BankAudit.init(), FinanceAccount.init(), FinanceEntry.init()]);
  const setup = (await app.inject({ method: 'POST', url: '/auth/setup', payload: { email: 'banking@test.com', password: 'secret123' } })).json();
  const user = setup.user.id; process.env.OPEN_FINANCE_OWNER_ID = user;
  const headers = { authorization: `Bearer ${setup.token}` };
  const call = (method, path, payload, h = headers) => app.inject({ method, url: `/yper/finance${path}`, payload, headers: h });
  assert.equal((await call('GET', '/banking', undefined, {})).statusCode, 401);
  const accounts = [];
  for (const source of sourceAccounts) {
    accounts.push((await call('POST', '/accounts', { name: source.bank, kind: 'operational', openingDate: `${today.slice(0, 7)}-01`, openingBalanceCents: 100000 })).json().account);
    const response = await call('POST', '/banking/links', { externalId: source.externalId, account: accounts.at(-1)._id });
    assert.equal(response.statusCode, 200, response.body);
  }
  const links = await BankLink.find({ user }).sort({ createdAt: 1 });
  assert.equal((await call('DELETE', `/accounts/${accounts[0]._id}?revision=1`)).statusCode, 409);
  assert.equal((await call('POST', '/banking/links', { externalId: sourceAccounts[0].externalId, account: accounts[0]._id })).statusCode, 409);
  const sync = await call('POST', `/banking/links/${links[0]._id}/sync`, {});
  assert.equal(sync.statusCode, 200, sync.body);
  const projection = (await call('GET', `/projection?from=${today.slice(0, 7)}&count=3&today=${today}`)).json();
  const connected = projection.accounts.find(a => a._id === accounts[0]._id);
  assert.equal(connected.bankBalanceCents, 100000, 'reported balance is a snapshot, not a new opening balance plus transactions');
  assert.equal(connected.currentBalanceCents, 88000, 'ledger-based projections remain separate from the reported balance');
  // Without an opening balance, the last reported bank balance anchors the projection from the next day on.
  await FinanceAccount.updateOne({ _id: accounts[1]._id }, { openingBalanceCents: null });
  const later = projection.months[2].month;
  await FinanceEntry.create({ user, account: accounts[1]._id, description: 'Plano', type: 'expense', amountCents: 5000, date: `${later}-15`, repeat: 'once', category: 'Casa' });
  const anchored = (await call('GET', `/projection?from=${today.slice(0, 7)}&count=3&today=${today}`)).json();
  const balanceOf = (month, id) => month.balances.find(b => b.id === id).balanceCents;
  assert.equal(anchored.accounts.find(a => a._id === accounts[1]._id).balanceSource, 'bank');
  assert.equal(balanceOf(anchored.months[1], accounts[1]._id), 100000);
  assert.equal(balanceOf(anchored.months[2], accounts[1]._id), 95000);
  assert.equal(anchored.accounts.find(a => a._id === accounts[0]._id).balanceSource, undefined, 'a manual opening balance takes precedence');
  await FinanceEntry.deleteOne({ description: 'Plano' }); await FinanceAccount.updateOne({ _id: accounts[1]._id }, { openingBalanceCents: 100000 });
  assert.equal((await call('POST', `/banking/links/${links[0]._id}/sync`, {})).statusCode, 409);
  await ingestBankRows(links[0], [normalizeMovement(raw('first'), 'nubank-external')]);
  assert.equal(await BankMovement.countDocuments(), 1, 'repeated sync is idempotent');
  let row = await BankMovement.findOne();
  const decision = (row, body) => call('POST', `/banking/movements/${row._id}/decision`, { revision: row.revision, ...body });
  assert.equal(row.state, 'accepted', 'sync automatically includes confirmed, unambiguous transactions');
  const accepted = await call('POST', '/banking/categorize', { items: [{ id: String(row._id), revision: row.revision }], category: 'Academia', remember: true, scope: 'all' });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await decision(row, { action: 'new', category: 'Academia' })).statusCode, 409);
  assert.equal(await FinanceEntry.countDocuments(), 1);
  assert.equal(await BankRule.countDocuments(), 1);
  row = await BankMovement.findById(row._id);
  let entry = await FinanceEntry.findById(row.entry);
  assert.equal((await call('PUT', `/entries/${entry._id}/occurrences/${today.slice(0,7)}`, { revision: entry.revision, status: 'planned' })).statusCode, 409);
  // A later month with a price change inherits the category but is still a new movement.
  const next = new Date(`${today.slice(0,7)}-15T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const future = normalizeMovement({ ...raw('future', 'inter-external', -130), date: next.toISOString() }, 'inter-external');
  await ingestBankRows(links[1], [future]);
  assert.equal((await BankMovement.findOne({ aliases: 'future' })).category, 'Academia');
  // Two legitimate identical purchases are never merged merely on description/value/date.
  await ingestBankRows(links[0], [normalizeMovement(raw('second'), 'nubank-external')]);
  assert.equal(await BankMovement.countDocuments(), 3);
  const second = await BankMovement.findOne({ aliases: 'second' });
  const candidates = (await call('GET', `/banking/movements/${second._id}/candidates`)).json();
  assert.equal(candidates.similar.length, 1);
  // Remembering a generic description is rejected atomically, without leaving an entry behind.
  await ingestBankRows(links[1], [normalizeMovement({ ...raw('generic', 'inter-external'), description: 'PIX ENVIADO' }, 'inter-external')]);
  const generic = await BankMovement.findOne({ aliases: 'generic' });
  const entryCount = await FinanceEntry.countDocuments();
  assert.equal((await decision(generic, { action: 'new', category: 'Outros', remember: true, scope: 'all' })).statusCode, 400);
  assert.equal(await FinanceEntry.countDocuments(), entryCount);
  assert.equal((await BankMovement.findById(generic._id)).state, 'review');
  // A bank's stable identity survives provider ID replacement; pending is not spendable yet.
  const stable = normalizeMovement({ ...raw('pending', 'inter-external'), providerId: 'stable-reference', status: 'PENDING' }, 'inter-external');
  await ingestBankRows(links[1], [stable]);
  const pending = await BankMovement.findOne({ aliases: 'pending' });
  assert.equal((await decision(pending, { action: 'new', category: 'Saúde' })).statusCode, 409);
  await ingestBankRows(links[1], [{ ...stable, aliases: ['posted-new-id'], bankStatus: 'POSTED' }]);
  const posted = await BankMovement.findById(pending._id);
  assert.deepEqual([...posted.aliases], ['pending', 'posted-new-id']);
  assert.equal(await BankMovement.countDocuments({ providerId: 'stable-reference' }), 1);
  // Bank corrections preserve ledger until an explicit undo and review.
  await ingestBankRows(links[0], [normalizeMovement(raw('first', 'nubank-external', -125), 'nubank-external')]);
  row = await BankMovement.findById(row._id);
  assert.equal(row.state, 'changed'); assert.equal((await FinanceEntry.findById(entry._id)).amountCents, 12000);
  assert.equal((await decision(row, { action: 'undo' })).statusCode, 200);
  assert.equal(await FinanceEntry.countDocuments(), 0);
  assert.equal(await BankRule.countDocuments(), 1, 'undo does not silently remove remembered rules');
  // Exact-match planned occurrence can be linked, restored, and linked only once.
  const [planned] = await FinanceEntry.create([{ user, account: accounts[0]._id, description: 'Academia planejada', category: 'Saúde', type: 'expense', group: 'direct', repeat: 'monthly', amountCents: 12000, date: today }]);
  assert.equal((await decision(second, { action: 'link', entry: String(planned._id), month: today.slice(0,7) })).statusCode, 200);
  assert.equal(await FinanceEntry.countDocuments(), 1);
  let linked = await BankMovement.findById(second._id);
  assert.equal((await decision(linked, { action: 'undo' })).statusCode, 200);
  assert.equal((await FinanceEntry.findById(planned._id)).overrides.length, 0);
  // Transfer is one fact, two accounts, no consumption or income; undo clears both atomically.
  await ingestBankRows(links[0], [normalizeMovement(raw('out', 'nubank-external', -500), 'nubank-external')]);
  await ingestBankRows(links[2], [normalizeMovement(raw('in', 'mp-external', 500), 'mp-external')]);
  let out = await BankMovement.findOne({ aliases: 'out' }); let incoming = await BankMovement.findOne({ aliases: 'in' });
  assert.equal((await decision(out, { action: 'transfer', peer: String(incoming._id) })).statusCode, 200);
  assert.equal(await FinanceEntry.countDocuments({ type: 'transfer' }), 1);
  incoming = await BankMovement.findById(incoming._id);
  assert.equal((await decision(incoming, { action: 'undo' })).statusCode, 200);
  assert.equal(await FinanceEntry.countDocuments({ type: 'transfer' }), 0);
  assert.equal((await BankMovement.findById(out._id)).state, 'review');
  // Concurrent decisions cannot produce two entries.
  out = await BankMovement.findById(out._id);
  const concurrent = await Promise.all([decision(out, { action: 'new', category: 'Teste' }), decision(out, { action: 'new', category: 'Teste' })]);
  assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200,409]);
  assert.equal(await FinanceEntry.countDocuments({ bankSource: String(out._id) }), 1);
  // Failed read retains records and balance, records last failure.
  await BankLink.updateOne({ _id: links[0]._id }, { $set: { lastAttempt: new Date(0) } });
  failRead = true;
  const before = await BankMovement.countDocuments();
  assert.equal((await call('POST', `/banking/links/${links[0]._id}/sync`, {})).statusCode, 500);
  assert.equal(await BankMovement.countDocuments(), before);
  assert.equal((await BankLink.findById(links[0]._id)).balanceCents, 100000);
  assert.ok((await BankLink.findById(links[0]._id)).error);
  const all = await call('POST', '/banking/sync', {});
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().results.length, 3);
  assert.ok(all.json().results.some(r => r.status === 'error'));
  assert.equal(await BankMovement.countDocuments(), before, 'partial all-account failure preserves previous data');
  // Isolation: another authenticated Yper user cannot read or claim the personal provider items.
  await app.inject({ method: 'POST', url: '/auth/users', headers, payload: { email: 'otherbank@test.com', password: 'secret123', apps: ['yper'] } });
  const login = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'otherbank@test.com', password: 'secret123' } })).json();
  const otherHeaders = { authorization: `Bearer ${login.token}` };
  const other = (await call('GET', '/banking', undefined, otherHeaders)).json();
  assert.equal(other.configured, false); assert.equal(other.links.length, 0);
  assert.equal((await call('POST', '/banking/discover', {}, otherHeaders)).statusCode, 503);
  assert.equal((await call('GET', `/banking/movements/${out._id}/candidates`, undefined, otherHeaders)).statusCode, 404);
  assert.equal((await call('POST', `/banking/movements/${out._id}/decision`, { action: 'undo', revision: 1 }, otherHeaders)).statusCode, 404);
  assert.equal((await call('POST', '/banking/categorize', { items: [{ id: String(out._id), revision: 1 }], category: 'Forbidden' }, otherHeaders)).statusCode, 404);
  assert.ok(await BankAudit.countDocuments() >= 8);
  // A card is linked to its own finance account of kind card, created on demand.
  failRead = false;
  sourceAccounts.push({ itemId: 'nubank', externalId: 'nubank-card', bank: 'Nubank', kind: 'card', name: 'Nubank · Cartão · 9876', balanceCents: -345692, balanceAt: new Date() });
  const cardLink = await call('POST', '/banking/links', { externalId: 'nubank-card' });
  assert.equal(cardLink.statusCode, 200, cardLink.body);
  const card = await BankLink.findById(cardLink.json().id);
  assert.equal(card.kind, 'card');
  const cardAccount = await FinanceAccount.findById(card.account);
  assert.equal(cardAccount.kind, 'card'); assert.equal(cardAccount.name, 'Cartão Nubank');
  const pneu = { paymentType: 'INSTALLMENT', totalInstallments: 10, purchaseDate: `${thisMonth}-01T10:00:00Z` };
  cardRows = [cardRaw('pneu-3', 'Pneu Store', 316.44, today, 'POSTED', { ...pneu, installmentNumber: 3, billId: 'bill-now' }),
    cardRaw('pneu-4', 'Pneu Store', 316.44, `${nextMonth}-03`, 'PENDING', { ...pneu, installmentNumber: 4 })];
  const cardSync = await call('POST', `/banking/links/${card._id}/sync`, {});
  assert.equal(cardSync.statusCode, 200, cardSync.body);
  assert.equal((await BankLink.findById(card._id)).bills.length, 1, 'card bills are stored on sync');
  // Bills group purchases by the bill they close in; future installments use the card's closing day.
  const now = (await call('GET', `/cards?month=${thisMonth}`)).json().cards;
  assert.equal(now.length, 1); assert.equal(now[0].name, 'Cartão Nubank');
  assert.equal(now[0].bill.closingDate, `${thisMonth}-09`); assert.equal(now[0].bill.totalCents, 50000);
  assert.deepEqual(now[0].items.map(i => [i.description, i.installmentNumber, i.totalInstallments, i.amountCents, i.remainingCents]), [['Pneu Store', 3, 10, 31644, 31644 * 7]]);
  const upcoming = (await call("GET", `/cards?month=${nextMonth}`)).json().cards;
  assert.equal(upcoming[0].bill.closingDate, `${nextMonth}-09`); assert.equal(upcoming[0].bill.totalCents, 31644, 'an open bill totals its items');
  assert.deepEqual(upcoming[0].items.map(i => i.installmentNumber), [4]);
  assert.equal((await call('GET', '/cards?month=bad')).statusCode, 400);
  assert.equal((await BankLink.findById(card._id)).balanceCents, -345692);
  const currentCard = await FinanceAccount.findById(cardAccount._id);
  assert.equal((await call('PUT', `/accounts/${cardAccount._id}`, { ...currentCard.toObject(), _id: String(cardAccount._id) })).statusCode, 200, 'card accounts stay editable');
  console.log('Banking: adapter, idempotency, rules, ledger reconciliation, transfers, concurrency and isolation passed.');
} finally { await app.close(); await mongoose.disconnect(); await mongo.stop(); }
