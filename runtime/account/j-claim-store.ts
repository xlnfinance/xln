import type { Env } from '../types';
import type {
  AccountJClaimAccumulatorState,
  AccountJClaimNode,
  AccountJClaimNodeChanges,
  AccountJClaimNodeStore,
} from '../types/account-j-claims';
import {
  collectReachableAccountJClaimNodes,
  hashAccountJClaimNode,
} from './j-claim-accumulator';

export const getAccountJClaimNodeStore = (env: Env): Map<string, AccountJClaimNode> => {
  env.runtimeState ??= {};
  const existing = env.runtimeState.accountJClaimNodes;
  if (existing instanceof Map) return existing as Map<string, AccountJClaimNode>;
  if (existing !== undefined) throw new Error('ACCOUNT_J_CLAIM_NODE_STORE_INVALID');
  const created = new Map<string, AccountJClaimNode>();
  env.runtimeState.accountJClaimNodes = created;
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
  env: Env,
  changes: AccountJClaimNodeChanges | undefined,
): void => {
  if (!changes || (changes.newNodes.length === 0 && changes.replacedNodeHashes.length === 0)) return;
  env.runtimeState ??= {};
  const store = getAccountJClaimNodeStore(env);
  const pending = env.runtimeState.pendingAccountJClaimNodes instanceof Map
    ? env.runtimeState.pendingAccountJClaimNodes as Map<string, AccountJClaimNode>
    : new Map<string, AccountJClaimNode>();
  const deletes = env.runtimeState.pendingAccountJClaimNodeDeletes instanceof Set
    ? env.runtimeState.pendingAccountJClaimNodeDeletes
    : new Set<string>();
  for (const { hash, node } of changes.newNodes) {
    putVerifiedNode(store, hash, node, 'ACCOUNT_J_CLAIM_NODE_DELTA_CORRUPT');
    putVerifiedNode(pending, hash, node, 'ACCOUNT_J_CLAIM_PENDING_NODE_CORRUPT');
    deletes.delete(hash);
  }
  for (const hash of changes.replacedNodeHashes) deletes.add(hash);
  env.runtimeState.pendingAccountJClaimNodes = pending;
  env.runtimeState.pendingAccountJClaimNodeDeletes = deletes;
};

export const getLiveAccountJClaimAccumulatorStates = (env: Env): AccountJClaimAccumulatorState[] => {
  const states: AccountJClaimAccumulatorState[] = [];
  for (const { state } of env.eReplicas.values()) {
    for (const account of state.accounts.values()) {
      states.push(account.leftPendingJClaims, account.rightPendingJClaims);
    }
  }
  return states;
};

export const assertAccountJClaimRootsAvailable = (env: Env): void => {
  collectReachableAccountJClaimNodes(getAccountJClaimNodeStore(env), getLiveAccountJClaimAccumulatorStates(env));
};

export const getSafePendingAccountJClaimDeletes = (env: Env): string[] => {
  const candidates = env.runtimeState?.pendingAccountJClaimNodeDeletes;
  if (!(candidates instanceof Set) || candidates.size === 0) return [];
  const reachable = collectReachableAccountJClaimNodes(
    getAccountJClaimNodeStore(env),
    getLiveAccountJClaimAccumulatorStates(env),
  );
  return [...candidates].filter((hash) => !reachable.has(hash)).sort();
};

export const finalizePersistedAccountJClaimNodes = (env: Env, deleted: readonly string[]): void => {
  const state = env.runtimeState;
  if (!state) return;
  state.pendingAccountJClaimNodes = new Map();
  const store: AccountJClaimNodeStore = getAccountJClaimNodeStore(env);
  for (const hash of deleted) {
    (store as Map<string, AccountJClaimNode>).delete(hash);
    state.pendingAccountJClaimNodeDeletes?.delete(hash);
  }
};
