export const validMonth = value => typeof value === 'string' && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(value);
export const validDate = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const monthNumber = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
export function addMonth(month, offset) {
  const n = monthNumber(month) + offset;
  return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
}
function dateInMonth(month, day) {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function occurrence(entry, month) {
  const offset = monthNumber(month) - monthNumber(entry.date.slice(0, 7));
  if (offset < 0 || (entry.repeat === 'once' && offset !== 0)
    || (entry.repeat === 'installments' && offset > entry.totalInstallments - entry.installment)) return null;
  const dueDate = dateInMonth(month, Number(entry.date.slice(8)));
  if (entry.endDate && dueDate > entry.endDate) return null;
  const state = (entry.overrides || []).find(item => item.month === month);
  return { id: `${entry._id}:${month}`, entryId: String(entry._id), month, revision: entry.revision,
    description: entry.description, type: entry.type, category: entry.category, counterpart: entry.counterpart,
    group: entry.group, creditor: entry.creditor, account: String(entry.account), toAccount: entry.toAccount ? String(entry.toAccount) : null,
    amountCents: entry.amountCents, dueDate, status: state?.status || 'planned', paidDate: state?.paidDate || '',
    installment: entry.repeat === 'installments' ? entry.installment + offset : null,
    totalInstallments: entry.repeat === 'installments' ? entry.totalInstallments : null };
}

export function projectFinance({ accounts, entries, estimates, from, count, today, accountId = '' }) {
  const months = Array.from({ length: count }, (_, i) => addMonth(from, i));
  const end = months.at(-1);
  const events = [];
  for (const entry of entries) {
    // Include moved payments even when their original due month is outside the requested range.
    const last = [end, today.slice(0, 7), ...(entry.overrides || []).map(item => item.month)].sort().at(-1);
    for (let n = 0; n <= monthNumber(last) - monthNumber(entry.date.slice(0, 7)); n++) {
      const item = occurrence(entry, addMonth(entry.date.slice(0, 7), n));
      if (!item) continue;
      item.overdue = item.status === 'planned' && item.dueDate < today;
      item.cashDate = item.status === 'paid' ? item.paidDate : item.overdue ? today : item.dueDate;
      if (item.status !== 'cancelled') events.push(item);
    }
  }
  for (const estimate of estimates) {
    if (estimate.month > end || estimate.month < today.slice(0, 7)) continue;
    const known = events.filter(e => e.type === 'expense' && e.account === String(estimate.account)
      && e.category === estimate.category && e.cashDate.slice(0, 7) === estimate.month).reduce((sum, e) => sum + e.amountCents, 0);
    const residual = Math.max(0, estimate.amountCents - known);
    if (residual) events.push({ id: `estimate:${estimate._id}`, description: estimate.category, category: estimate.category,
      type: 'expense', group: 'estimate', account: String(estimate.account), amountCents: residual,
      cashDate: dateInMonth(estimate.month, 31), dueDate: '', status: 'estimate', estimateId: String(estimate._id) });
  }
  const selected = accounts.filter(a => !accountId || String(a._id) === accountId);
  const delta = (event, id) => {
    if (event.type === 'transfer') return (event.toAccount === id ? event.amountCents : 0) - (event.account === id ? event.amountCents : 0);
    return event.account === id ? (event.type === 'expense' ? -1 : 1) * event.amountCents : 0;
  };
  const balance = (account, date, actual) => {
    if (account.openingBalanceCents == null || account.openingDate > date) return null;
    return account.openingBalanceCents + events.filter(e => e.cashDate >= account.openingDate && e.cashDate <= date
      && (!actual || e.status === 'paid')).reduce((sum, e) => sum + delta(e, String(account._id)), 0);
  };
  const sumBalances = (list, field) => !list.length || list.some(item => item[field] == null) ? null : list.reduce((sum, item) => sum + item[field], 0);
  const result = months.map(month => {
    const details = events.filter(e => e.cashDate.slice(0, 7) === month && (!accountId || e.account === accountId || e.toAccount === accountId));
    const sum = test => details.filter(test).reduce((s, e) => s + e.amountCents, 0);
    const incomeCents = sum(e => e.type === 'income');
    const reimbursementsCents = sum(e => e.type === 'reimbursement');
    const expenseCents = sum(e => e.type === 'expense');
    const transferCents = accountId ? details.filter(e => e.type === 'transfer').reduce((s, e) => s + delta(e, accountId), 0) : 0;
    const balances = selected.map(account => ({ id: String(account._id), name: account.name, kind: account.kind,
      balanceCents: balance(account, dateInMonth(month, 31), false) }));
    return { month, incomeCents, reimbursementsCents, expenseCents, transferCents,
      resultCents: incomeCents + reimbursementsCents - expenseCents + transferCents,
      paidExpenseCents: sum(e => e.type === 'expense' && e.status === 'paid'),
      estimateCents: sum(e => e.status === 'estimate'), overdueCents: sum(e => e.overdue && e.type === 'expense'),
      balanceCents: sumBalances(balances, 'balanceCents'),
      operationalCents: sumBalances(balances.filter(a => a.kind === 'operational'), 'balanceCents'),
      reserveCents: sumBalances(balances.filter(a => a.kind === 'reserve'), 'balanceCents'), balances,
      groups: Object.fromEntries(['direct', 'card', 'financing', 'estimate'].map(group => [group, sum(e => e.type === 'expense' && e.group === group)])),
      details: details.sort((a, b) => a.cashDate.localeCompare(b.cashDate) || a.description.localeCompare(b.description)),
    };
  });
  return { months: result, accounts: selected.map(a => ({ ...a, currentBalanceCents: balance(a, today, true) })),
    coverage: { recurringIncome: entries.some(e => e.type === 'income' && e.repeat === 'monthly'), estimates: estimates.length > 0 } };
}
