import type { AccountReplica, AccountState } from '../../../types/account';
import { isPersistentAccountStateMap } from '../persistent-state-map';

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
const sealBoundedGraph = (
  value: unknown,
  ancestors: readonly object[] = [],
  path = 'account',
): void => {
  if (value === null || typeof value !== 'object') return;
  if (isPersistentAccountStateMap(value)) return;
  if (value instanceof Map || value instanceof Set) {
    throw new Error(`ACCOUNT_VALUE_SEAL_RAW_COLLECTION_FORBIDDEN:${path}`);
  }
  if (ancestors.includes(value)) throw new Error('ACCOUNT_VALUE_SEAL_CYCLE');
  const nextAncestors = [...ancestors, value];
  for (const field of Object.getOwnPropertyNames(value)) {
    sealBoundedGraph(Reflect.get(value, field), nextAncestors, `${path}.${field}`);
  }
  Object.freeze(value);
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
  sealBoundedGraph(account);
  return account;
};
