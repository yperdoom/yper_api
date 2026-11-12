import { httpError } from '../lib/errors.js';
import { validDate } from './financeProjection.js';

export function personalBankConfig(user) {
  if (!process.env.OPEN_FINANCE_OWNER_ID || String(user) !== process.env.OPEN_FINANCE_OWNER_ID) return null;
  try {
    const items = JSON.parse(process.env.PLUGGY_ITEMS_JSON || '[]');
    if (!process.env.PLUGGY_CLIENT_ID || !process.env.PLUGGY_CLIENT_SECRET || !Array.isArray(items) || !items.length
      || items.length > 5 || items.some(i => typeof i.id !== 'string' || !/^[\w-]{1,100}$/.test(i.id)
        || !['Inter', 'Nubank', 'Mercado Pago'].includes(i.bank))) return null;
    return items;
  } catch { return null; }
}
export function bankCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw httpError(502, 'BANK_DATA_INVALID');
  return Math.round(value * 100);
}
export const normalizedPattern = value => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
export const canRemember = value => value.length >= 4 && !/^(pix|ted|doc|compra|pagamento|transferencia|transferência)(\s|$)/i.test(value);
export function normalizeMovement(raw, externalId) {
  if (raw.accountId !== externalId || raw.currencyCode !== 'BRL' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 160
    || typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 500
    || !['DEBIT', 'CREDIT'].includes(raw.type) || !['POSTED', 'PENDING'].includes(raw.status)) throw httpError(502, 'BANK_DATA_INVALID');
  // The provider's calendar date is retained; midnight date-only representations must not shift to the previous day.
  const date = typeof raw.date === 'string' ? raw.date.slice(0, 10) : '';
  if (!validDate(date)) throw httpError(502, 'BANK_DATA_INVALID');
  const signed = bankCents(raw.amount);
  if (!signed || (signed < 0) !== (raw.type === 'DEBIT')) throw httpError(502, 'BANK_DATA_INVALID');
  // Compare ownership in memory; do not persist CPF/CNPJ or raw payment details.
  const document = value => typeof value === 'string' ? value.replace(/\D/g, '') : '';
  const payer = document(raw.paymentData?.payer?.documentNumber?.value);
  const receiver = document(raw.paymentData?.receiver?.documentNumber?.value);
  const complete = v => [11, 14].includes(v.length);
  return { aliases: [raw.id], providerId: typeof raw.providerId === 'string' ? raw.providerId.slice(0, 200) : '',
    operationType: typeof raw.operationType === 'string' ? raw.operationType.slice(0, 80) : '',
    transferReference: typeof raw.paymentData?.referenceNumber === 'string' ? raw.paymentData.referenceNumber.slice(0, 200) : '',
    sameOwner: complete(payer) && complete(receiver) ? payer === receiver : null,
    description: raw.description, pattern: normalizedPattern(raw.description), date,
    amountCents: Math.abs(signed), direction: raw.type === 'DEBIT' ? 'expense' : 'income', bankStatus: raw.status };
}

// Fixed host, no user-supplied URL, and no credentials or upstream bodies in errors/logs.
export function createPluggyProvider(fetcher = fetch) {
  async function request(path, key, payload) {
    try {
      const response = await fetcher(`https://api.pluggy.ai${path}`, { method: payload ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-KEY': key } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error('upstream');
      return await response.json();
    } catch { throw httpError(502, 'BANK_PROVIDER_UNAVAILABLE'); }
  }
  async function auth() {
    const result = await request('/auth', null, { clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET });
    if (typeof result.apiKey !== 'string' || !result.apiKey) throw httpError(502, 'BANK_PROVIDER_UNAVAILABLE');
    return result.apiKey;
  }
  return {
    async accounts(items) {
      const key = await auth(); const accounts = [];
      for (const item of items) {
        const page = await request(`/accounts?itemId=${encodeURIComponent(item.id)}`, key);
        if (!Array.isArray(page.results) || page.totalPages > 1) throw httpError(502, 'BANK_DATA_INVALID');
        for (const a of page.results) {
          if (a.itemId !== item.id || typeof a.id !== 'string') throw httpError(502, 'BANK_DATA_INVALID');
          if (!['BANK', 'CREDIT'].includes(a.type) || a.currencyCode !== 'BRL') continue;
          const kind = a.type === 'CREDIT' ? 'card' : 'account';
          const balance = a.balance == null ? null : bankCents(a.balance);
          accounts.push({ externalId: a.id, itemId: item.id, bank: item.bank, kind,
            name: `${item.bank} · ${kind === 'card' ? 'Cartão' : String(a.name || 'Conta').slice(0, 80)} · ${String(a.number || '').slice(-4)}`,
            // A card balance is the amount owed.
            balanceCents: kind === 'card' && balance ? -balance : balance,
            balanceAt: a.updatedAt && Number.isFinite(Date.parse(a.updatedAt)) ? new Date(a.updatedAt) : null });
        }
      }
      return accounts;
    },
    async movements(externalId) {
      const key = await auth(); const rows = []; const cursors = new Set(); let after;
      do {
        const query = new URLSearchParams({ accountId: externalId, ...(after ? { after } : {}) });
        const page = await request(`/v2/transactions?${query}`, key);
        if (!Array.isArray(page.results) || !('next' in page)) throw httpError(502, 'BANK_DATA_INVALID');
        rows.push(...page.results.map(r => normalizeMovement(r, externalId)));
        if (rows.length > 10000) throw httpError(502, 'BANK_DATA_INVALID');
        if (page.next === null) break;
        if (typeof page.next !== 'string' || !page.next.startsWith('?')) throw httpError(502, 'BANK_DATA_INVALID');
        after = new URLSearchParams(page.next).get('after');
        if (!after || cursors.has(after) || cursors.size >= 30) throw httpError(502, 'BANK_DATA_INVALID');
        cursors.add(after);
      } while (true);
      return rows;
    },
  };
}
export const pluggy = createPluggyProvider();
