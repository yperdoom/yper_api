import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { BankLink, BankMovement, BankRule, BankAudit, BankSyncGuard } from '../src/models/yper/Banking.js';
import { FinanceAccount, FinanceEntry } from '../src/models/yper/Finance.js';
import { ingestBankRows, categorizeMovements, decideMovement, bankToday } from '../src/services/banking.js';
import { normalizeMovement } from '../src/services/pluggy.js';
import { projectFinance } from '../src/services/financeProjection.js';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const today = bankToday();
const user = new mongoose.Types.ObjectId();
const foreign = new mongoose.Types.ObjectId();
const source = (id, description = 'Mercado X', amount = -12, extra = {}) => normalizeMovement({ id, accountId: 'external',
  description, amount, date: today, type: amount < 0 ? 'DEBIT' : 'CREDIT', status: 'POSTED', currencyCode: 'BRL', ...extra }, 'external');
try {
  await mongoose.connect(mongo.getUri(), { dbName: 'banking-automation' });
  await Promise.all([BankLink.init(), BankMovement.init(), BankRule.init(), BankAudit.init(), BankSyncGuard.init(), FinanceAccount.init(), FinanceEntry.init()]);
  const accounts = await FinanceAccount.create(['Nubank', 'Inter', 'Mercado Pago'].map(name => ({ user, name, kind: 'operational', openingDate: today, openingBalanceCents: 100000 })));
  const links = await BankLink.create(accounts.map((a, i) => ({ user, account: a._id, externalId: `external-${i}`, itemId: `item-${i}`, bank: a.name })));
  const sync = (index, rows) => ingestBankRows(links[index], rows, { automatic: true });
  const row = alias => BankMovement.findOne({ user, aliases: alias });

  const result = await sync(0, [source('shop'), source('salary', 'Salário', 5000), source('pending', 'Pagamento agendado', -25, { status: 'PENDING' })]);
  assert.equal(result.imported, 2, 'no category or per-entry approval is required');
  let shop = await row('shop');
  assert.equal(shop.state, 'accepted'); assert.equal(shop.category, '');
  const originalEntry = String(shop.entry);
  assert.equal((await row('pending')).state, 'review');
  await sync(0, [source('shop'), source('salary', 'Salário', 5000)]);
  assert.equal(await FinanceEntry.countDocuments({ user }), 2, 'repeat sync never duplicates');

  // Category-only writes preserve values and IDs; stale batches must roll back every item.
  const salary = await row('salary');
  await assert.rejects(() => categorizeMovements(user, { items: [{ id: String(shop._id), revision: shop.revision }, { id: String(salary._id), revision: salary.revision + 1 }], category: 'Erro' }), e => e.code === 'FINANCE_CHANGED');
  assert.equal((await row('shop')).category, '');
  await categorizeMovements(user, { items: [{ id: String(shop._id), revision: shop.revision }], category: 'Alimentação', remember: true, scope: 'all' });
  shop = await row('shop');
  assert.equal(String(shop.entry), originalEntry);
  assert.equal((await FinanceEntry.findById(shop.entry)).amountCents, 1200);
  await assert.rejects(() => categorizeMovements(foreign, { items: [{ id: String(shop._id), revision: shop.revision }], category: 'Outra' }), e => e.code === 'NOT_FOUND');

  // A bank correction updates the same entry and preserves the user's category.
  const corrected = await sync(0, [source('shop', 'Mercado X corrigido', -15.5)]);
  assert.equal(corrected.updated, 1);
  shop = await row('shop');
  assert.equal(shop.state, 'accepted'); assert.equal(String(shop.entry), originalEntry); assert.equal(shop.category, 'Alimentação');
  assert.equal((await FinanceEntry.findById(shop.entry)).amountCents, 1550);
  assert.equal(await FinanceEntry.countDocuments({ user }), 2);
  await sync(1, [source('other-shop', 'Mercado X', -20)]);
  assert.equal((await row('other-shop')).category, 'Alimentação', 'remembered category crosses accounts only when explicitly requested');

  // Identity ambiguity stays outside totals, but distinct institutional IDs are not falsely merged.
  await sync(0, [source('ambiguous-a', 'Padaria', -10), source('ambiguous-b', 'Padaria', -10),
    source('distinct-a', 'Cinema', -30, { providerId: 'bank-a' }), source('distinct-b', 'Cinema', -30, { providerId: 'bank-b' })]);
  assert.equal((await row('ambiguous-a')).state, 'review'); assert.equal((await row('ambiguous-a')).reviewReason, 'duplicate');
  assert.equal((await row('ambiguous-b')).state, 'review');
  assert.equal((await row('distinct-a')).state, 'accepted'); assert.equal((await row('distinct-b')).state, 'accepted');

  // Own transfer waits for the second bank, then forms one transfer using its reference and ownership evidence.
  const paymentData = { payer: { documentNumber: { value: '11111111111' } }, receiver: { documentNumber: { value: '11111111111' } }, referenceNumber: 'reference-123' };
  await sync(0, [source('transfer-out', 'PIX enviado', -100, { operationType: 'PIX', paymentData })]);
  assert.equal((await row('transfer-out')).state, 'review');
  const transferResult = await sync(2, [source('transfer-in', 'PIX recebido', 100, { operationType: 'PIX', paymentData })]);
  assert.equal(transferResult.transfers, 1);
  assert.equal(await FinanceEntry.countDocuments({ user, type: 'transfer' }), 1);
  assert.equal(String((await row('transfer-out')).entry), String((await row('transfer-in')).entry));
  await sync(0, [source('unknown-pix', 'PIX enviado', -15), source('invoice', 'Pagamento de fatura', -500)]);
  assert.equal((await row('unknown-pix')).reviewReason, 'transfer'); assert.equal((await row('invoice')).reviewReason, 'special');
  await sync(1, [source('third-party', 'PIX estabelecimento', -35, { operationType: 'PIX', paymentData: { ...paymentData, receiver: { documentNumber: { value: '22222222222' } } } })]);
  assert.equal((await row('third-party')).state, 'accepted', 'known third-party Pix need not be reviewed individually');

  // Existing manual plans remain one expense; their matches are explicit exceptions.
  await FinanceEntry.create({ user, account: accounts[1]._id, description: 'Academia', type: 'expense', amountCents: 15000, date: today, repeat: 'monthly', category: 'Saúde' });
  await sync(1, [source('gym', 'Academia', -155)]);
  assert.equal((await row('gym')).reviewReason, 'existing', 'same description with adjusted amount should not duplicate the plan');

  // Undo is durable: later automatic sync must not recreate a deliberately undone entry.
  shop = await row('shop');
  await decideMovement(user, String(shop._id), { action: 'undo', revision: shop.revision });
  await sync(0, [source('shop', 'Mercado X corrigido', -15.5)]);
  assert.equal((await row('shop')).state, 'review'); assert.equal(await FinanceEntry.countDocuments({ user, bankSource: String(shop._id) }), 0);

  // Pending -> posted is automatically materialized; concurrent repeats stay idempotent.
  await Promise.all([sync(0, [source('pending', 'Pagamento agendado', -25)]), sync(0, [source('pending', 'Pagamento agendado', -25)])]);
  const posted = await row('pending'); assert.equal(posted.state, 'accepted');
  assert.equal(await FinanceEntry.countDocuments({ user, bankSource: String(posted._id) }), 1);
  // Reversing direction or making an accepted transfer inconsistent is never silently applied.
  await sync(0, [source('pending', 'Pagamento agendado', 25), source('transfer-out', 'PIX enviado', -101, { operationType: 'PIX', paymentData })]);
  assert.equal((await row('pending')).state, 'changed'); assert.equal((await row('transfer-out')).state, 'changed');
  assert.equal((await FinanceEntry.findById(posted.entry)).type, 'expense');
  const projection = projectFinance({ accounts: accounts.map(a => a.toObject()), entries: await FinanceEntry.find({ user }).lean(), estimates: [], from: today.slice(0, 7), count: 3, today });
  assert.equal(projection.months[0].incomeCents, 500000, 'own transfer must not inflate revenue');
  assert.ok(await BankAudit.exists({ user, action: 'auto-update' }));
  // With the owner's name configured, Pix to third parties is a normal movement; only Pix naming the owner is a transfer.
  await sync(2, [source('held-pix', 'Pix enviado Loja Y', -33)]);
  assert.equal((await row('held-pix')).reviewReason, 'transfer', 'without the owner name, unknown Pix stays held');
  process.env.OPEN_FINANCE_OWNER_NAME = 'Pedro Henrique Antunes Pinto';
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  await sync(2, [source('pix-shop', 'Transferência enviada pelo Pix|AGROPECUARIA PRADO LTDA', -40),
    source('own-out', 'Pix enviado Pedro Henrique Antunes Pinto', -70, { date: yesterday })]);
  assert.equal((await row('pix-shop')).state, 'accepted');
  assert.equal((await FinanceEntry.findById((await row('pix-shop')).entry)).type, 'expense');
  assert.equal((await row('held-pix')).state, 'accepted', 'held third-party Pix is re-evaluated on the next sync');
  assert.equal((await row('own-out')).reviewReason, 'transfer', 'own Pix waits for the other leg');
  await sync(1, [source('own-in', 'Transferência Recebida|PEDRO HENRIQUE ANTUNES PINTO', 70)]);
  const [ownOut, ownIn] = [await row('own-out'), await row('own-in')];
  assert.equal(ownOut.decision, 'transfer'); assert.equal(ownIn.decision, 'transfer');
  assert.equal(String(ownOut.entry), String(ownIn.entry), 'legs named after the owner pair within one day');
  assert.equal((await FinanceEntry.findById(ownOut.entry)).type, 'transfer');
  delete process.env.OPEN_FINANCE_OWNER_NAME;
  console.log('Banking automation: import, corrections, durable undo, categories, rollback, ownership, transfers, duplicates and concurrency passed.');
} finally { await mongoose.disconnect(); await mongo.stop(); }
