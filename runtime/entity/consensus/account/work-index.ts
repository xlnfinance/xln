import type { EntityState } from '../../types';
import {
  ACCOUNT_WORK_PENDING,
  ACCOUNT_WORK_QUEUED,
  ACCOUNT_WORK_REBALANCE,
  accountWorkMaskHas,
  type AccountWorkFlag,
} from '../../account/account-work-flags';
import type { EntityAccountMap } from '../../state/persistent-account-map';
import { accountHasProposableMempool } from './mempool-eligibility';

/**
 * Allocation-free Set view over the Account Patricia map's derived work index.
 *
 * The old implementation attached mutable Symbol caches to EntityState. Those
 * caches were absent after recovery, so live and replay could schedule
 * different Account proposals from identical committed bytes. Work membership
 * now changes atomically with the Account leaf and recovery rebuilds it from
 * the same leaves; this view is never an independent authority.
 */
type AccountWorkIdSet = Readonly<{
  size: number;
  has(accountId: string): boolean;
  [Symbol.iterator](): IterableIterator<string>;
}>;

class AccountWorkSetView implements AccountWorkIdSet {
  constructor(
    private readonly accounts: EntityAccountMap,
    private readonly flag: AccountWorkFlag,
  ) {}

  get size(): number {
    return this.accounts.workCount(this.flag);
  }

  has(accountId: string): boolean {
    return accountWorkMaskHas(this.accounts.workMask(accountId), this.flag);
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.accounts.workKeys(this.flag);
  }
}

const workSet = (state: EntityState, flag: AccountWorkFlag): AccountWorkIdSet =>
  new AccountWorkSetView(state.accounts, flag);

export const getQueuedAccountIds = (state: EntityState): AccountWorkIdSet =>
  workSet(state, ACCOUNT_WORK_QUEUED);

export const getPendingAccountIds = (state: EntityState): AccountWorkIdSet =>
  workSet(state, ACCOUNT_WORK_PENDING);

export const getRebalanceAccountIds = (state: EntityState): AccountWorkIdSet =>
  workSet(state, ACCOUNT_WORK_REBALANCE);

export const hasQueuedOrPendingAccountWork = (state: EntityState): boolean =>
  state.accounts.workCount(ACCOUNT_WORK_QUEUED) > 0 ||
  state.accounts.workCount(ACCOUNT_WORK_PENDING) > 0;

export const getProposableAccountIds = (state: EntityState): string[] => {
  const accountIds: string[] = [];
  for (const accountId of state.accounts.workKeys(ACCOUNT_WORK_QUEUED)) {
    const account = state.accounts.get(accountId);
    if (account && accountHasProposableMempool(account, state)) accountIds.push(accountId);
  }
  return accountIds;
};

export const hasProposableAccount = (state: EntityState): boolean => {
  for (const accountId of state.accounts.workKeys(ACCOUNT_WORK_QUEUED)) {
    const account = state.accounts.get(accountId);
    if (account && accountHasProposableMempool(account, state)) return true;
  }
  return false;
};
