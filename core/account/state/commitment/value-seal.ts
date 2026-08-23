import type { AccountReplica, AccountState } from '../../../types/account';
import { isPersistentAccountStateMap } from '../persistent-state-map';
import { RecencySet } from '../../../support/recency-memo';

/** Top-level AccountState maps only. Nested graphs are not walked. */
const ACCOUNT_STATE_MAP_FIELDS = [
  'deltas',
  'locks',
  'swapOffers',
  'pulls',
  'subcontracts',
  'lendingIntents',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
] as const satisfies readonly (keyof AccountState)[];

const requirePersistentCollections = (state: AccountState): void => {
  for (const field of ACCOUNT_STATE_MAP_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(state, field)) continue;
    const current = Reflect.get(state, field);
    if (current === undefined) continue;
    if (isPersistentAccountStateMap(current)) continue;
    throw new Error(`ACCOUNT_VALUE_SEAL_COLLECTION_NOT_PERSISTENT:${field}`);
  }
};

/**
 * Freeze only the bounded object graph. Persistent Patricia collections are
 * already immutable; raw Maps are a loud, separately tracked migration seam
 * and must never be traversed on the frame hot path.
 */
// Subtrees this module already sealed (post-order, so membership means the
// whole subtree is frozen). A committed Account keeps most of its graph from
// the previous commit; re-walking it on every put was ~40 us per Account.
// Generation ≈ the top-level objects replaced across a few hub frames.
const sealedGraphs = new RecencySet<object>(65_536);

const describeSealPath = (trail: readonly (string | object)[]): string =>
  trail.filter((part): part is string => typeof part === 'string').join('.');

const sealBoundedGraph = (
  value: unknown,
  ancestors: Set<object>,
  trail: (string | object)[],
): void => {
  if (value === null || typeof value !== 'object') return;
  if (sealedGraphs.has(value)) return;
  if (isPersistentAccountStateMap(value)) return;
  if (value instanceof Map || value instanceof Set) {
    throw new Error(`ACCOUNT_VALUE_SEAL_RAW_COLLECTION_FORBIDDEN:${describeSealPath(trail)}`);
  }
  if (ancestors.has(value)) throw new Error('ACCOUNT_VALUE_SEAL_CYCLE');
  ancestors.add(value);
  for (const field of Object.getOwnPropertyNames(value)) {
    trail.push(field);
    sealBoundedGraph(Reflect.get(value, field), ancestors, trail);
    trail.pop();
  }
  ancestors.delete(value);
  Object.freeze(value);
  sealedGraphs.add(value);
};

/**
 * Seal a committed Account in O(fixed top-level fields).
 *
 * Growing state and envelope collections must already be Patricia roots. Raw
 * Map/Set values are rejected because freezing their shell does not disable
 * mutating methods and would let bytes change behind a committed leaf hash.
 */
export const sealCommittedAccountValue = (account: AccountReplica): AccountReplica => {
  const state = account.state;
  if (state && typeof state === 'object') {
    requirePersistentCollections(state);
  }
  if (!isPersistentAccountStateMap(account.pendingWithdrawals)) {
    throw new Error('ACCOUNT_VALUE_SEAL_PENDING_WITHDRAWALS_NOT_PERSISTENT');
  }
  if (!isPersistentAccountStateMap(account.shadow.rebalance.policy)) {
    throw new Error('ACCOUNT_VALUE_SEAL_REBALANCE_POLICY_NOT_PERSISTENT');
  }
  if (!isPersistentAccountStateMap(account.shadow.rebalance.submittedAtByToken)) {
    throw new Error('ACCOUNT_VALUE_SEAL_REBALANCE_SUBMITTED_NOT_PERSISTENT');
  }
  sealBoundedGraph(account, new Set(), ['account']);
  return account;
};
