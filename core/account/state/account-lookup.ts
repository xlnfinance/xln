import type { AccountReplica } from '../../types/account';

const normalizeEntityId = (value: string): string => value.trim().toLowerCase();

const accountMatchesCounterparty = (
  account: AccountReplica | null | undefined,
  ownerEntityId: string,
  counterpartyEntityId: string,
): boolean => {
  if (!account) return false;
  const owner = normalizeEntityId(ownerEntityId);
  const counterparty = normalizeEntityId(counterpartyEntityId);
  if (!owner || !counterparty) return false;
  const left = normalizeEntityId(account.state.leftEntity);
  const right = normalizeEntityId(account.state.rightEntity);
  return (left === owner && right === counterparty) || (right === owner && left === counterparty);
};

export const findAccountByCounterparty = (
  accounts: ReadonlyMap<string, AccountReplica>,
  ownerEntityId: string,
  counterpartyEntityId: string,
): AccountReplica | null => {
  const counterparty = normalizeEntityId(counterpartyEntityId);
  if (!counterparty) return null;
  // Accounts are keyed by counterparty id; the scan below is only the
  // fallback for non-normalized keys.
  const direct = accounts.get(counterparty);
  if (direct) return direct;
  for (const [key, account] of accounts) {
    if (normalizeEntityId(key) === counterparty || accountMatchesCounterparty(account, ownerEntityId, counterparty)) {
      return account;
    }
  }
  return null;
};
