import type {
  AccountJClaimAccumulatorState,
  AccountJClaimNode,
  AccountJClaimNodeChanges,
  AccountJClaimNodeStore,
} from '../../types/finance/account-j-claims';
import type { EntityRuntimeContext } from '../runtime-context';
import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
} from '../../account/j-claims/j-claim-accumulator';

export const getAccountJClaimNodeStore = (env: EntityRuntimeContext): Map<string, AccountJClaimNode> => {
  env.infrastructure ??= {};
  const existing = env.infrastructure.accountJClaimNodes;
  if (existing instanceof Map) return existing as Map<string, AccountJClaimNode>;
  if (existing !== undefined) throw new Error('ACCOUNT_J_CLAIM_NODE_STORE_INVALID');
  const created = new Map<string, AccountJClaimNode>();
  env.infrastructure.accountJClaimNodes = created;
  return created;
};

const putVerifiedNode = (
  store: Map<string, AccountJClaimNode>,
  hash: string,
  node: AccountJClaimNode,
  label: string,
): void => {
  const actual = hashAccountJClaimNode(node);
  if (actual !== hash) throw new Error(`${label}:${hash}:${actual}`);
  const current = store.get(hash);
  if (current && hashAccountJClaimNode(current) !== hash) {
    throw new Error(`ACCOUNT_J_CLAIM_NODE_STORE_CORRUPT:${hash}`);
  }
  store.set(hash, node);
};

export const cacheCommittedAccountJClaimNodeChanges = (
  env: EntityRuntimeContext,
  changes: AccountJClaimNodeChanges | undefined,
): void => {
  if (!changes || (changes.newNodes.length === 0 && changes.replacedNodeHashes.length === 0)) return;
  env.infrastructure ??= {};
  const store = getAccountJClaimNodeStore(env);
  const pending = env.infrastructure.pendingAccountJClaimNodes instanceof Map
    ? env.infrastructure.pendingAccountJClaimNodes as Map<string, AccountJClaimNode>
    : new Map<string, AccountJClaimNode>();
  const deletes = env.infrastructure.pendingAccountJClaimNodeDeletes instanceof Set
    ? env.infrastructure.pendingAccountJClaimNodeDeletes
    : new Set<string>();
  for (const { hash, node } of changes.newNodes) {
    putVerifiedNode(store, hash, node, 'ACCOUNT_J_CLAIM_NODE_DELTA_CORRUPT');
    putVerifiedNode(pending, hash, node, 'ACCOUNT_J_CLAIM_PENDING_NODE_CORRUPT');
    deletes.delete(hash);
  }
  for (const hash of changes.replacedNodeHashes) deletes.add(hash);
  env.infrastructure.pendingAccountJClaimNodes = pending;
  env.infrastructure.pendingAccountJClaimNodeDeletes = deletes;
};

export const getLiveAccountJClaimAccumulatorStates = (env: EntityRuntimeContext): AccountJClaimAccumulatorState[] => {
  const states: AccountJClaimAccumulatorState[] = [];
  for (const { state } of env.state.eReplicas.values()) {
    for (const account of state.accounts.values()) {
      states.push(account.state.leftPendingJClaims, account.state.rightPendingJClaims);
    }
  }
  return states;
};

export const assertAccountJClaimRootsAvailable = (env: EntityRuntimeContext): void => {
  collectReachableAccountJClaimNodes(getAccountJClaimNodeStore(env), getLiveAccountJClaimAccumulatorStates(env));
};

export const getSafePendingAccountJClaimDeletes = (env: EntityRuntimeContext): string[] => {
  const candidates = env.infrastructure?.pendingAccountJClaimNodeDeletes;
  if (!(candidates instanceof Set) || candidates.size === 0) return [];
  const reachable = collectReachableAccountJClaimNodes(
    getAccountJClaimNodeStore(env),
    getLiveAccountJClaimAccumulatorStates(env),
  );
  return [...candidates].filter((hash) => !reachable.has(hash)).sort();
};

export const finalizePersistedAccountJClaimNodes = (
  env: EntityRuntimeContext,
  deleted: readonly string[],
): void => {
  const state = env.infrastructure;
  if (!state) return;
  state.pendingAccountJClaimNodes = new Map();
  const store: AccountJClaimNodeStore = getAccountJClaimNodeStore(env);
  for (const hash of deleted) {
    (store as Map<string, AccountJClaimNode>).delete(hash);
    state.pendingAccountJClaimNodeDeletes?.delete(hash);
  }
};
