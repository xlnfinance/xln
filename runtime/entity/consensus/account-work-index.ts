import type { EntityState } from '../../types';
import { accountHasProposableMempool } from './account-mempool-eligibility';

const QUEUED_ACCOUNT_INDEX = Symbol('xln.entity.queued-account-index');

type EntityStateWithQueuedAccountIndex = EntityState & {
  [QUEUED_ACCOUNT_INDEX]?: Set<string>;
};

const readQueuedAccountIndex = (
  state: EntityState,
): Set<string> | undefined =>
  (state as EntityStateWithQueuedAccountIndex)[QUEUED_ACCOUNT_INDEX];

const writeQueuedAccountIndex = (
  state: EntityState,
  accountIds: Set<string>,
): void => {
  Object.defineProperty(state, QUEUED_ACCOUNT_INDEX, {
    value: accountIds,
    configurable: true,
    writable: true,
    enumerable: false,
  });
};

const buildQueuedAccountIndex = (state: EntityState): Set<string> => {
  const accountIds = new Set<string>();
  for (const [accountId, account] of state.accounts) {
    if (account.mempool.length > 0) accountIds.add(accountId);
  }
  writeQueuedAccountIndex(state, accountIds);
  return accountIds;
};

/**
 * Returns only Accounts with durable queued transactions. Eligibility still
 * runs against each candidate because settlement/Hanko state can temporarily
 * freeze a non-empty queue without changing its membership.
 */
export const getQueuedAccountIds = (
  state: EntityState,
): ReadonlySet<string> =>
  readQueuedAccountIndex(state) ?? buildQueuedAccountIndex(state);

export const refreshQueuedAccountIndex = (
  state: EntityState,
  rawAccountId: string,
): void => {
  const index = readQueuedAccountIndex(state);
  if (!index) return;
  const accountId = rawAccountId.trim().toLowerCase();
  const account = state.accounts.get(accountId);
  if (account && account.mempool.length > 0) index.add(accountId);
  else index.delete(accountId);
};

export const forkQueuedAccountIndex = (
  source: EntityState,
  target: EntityState,
): void => {
  const sourceIndex = readQueuedAccountIndex(source);
  if (sourceIndex) writeQueuedAccountIndex(target, new Set(sourceIndex));
};

export const getProposableAccountIds = (
  state: EntityState,
): string[] => {
  const accountIds: string[] = [];
  for (const accountId of getQueuedAccountIds(state)) {
    const account = state.accounts.get(accountId);
    if (account && accountHasProposableMempool(account, state)) {
      accountIds.push(accountId);
    }
  }
  return accountIds;
};

export const hasProposableAccount = (
  state: EntityState,
): boolean => {
  for (const accountId of getQueuedAccountIds(state)) {
    const account = state.accounts.get(accountId);
    if (account && accountHasProposableMempool(account, state)) return true;
  }
  return false;
};
