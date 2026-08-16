import { getDefaultRebalancePolicyForToken } from '../../account/config/defaults';
import { hasPendingSettlementTransition } from '../../account/tx/handlers/settlement/transition';
import { deriveDelta } from '../../account/utils';
import type { AccountReplica } from '../../types/account';
import { isLeftEntity } from '../id';

export const ACCOUNT_WORK_QUEUED = 1 as const;
export const ACCOUNT_WORK_PENDING = 2 as const;
export const ACCOUNT_WORK_REBALANCE = 4 as const;

export type AccountWorkFlag =
  | typeof ACCOUNT_WORK_QUEUED
  | typeof ACCOUNT_WORK_PENDING
  | typeof ACCOUNT_WORK_REBALANCE;

export type AccountWorkMask = number & { readonly __brand: 'AccountWorkMask' };

const hasRebalanceWork = (
  ownerEntityId: string,
  counterpartyId: string,
  account: AccountReplica,
): boolean => {
  if ([...account.state.requestedRebalance.values()].some(amount => amount > 0n)) return true;
  if (account.pendingFrame || hasPendingSettlementTransition(account)) return false;
  const workspace = account.state.settlementWorkspace;
  const ownerIsLeft = isLeftEntity(ownerEntityId, counterpartyId);
  if (workspace) {
    return workspace.status === 'ready_to_submit' &&
      workspace.lastModifiedByLeft === ownerIsLeft &&
      workspace.executorIsLeft === ownerIsLeft &&
      workspace.ops.length > 0 &&
      workspace.ops.every(op => op.type === 'c2r') &&
      Boolean(ownerIsLeft ? workspace.rightHanko : workspace.leftHanko);
  }
  for (const [tokenId, delta] of account.state.deltas) {
    if ((account.state.requestedRebalance.get(tokenId) ?? 0n) > 0n) continue;
    const derived = deriveDelta(delta, ownerIsLeft);
    if (
      derived.outCollateral - derived.outTotalHold >
      getDefaultRebalancePolicyForToken(tokenId).r2cRequestSoftLimit
    ) return true;
  }
  return false;
};

/**
 * Deterministic projection of one committed Account leaf.
 *
 * Scheduler indexes are part of the persistent Account-map value graph, not
 * hidden caches on EntityState. Recovery therefore rebuilds the same
 * runnable set from the same Account leaves, while a path-copy Account update
 * changes the leaf and its work mask atomically.
 */
export const classifyAccountWork = (
  ownerEntityId: string,
  counterpartyId: string,
  account: AccountReplica,
): AccountWorkMask => {
  let mask = 0;
  if (account.mempool.length > 0) mask |= ACCOUNT_WORK_QUEUED;
  if (account.pendingFrame) mask |= ACCOUNT_WORK_PENDING;
  if (hasRebalanceWork(ownerEntityId, counterpartyId, account)) mask |= ACCOUNT_WORK_REBALANCE;
  return mask as AccountWorkMask;
};

export const accountWorkMaskHas = (
  mask: AccountWorkMask | undefined,
  flag: AccountWorkFlag,
): boolean => ((mask ?? 0) & flag) !== 0;
