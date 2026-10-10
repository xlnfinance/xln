/** Hub-reported deposits, reconciled with locally committed fund/payout intents.
 * This is a display estimate, never a source of payment capacity or authority.
 */
export type LendingBalanceAccount = {
  hubEntityId: string;
  intents: ReadonlyArray<readonly [string, string]>;
};
export type LendingBalance = {
  byToken: Map<number, bigint>;
  loading: boolean;
  error: string;
};
export const emptyLendingBalance = (): LendingBalance => ({ byToken: new Map(), loading: false, error: '' });

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LENDING_BALANCE_RESPONSE_INVALID');
  return value as Record<string, unknown>;
};
const amount = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('LENDING_BALANCE_AMOUNT_INVALID');
  return BigInt(value);
};

/** Deduct a term loan only alongside the locally received principal; a signed
 * repayment removes the liability even while the hub HTTP projection catches up.
 */
function subtractLoans(data: Record<string, unknown>, user: string, account: LendingBalanceAccount, totals: Map<number, bigint>): void {
  if (!Array.isArray(data['loans'])) throw new Error('LENDING_BALANCE_RESPONSE_INVALID');
  const intents = new Map(account.intents);
  const awaiting = new Set(account.intents.filter(([key]) => key.startsWith('disburse:') && !intents.has(`repay:${key.slice(9)}`)).map(([key]) => key.slice(9)));
  const seen = new Set<string>();
  for (const raw of data['loans']) {
    const loan = record(raw);
    const id = String(loan['loanId']);
    if (seen.has(id)) throw new Error(`LENDING_BALANCE_DUPLICATE:${id}`);
    seen.add(id);
    if (loan['hubEntityId'] !== account.hubEntityId) throw new Error('LENDING_BALANCE_OWNER_MISMATCH');
    if (loan['borrowerEntityId'] !== user) continue; // Lender's claim is already counted in its pool.
    if (intents.has(`repay:${id}`)) { awaiting.delete(id); continue; }
    if (loan['status'] === 'repaid') {
      if (awaiting.has(id)) throw new Error(`LENDING_BALANCE_SYNC_PENDING:${id}`);
      continue;
    }
    if (!['opening', 'active', 'defaulted'].includes(String(loan['status']))) throw new Error('LENDING_BALANCE_STATUS_INVALID');
    if (loan['status'] === 'opening' && !awaiting.has(id)) continue;
    if (!awaiting.has(id) && account.intents.length < 20) throw new Error(`LENDING_BALANCE_SYNC_PENDING:${id}`);
    const token = loan['tokenId'];
    if (typeof token !== 'number' || !Number.isSafeInteger(token) || token <= 0) throw new Error('LENDING_BALANCE_TOKEN_INVALID');
    const owed = amount(loan['repaymentAmount']) - amount(loan['repaidAmount']);
    if (owed < 0n) throw new Error('LENDING_BALANCE_AMOUNT_INVALID');
    totals.set(token, (totals.get(token) ?? 0n) - owed);
    awaiting.delete(id);
  }
  if (awaiting.size) throw new Error(`LENDING_BALANCE_SYNC_PENDING:${[...awaiting].join(',')}`);
}

export function projectLendingBalance(
  response: unknown, userEntityId: string, account: LendingBalanceAccount,
): Map<number, bigint> {
  const data = record(response);
  if (data['success'] !== true) throw new Error(String(data['error'] || 'LENDING_BALANCE_REQUEST_FAILED'));
  if (data['hubEntityId'] !== account.hubEntityId || !Array.isArray(data['pools'])) throw new Error('LENDING_BALANCE_RESPONSE_INVALID');
  const intents = new Map(account.intents);
  const awaiting = new Set(account.intents.filter(([key]) => key.startsWith('fund:') && !intents.has(`payout:${key.slice(5)}`)).map(([key]) => key.slice(5)));
  const totals = new Map<number, bigint>();
  const seen = new Set<string>();
  for (const value of data['pools']) {
    const pool = record(value);
    const id = String(pool['positionId']);
    if (seen.has(id)) throw new Error(`LENDING_BALANCE_DUPLICATE:${id}`);
    seen.add(id);
    if (pool['hubEntityId'] !== account.hubEntityId || pool['lenderEntityId'] !== userEntityId) throw new Error('LENDING_BALANCE_OWNER_MISMATCH');
    // A received payout already belongs to the signed account balance, even if HTTP lags.
    if (intents.has(`payout:${id}`)) continue;
    if (pool['status'] === 'closed') {
      if (awaiting.has(id)) throw new Error(`LENDING_BALANCE_SYNC_PENDING:${id}`);
      continue;
    }
    if (pool['status'] !== 'open' && pool['status'] !== 'closing') throw new Error('LENDING_BALANCE_STATUS_INVALID');
    const tokenId = pool['tokenId'];
    if (typeof tokenId !== 'number' || !Number.isSafeInteger(tokenId) || tokenId <= 0) throw new Error('LENDING_BALANCE_TOKEN_INVALID');
    // Available includes received interest; allocated principal remains the lender's claim.
    // Never add principalAmount or future loan interest again.
    const balance = amount(pool['availableAmount']) + amount(pool['borrowedAmount']);
    totals.set(tokenId, (totals.get(tokenId) ?? 0n) + balance);
    awaiting.delete(id);
  }
  if (awaiting.size) throw new Error(`LENDING_BALANCE_SYNC_PENDING:${[...awaiting].join(',')}`);
  subtractLoans(data, userEntityId, account, totals);
  return totals;
}

export function watchLendingBalance(
  input: { apiBase: string; userEntityId: string; accounts: LendingBalanceAccount[] },
  publish: (balance: LendingBalance) => void,
): () => void {
  // Compact account views retain only recent intents. Query every account with
  // lending activity and include older open pools from the hub response too.
  const accounts = input.accounts.filter(account => account.intents.length > 0);
  if (!accounts.length) { publish(emptyLendingBalance()); return () => {}; }
  let stopped = false;
  let busy = false;
  const controller = new AbortController();
  publish({ byToken: new Map(), loading: true, error: '' });
  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const balances = await Promise.all(accounts.map(async account => {
        const url = new URL('/api/lending/state', input.apiBase);
        url.searchParams.set('hubEntityId', account.hubEntityId);
        url.searchParams.set('userEntityId', input.userEntityId);
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) });
        if (!response.ok) throw new Error(`LENDING_BALANCE_HTTP_${response.status}`);
        return projectLendingBalance(await response.json(), input.userEntityId, account);
      }));
      const byToken = new Map<number, bigint>();
      for (const balance of balances) for (const [token, value] of balance) byToken.set(token, (byToken.get(token) ?? 0n) + value);
      if (!stopped) publish({ byToken, loading: false, error: '' });
    } catch (error) {
      if (!stopped) publish({ byToken: new Map(), loading: false, error: error instanceof Error ? error.message : String(error) });
    } finally { busy = false; }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 3_000);
  return () => { stopped = true; controller.abort(); clearInterval(timer); };
}
