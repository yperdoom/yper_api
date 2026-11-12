import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { BankLink, BankMovement, BankRule, BankAudit, BankSyncGuard } from '../src/models/yper/Banking.js';
import { FinanceAccount, FinanceEntry } from '../src/models/yper/Finance.js';
import { ingestBankRows, categorizeMovements, decideMovement, bankToday } from '../src/services/banking.js';
import { normalizeMovement, normalizeCardMovement } from '../src/services/pluggy.js';
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
  // An own transfer from an account that is not connected (e.g. salary) is a regular movement once no peer shows up in 3 days.
  const older = new Date(Date.parse(`${today}T12:00:00Z`) - 5 * 86400000).toISOString().slice(0, 10);
  await sync(0, [source('salary-own', 'Transferência Recebida|PEDRO HENRIQUE ANTUNES PINTO', 4645.27, { date: older })]);
  const salaryOwn = await row('salary-own');
  assert.equal(salaryOwn.state, 'accepted', 'unpaired own transfer older than 3 days is imported');
  assert.equal((await FinanceEntry.findById(salaryOwn.entry)).type, 'income');
  delete process.env.OPEN_FINANCE_OWNER_NAME;
  // Database round trips per sync must not grow with the bank history (Atlas aborts transactions after 60s).
  const many = Array.from({ length: 300 }, (_, i) => source(`bulk-${i}`, `Loja numero ${i}`, -(i + 1)));
  let operations = 0;
  mongoose.set('debug', () => { operations++; });
  const bulk = await sync(2, many);
  const firstSync = operations; operations = 0;
  await sync(2, many);
  mongoose.set('debug', false);
  assert.equal(bulk.imported, 300);
  assert.equal(await FinanceEntry.countDocuments({ user, bankSource: String((await row('bulk-299'))._id) }), 1);
  assert.equal(await BankAudit.countDocuments({ user, action: 'auto-import', movement: (await row('bulk-0'))._id }), 1);
  assert.ok(firstSync < 40, `first sync used ${firstSync} database operations`);
  assert.ok(operations < 40, `repeat sync used ${operations} database operations`);
  // Card purchases (DEBIT positive in the provider) are expenses on the card account, each installment on its own date.
  const cardAccount = await FinanceAccount.create({ user, name: 'Cartão Nubank', kind: 'card', openingDate: today, openingBalanceCents: null });
  const cardLink = await BankLink.create({ user, account: cardAccount._id, externalId: 'card-external', itemId: 'item-0', bank: 'Nubank', kind: 'card' });
  const future = new Date(Date.parse(`${today}T12:00:00Z`) + 31 * 86400000).toISOString().slice(0, 10);
  const purchaseDate = `${today}T10:00:00.000Z`;
  const card = (id, description, amount, extra = {}) => normalizeCardMovement({ id, accountId: 'card-external', description, amount,
    date: `${today}T00:00:00.000Z`, type: amount > 0 ? 'DEBIT' : 'CREDIT', status: 'POSTED', currencyCode: 'BRL', ...extra }, 'card-external');
  const installment = (n, date, status) => card(`pneu-${n}`, 'Pneu Store', 316.44, { date: `${date}T00:00:00.000Z`, status,
    creditCardMetadata: { paymentType: 'INSTALLMENT', installmentNumber: n, totalInstallments: 10, purchaseDate, billId: n === 1 ? 'bill-1' : undefined } });
  assert.throws(() => card('bad', 'Compra', -10, { type: 'DEBIT' }), 'card sign convention is enforced');
  assert.equal(card('usd', 'Discord* Nitromonthly', 4.66, { currencyCode: 'USD', amountInAccountCurrency: 25.88 }).amountCents, 2588, 'foreign purchases use the BRL amount');
  const cardResult = await ingestBankRows(cardLink, [card('coffee', 'Bar da Su', 116, { creditCardMetadata: { paymentType: 'SINGLE', billId: 'bill-1' } }),
    installment(1, today, 'POSTED'), installment(2, future, 'PENDING'),
    card('payment', 'Pagamento recebido', -3456.92), card('refund', 'Estorno de compra', -50)], { automatic: true });
  const coffee = await row('coffee');
  assert.equal(coffee.state, 'accepted'); assert.equal(coffee.billId, 'bill-1');
  const coffeeEntry = await FinanceEntry.findById(coffee.entry);
  assert.equal(coffeeEntry.type, 'expense'); assert.equal(String(coffeeEntry.account), String(cardAccount._id)); assert.equal(coffeeEntry.amountCents, 11600);
  const [first, second] = [await row('pneu-1'), await row('pneu-2')];
  assert.equal(first.state, 'accepted'); assert.equal(second.state, 'accepted', 'future installments of a purchase are planned');
  assert.equal(second.installmentNumber, 2); assert.equal(second.totalInstallments, 10);
  assert.equal((await FinanceEntry.findById(second.entry)).date, future);
  assert.equal((await row('payment')).reviewReason, 'special', 'bill payment credit waits for reconciliation');
  assert.equal((await FinanceEntry.findById((await row('refund')).entry)).type, 'income');
  assert.equal(cardResult.imported, 4);
  // Same description and amount on the same day are distinct installments, not duplicates.
  await ingestBankRows(cardLink, [card('mp-a', 'MERCADOLIVRE*MERC', 183.33, { creditCardMetadata: { paymentType: 'INSTALLMENT', installmentNumber: 3, totalInstallments: 15, purchaseDate } }),
    card('mp-b', 'MERCADOLIVRE*MERC', 183.33, { creditCardMetadata: { paymentType: 'INSTALLMENT', installmentNumber: 4, totalInstallments: 15, purchaseDate: `${yesterday}T10:00:00.000Z` } })], { automatic: true });
  assert.equal((await row('mp-a')).state, 'accepted'); assert.equal((await row('mp-b')).state, 'accepted');
  // Two purchases from the same store on the same day: same installment number, different amount and plan.
  await ingestBankRows(cardLink, [card('ml-a', 'MERCADOLIVRE*KRPM', 183.33, { creditCardMetadata: { paymentType: 'INSTALLMENT', installmentNumber: 2, totalInstallments: 15, purchaseDate } }),
    card('ml-b', 'MERCADOLIVRE*KRPM', 39.33, { creditCardMetadata: { paymentType: 'INSTALLMENT', installmentNumber: 2, totalInstallments: 9, purchaseDate } })], { automatic: true });
  assert.equal((await row('ml-a')).state, 'accepted'); assert.equal((await row('ml-b')).state, 'accepted');
  await ingestBankRows(cardLink, [card('shell-a', 'Shell Box', 197.93), card('shell-b', 'Shell Box', 285.58), card('one-off', 'MERCADOLIVRE*KRPM', 119.90)], { automatic: true });
  assert.equal((await row('shell-a')).state, 'accepted', 'different card amounts on the same day are distinct purchases');
  assert.equal((await row('shell-b')).state, 'accepted'); assert.equal((await row('one-off')).state, 'accepted');
  await ingestBankRows(cardLink, [card('apple-a', 'Apple.Com/Bill', 2.9), card('apple-b', 'Apple.Com/Bill', 2.9)], { automatic: true });
  assert.equal((await row('apple-a')).reviewReason, 'duplicate', 'identical card charges on the same day are still reviewed');
  console.log('Banking automation: import, corrections, durable undo, categories, rollback, ownership, transfers, duplicates and concurrency passed.');
} finally { await mongoose.disconnect(); await mongo.stop(); }
