import type { AccountView } from '../views';

/** The current signed Account view owns both assets and liabilities. */
export function walletLendingBalance(wallet: {
  accounts: ReadonlyArray<Pick<AccountView, 'doc' | 'isLeft'>>;
}): Map<number, bigint> {
  const totals = new Map<number, bigint>();
  for (const account of wallet.accounts) {
    for (const [token, leftAmount] of account.doc.lendingBalances) {
      const amount = account.isLeft ? leftAmount : -leftAmount;
      totals.set(token, (totals.get(token) ?? 0n) + amount);
    }
  }
  return totals;
}
