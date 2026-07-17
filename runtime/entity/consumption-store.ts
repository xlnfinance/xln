import type { Env } from '../types';
import {
  EMPTY_CONSUMPTION_ROOT,
  assertConsumptionAccumulatorState,
  hashConsumptionNode,
  type ConsumptionAccumulatorState,
  type ConsumptionNode,
  type ConsumptionNodeEntry,
  type ConsumptionNodeStore,
} from './consumption-accumulator';

export type ConsumptionNodeChanges = Readonly<{
  newNodes: readonly ConsumptionNodeEntry[];
  replacedNodeHashes: readonly string[];
}>;

export const getConsumptionNodeStore = (env: Env): Map<string, ConsumptionNode> => {
  env.runtimeState ??= {};
  const existing = env.runtimeState.consumptionNodes;
  if (existing instanceof Map) return existing as Map<string, ConsumptionNode>;
  const created = new Map(existing ?? []);
  env.runtimeState.consumptionNodes = created;
  return created;
};

const putVerifiedNode = (
  store: Map<string, ConsumptionNode>,
  hash: string,
  node: ConsumptionNode,
  code: string,
): void => {
  const actual = hashConsumptionNode(node);
  if (actual !== hash) throw new Error(`${code}:${hash}:${actual}`);
  const current = store.get(hash);
  if (current && hashConsumptionNode(current) !== hash) {
    throw new Error(`CONSUMPTION_NODE_STORE_CORRUPT:${hash}`);
  }
  store.set(hash, node);
};

/** Publish only a validator-computed delta for a frame that has committed. */
export const cacheCommittedConsumptionNodeChanges = (
  env: Env,
  changes: ConsumptionNodeChanges | undefined,
): void => {
  if (!changes || (changes.newNodes.length === 0 && changes.replacedNodeHashes.length === 0)) return;
  env.runtimeState ??= {};
  const store = getConsumptionNodeStore(env);
  const pending = env.runtimeState.pendingConsumptionNodes instanceof Map
    ? env.runtimeState.pendingConsumptionNodes as Map<string, ConsumptionNode>
    : new Map<string, ConsumptionNode>();
  const deletes = env.runtimeState.pendingConsumptionNodeDeletes instanceof Set
    ? env.runtimeState.pendingConsumptionNodeDeletes
    : new Set<string>();
  for (const { hash, node } of changes.newNodes) {
    putVerifiedNode(store, hash, node, 'CONSUMPTION_NODE_DELTA_CORRUPT');
    putVerifiedNode(pending, hash, node, 'CONSUMPTION_PENDING_NODE_CORRUPT');
    deletes.delete(hash);
  }
  for (const hash of changes.replacedNodeHashes) deletes.add(hash);
  env.runtimeState.pendingConsumptionNodes = pending;
  env.runtimeState.pendingConsumptionNodeDeletes = deletes;
};

const collectRoot = (
  store: ConsumptionNodeStore,
  stateInput: ConsumptionAccumulatorState,
  destination: Map<string, ConsumptionNode>,
): bigint => {
  const state = assertConsumptionAccumulatorState(stateInput);
  if (state.root === EMPTY_CONSUMPTION_ROOT) return 0n;
  const pending = [state.root];
  const local = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (local.has(hash)) continue;
    local.add(hash);
    const node = store.get(hash);
    if (!node) throw new Error(`CONSUMPTION_NODE_MISSING:${hash}`);
    const actual = hashConsumptionNode(node);
    if (actual !== hash) throw new Error(`CONSUMPTION_NODE_CORRUPT:${hash}:${actual}`);
    destination.set(hash, node);
    if (node.type === 'branch') pending.push(node.left, node.right);
  }
  const expected = state.count === 0n ? 0n : state.count * 2n - 1n;
  if (BigInt(local.size) !== expected) {
    throw new Error(`CONSUMPTION_TREE_COUNT_MISMATCH:expected=${expected}:actual=${local.size}`);
  }
  return BigInt(local.size);
};

export const collectReachableConsumptionNodes = (
  store: ConsumptionNodeStore,
  states: readonly ConsumptionAccumulatorState[],
): Map<string, ConsumptionNode> => {
  const reachable = new Map<string, ConsumptionNode>();
  for (const state of states) collectRoot(store, state, reachable);
  return reachable;
};

export const getLiveConsumptionAccumulatorStates = (env: Env): ConsumptionAccumulatorState[] =>
  Array.from(env.eReplicas.values(), ({ state }) => state.consumptionAccumulator)
    .filter((state): state is ConsumptionAccumulatorState => Boolean(state));

export const assertConsumptionRootsAvailable = (env: Env): void => {
  collectReachableConsumptionNodes(getConsumptionNodeStore(env), getLiveConsumptionAccumulatorStates(env));
};

export const getSafePendingConsumptionDeletes = (env: Env): string[] => {
  const candidates = env.runtimeState?.pendingConsumptionNodeDeletes;
  if (!(candidates instanceof Set) || candidates.size === 0) return [];
  const reachable = collectReachableConsumptionNodes(
    getConsumptionNodeStore(env),
    getLiveConsumptionAccumulatorStates(env),
  );
  return Array.from(candidates).filter((hash) => !reachable.has(hash)).sort();
};

export const finalizePersistedConsumptionNodes = (
  env: Env,
  deletedHashes: readonly string[],
): void => {
  const state = env.runtimeState;
  if (!state) return;
  state.pendingConsumptionNodes = new Map();
  const store = getConsumptionNodeStore(env);
  const deletes = state.pendingConsumptionNodeDeletes;
  for (const hash of deletedHashes) {
    store.delete(hash);
    deletes?.delete(hash);
  }
};
