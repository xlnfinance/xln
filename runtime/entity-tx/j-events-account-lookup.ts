import type { AccountMachine, EntityState } from '../types';

export function findAccountEntryByCounterparty(
  state: EntityState,
  counterpartyEntityId: string,
): [string, AccountMachine] | null {
  const normalized = String(counterpartyEntityId || '').toLowerCase();
  if (!normalized) return null;
  for (const [accountId, account] of state.accounts.entries()) {
    const accountIdNorm = String(accountId || '').toLowerCase();
    const leftNorm = String(account.leftEntity || '').toLowerCase();
    const rightNorm = String(account.rightEntity || '').toLowerCase();
    if (accountIdNorm === normalized || leftNorm === normalized || rightNorm === normalized) {
      return [accountId, account];
    }
  }
  return null;
}
