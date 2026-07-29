import type { EntityState } from '../../types';
import type { AccountReplica } from '../../types';
import { deriveDelta } from '../../account/utils';
import { getDefaultRebalancePolicyForToken } from '../../account/rebalance-defaults';
import { hasPendingSettlementTransition } from '../../account/tx/handlers/settle-transition';
import { isLeftEntity } from '../id';
import { accountHasProposableMempool } from './account-mempool-eligibility';

const QUEUED_ACCOUNT_INDEX = Symbol('xln.entity.queued-account-index');
const PENDING_ACCOUNT_INDEX = Symbol('xln.entity.pending-account-index');
const REBALANCE_ACCOUNT_INDEX = Symbol('xln.entity.rebalance-account-index');

type EntityStateWithQueuedAccountIndex = EntityState & {
  [QUEUED_ACCOUNT_INDEX]?: Set<string>;
  [PENDING_ACCOUNT_INDEX]?: Set<string>;
  [REBALANCE_ACCOUNT_INDEX]?: Set<string>;
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

const readPendingAccountIndex = (
  state: EntityState,
): Set<string> | undefined =>
  (state as EntityStateWithQueuedAccountIndex)[PENDING_ACCOUNT_INDEX];

const writePendingAccountIndex = (
  state: EntityState,
  accountIds: Set<string>,
): void => {
  Object.defineProperty(state, PENDING_ACCOUNT_INDEX, {
    value: accountIds,
    configurable: true,
    writable: true,
    enumerable: false,
  });
};

const readRebalanceAccountIndex = (
  state: EntityState,
): Set<string> | undefined =>
  (state as EntityStateWithQueuedAccountIndex)[REBALANCE_ACCOUNT_INDEX];

const writeRebalanceAccountIndex = (
  state: EntityState,
  accountIds: Set<string>,
): void => {
  Object.defineProperty(state, REBALANCE_ACCOUNT_INDEX, {
    value: accountIds,
    configurable: true,
    writable: true,
    enumerable: false,
  });
};

const accountHasRebalanceWork = (
  state: EntityState,
  counterpartyId: string,
  account: AccountReplica,
): boolean => {
  if ([...account.requestedRebalance.values()].some(amount => amount > 0n)) {
    return true;
  }
  if (account.pendingFrame || hasPendingSettlementTransition(account)) {
    return false;
  }
  const workspace = account.settlementWorkspace;
  const hubIsLeft = isLeftEntity(state.entityId, counterpartyId);
  if (workspace) {
    return workspace.status === 'ready_to_submit' &&
      workspace.lastModifiedByLeft === hubIsLeft &&
      workspace.executorIsLeft === hubIsLeft &&
      workspace.ops.length > 0 &&
      workspace.ops.every(op => op.type === 'c2r') &&
      Boolean(hubIsLeft ? workspace.rightHanko : workspace.leftHanko);
  }
  for (const [tokenId, delta] of account.deltas) {
    if ((account.requestedRebalance.get(tokenId) ?? 0n) > 0n) continue;
    const derived = deriveDelta(delta, hubIsLeft);
    if (
      derived.outCollateral - derived.outTotalHold >
      getDefaultRebalancePolicyForToken(tokenId).r2cRequestSoftLimit
    ) {
      return true;
    }
  }
  return false;
};

const buildQueuedAccountIndex = (state: EntityState): Set<string> => {
  const accountIds = new Set<string>();
  for (const [accountId, account] of state.accounts) {
    if (account.mempool.length > 0) accountIds.add(accountId);
  }
  writeQueuedAccountIndex(state, accountIds);
  return accountIds;
};

const buildPendingAccountIndex = (state: EntityState): Set<string> => {
  const accountIds = new Set<string>();
  for (const [accountId, account] of state.accounts) {
    if (account.pendingFrame) accountIds.add(accountId);
  }
  writePendingAccountIndex(state, accountIds);
  return accountIds;
};

const buildRebalanceAccountIndex = (state: EntityState): Set<string> => {
  const accountIds = new Set<string>();
  for (const [accountId, account] of state.accounts) {
    if (accountHasRebalanceWork(state, accountId, account)) {
      accountIds.add(accountId);
    }
  }
  writeRebalanceAccountIndex(state, accountIds);
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

export const getPendingAccountIds = (
  state: EntityState,
): ReadonlySet<string> =>
  readPendingAccountIndex(state) ?? buildPendingAccountIndex(state);

export const getRebalanceAccountIds = (
  state: EntityState,
): ReadonlySet<string> =>
  readRebalanceAccountIndex(state) ?? buildRebalanceAccountIndex(state);

export const refreshAccountWorkIndex = (
  state: EntityState,
  rawAccountId: string,
): void => {
  const accountId = rawAccountId.trim().toLowerCase();
  const account = state.accounts.get(accountId);
  const queued = readQueuedAccountIndex(state);
  if (queued) {
    if (account && account.mempool.length > 0) queued.add(accountId);
    else queued.delete(accountId);
  }
  const pending = readPendingAccountIndex(state);
  if (pending) {
    if (account?.pendingFrame) pending.add(accountId);
    else pending.delete(accountId);
  }
  const rebalance = readRebalanceAccountIndex(state);
  if (rebalance) {
    if (account && accountHasRebalanceWork(state, accountId, account)) {
      rebalance.add(accountId);
    } else {
      rebalance.delete(accountId);
    }
  }
};

export const forkAccountWorkIndexes = (
  source: EntityState,
  target: EntityState,
): void => {
  const queued = readQueuedAccountIndex(source);
  if (queued) writeQueuedAccountIndex(target, new Set(queued));
  const pending = readPendingAccountIndex(source);
  if (pending) writePendingAccountIndex(target, new Set(pending));
  const rebalance = readRebalanceAccountIndex(source);
  if (rebalance) writeRebalanceAccountIndex(target, new Set(rebalance));
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
