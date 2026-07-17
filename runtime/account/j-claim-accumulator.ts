import type {
  AccountJClaimAccumulatorState,
  AccountJClaimMutationResult,
  AccountJClaimNode,
  AccountJClaimNodeEntry,
  AccountJClaimNodeStore,
  AccountJClaimPruneResult,
  AccountJClaimRecord,
  AccountJClaimSide,
} from '../types/account-j-claims';
import {
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
  accountJClaimKeyBit,
  createAccountJClaimRecord,
  firstDifferentAccountJClaimBit,
  getAccountJClaimAccountKey,
  getAccountJClaimKey,
  hashAccountJClaimNode,
  normalizeAccountJBytes32,
  parseAccountJClaimNode,
  parseAccountJClaimRecord,
} from './j-claim-codec';
import {
  createAccountJClaimProof,
  inspectAccountJClaimProof,
  verifyAccountJClaimProof,
} from './j-claim-proof';

export type * from '../types/account-j-claims';
export {
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
  createAccountJClaimProof,
  createAccountJClaimRecord,
  getAccountJClaimAccountKey,
  getAccountJClaimKey,
  hashAccountJClaimNode,
  verifyAccountJClaimProof,
};

const UINT64_MAX = (1n << 64n) - 1n;

export const createEmptyAccountJClaimAccumulator = (): AccountJClaimAccumulatorState =>
  Object.freeze({ version: 1, root: EMPTY_ACCOUNT_J_CLAIM_ROOT, count: 0n });

export const assertAccountJClaimAccumulatorState = (
  value: AccountJClaimAccumulatorState,
): AccountJClaimAccumulatorState => {
  if (!value || typeof value !== 'object' || value.version !== 1 || typeof value.count !== 'bigint') {
    throw new Error('ACCOUNT_J_CLAIM_STATE_INVALID');
  }
  const root = normalizeAccountJBytes32(value.root, 'ROOT');
  if (value.count < 0n || value.count > UINT64_MAX) throw new Error(`ACCOUNT_J_CLAIM_COUNT_INVALID:${value.count}`);
  if ((root === EMPTY_ACCOUNT_J_CLAIM_ROOT) !== (value.count === 0n)) {
    throw new Error('ACCOUNT_J_CLAIM_STATE_ROOT_COUNT_MISMATCH');
  }
  return Object.freeze({ version: 1, root, count: value.count });
};

const sameRecord = (left: AccountJClaimRecord, right: AccountJClaimRecord): boolean =>
  left.accountKey === right.accountKey && left.side === right.side && left.jHeight === right.jHeight &&
  left.jBlockHash === right.jBlockHash && left.eventsHash === right.eventsHash;

const immutableEntries = (nodes: ReadonlyMap<string, AccountJClaimNode>): readonly AccountJClaimNodeEntry[] =>
  Object.freeze([...nodes].map(([hash, node]) => Object.freeze({ hash, node })));

const putNode = (nodes: Map<string, AccountJClaimNode>, value: AccountJClaimNode): string => {
  const node = parseAccountJClaimNode(value);
  const hash = hashAccountJClaimNode(node);
  nodes.set(hash, node);
  return hash;
};

export const applyAccountJClaimInsert = (
  stateValue: AccountJClaimAccumulatorState,
  recordValue: AccountJClaimRecord,
  proof: unknown,
): AccountJClaimMutationResult => {
  const state = assertAccountJClaimAccumulatorState(stateValue);
  const record = parseAccountJClaimRecord(recordValue);
  const key = getAccountJClaimKey(record);
  const inspected = inspectAccountJClaimProof(state.root, record, proof);
  if (inspected.result.status === 'member') {
    if (!sameRecord(inspected.result.record, record)) throw new Error(`ACCOUNT_J_CLAIM_EQUIVOCATION:${key}`);
    return Object.freeze({ status: 'idempotent', state, newNodes: Object.freeze([]), replacedNodeHashes: Object.freeze([]) });
  }
  if (state.count === UINT64_MAX) throw new Error('ACCOUNT_J_CLAIM_COUNT_OVERFLOW');

  const nodes = new Map<string, AccountJClaimNode>();
  let childHash = putNode(nodes, { version: 1, type: 'leaf', key, record });
  let replacedNodeHashes: readonly string[] = Object.freeze([]);
  if (inspected.terminal) {
    const differingBit = firstDifferentAccountJClaimBit(key, inspected.terminal.key);
    if (differingBit < 0) throw new Error(`ACCOUNT_J_CLAIM_KEY_COLLISION:${key}`);
    const insertionIndex = inspected.path.findIndex((entry) => entry.node.bit >= differingBit);
    const prefixLength = insertionIndex < 0 ? inspected.path.length : insertionIndex;
    replacedNodeHashes = Object.freeze(inspected.path.slice(0, prefixLength).map((entry) => entry.hash));
    const subtreeHash = prefixLength < inspected.path.length
      ? inspected.path[prefixLength]!.hash
      : inspected.terminalHash!;
    childHash = putNode(nodes, {
      version: 1,
      type: 'branch',
      bit: differingBit,
      left: accountJClaimKeyBit(key, differingBit) === 0 ? childHash : subtreeHash,
      right: accountJClaimKeyBit(key, differingBit) === 1 ? childHash : subtreeHash,
    });
    for (let index = prefixLength - 1; index >= 0; index -= 1) {
      const entry = inspected.path[index]!;
      childHash = putNode(nodes, {
        ...entry.node,
        left: entry.direction === 0 ? childHash : entry.node.left,
        right: entry.direction === 1 ? childHash : entry.node.right,
      });
    }
  }
  return Object.freeze({
    status: 'inserted',
    state: Object.freeze({ version: 1, root: childHash, count: state.count + 1n }),
    newNodes: immutableEntries(nodes),
    replacedNodeHashes,
  });
};

export const applyAccountJClaimDelete = (
  stateValue: AccountJClaimAccumulatorState,
  recordValue: AccountJClaimRecord,
  proof: unknown,
): AccountJClaimMutationResult => {
  const state = assertAccountJClaimAccumulatorState(stateValue);
  const record = parseAccountJClaimRecord(recordValue);
  const key = getAccountJClaimKey(record);
  const inspected = inspectAccountJClaimProof(state.root, record, proof);
  if (inspected.result.status !== 'member') throw new Error(`ACCOUNT_J_CLAIM_DELETE_ABSENT:${key}`);
  if (!sameRecord(inspected.result.record, record)) throw new Error(`ACCOUNT_J_CLAIM_EQUIVOCATION:${key}`);
  const replaced = [inspected.terminalHash!, ...inspected.path.map((entry) => entry.hash)];
  if (state.count === 1n) {
    return Object.freeze({ status: 'deleted', state: createEmptyAccountJClaimAccumulator(), newNodes: Object.freeze([]), replacedNodeHashes: Object.freeze(replaced) });
  }
  const parent = inspected.path.at(-1);
  if (!parent) throw new Error('ACCOUNT_J_CLAIM_DELETE_PARENT_MISSING');
  let childHash = parent.direction === 0 ? parent.node.right : parent.node.left;
  const nodes = new Map<string, AccountJClaimNode>();
  for (let index = inspected.path.length - 2; index >= 0; index -= 1) {
    const entry = inspected.path[index]!;
    childHash = putNode(nodes, {
      ...entry.node,
      left: entry.direction === 0 ? childHash : entry.node.left,
      right: entry.direction === 1 ? childHash : entry.node.right,
    });
  }
  return Object.freeze({
    status: 'deleted',
    state: Object.freeze({ version: 1, root: childHash, count: state.count - 1n }),
    newNodes: immutableEntries(nodes),
    replacedNodeHashes: Object.freeze(replaced),
  });
};

const collectTree = (
  store: AccountJClaimNodeStore,
  stateValue: AccountJClaimAccumulatorState,
): { nodes: Map<string, AccountJClaimNode>; records: AccountJClaimRecord[] } => {
  const state = assertAccountJClaimAccumulatorState(stateValue);
  if (state.root === EMPTY_ACCOUNT_J_CLAIM_ROOT) return { nodes: new Map(), records: [] };
  const nodes = new Map<string, AccountJClaimNode>();
  const records: AccountJClaimRecord[] = [];
  const pending: Array<{
    hash: string;
    previousBit: number;
    path: readonly { bit: number; direction: 0 | 1 }[];
  }> = [{ hash: state.root, previousBit: -1, path: [] }];
  while (pending.length > 0) {
    const { hash, previousBit, path } = pending.pop()!;
    if (nodes.has(hash)) continue;
    const raw = store.get(hash);
    if (!raw) throw new Error(`ACCOUNT_J_CLAIM_NODE_MISSING:${hash}`);
    const node = parseAccountJClaimNode(raw);
    const actual = hashAccountJClaimNode(node);
    if (actual !== hash) throw new Error(`ACCOUNT_J_CLAIM_NODE_CORRUPT:${hash}:${actual}`);
    nodes.set(hash, node);
    if (node.type === 'branch') {
      if (node.bit <= previousBit) {
        throw new Error(`ACCOUNT_J_CLAIM_BRANCH_ORDER_INVALID:${previousBit}:${node.bit}`);
      }
      pending.push(
        { hash: node.left, previousBit: node.bit, path: [...path, { bit: node.bit, direction: 0 }] },
        { hash: node.right, previousBit: node.bit, path: [...path, { bit: node.bit, direction: 1 }] },
      );
    } else {
      for (const entry of path) {
        if (accountJClaimKeyBit(node.key, entry.bit) !== entry.direction) {
          throw new Error(`ACCOUNT_J_CLAIM_TREE_NON_CANONICAL_PATH:${entry.bit}:${node.key}`);
        }
      }
      records.push(node.record);
    }
  }
  const expectedNodes = state.count * 2n - 1n;
  if (BigInt(nodes.size) !== expectedNodes || BigInt(records.length) !== state.count) {
    throw new Error(`ACCOUNT_J_CLAIM_TREE_COUNT_MISMATCH:${state.count}:${nodes.size}:${records.length}`);
  }
  records.sort((left, right) => left.jHeight - right.jHeight || left.side.localeCompare(right.side));
  return { nodes, records };
};

export const collectReachableAccountJClaimNodes = (
  store: AccountJClaimNodeStore,
  states: readonly AccountJClaimAccumulatorState[],
): Map<string, AccountJClaimNode> => {
  const reachable = new Map<string, AccountJClaimNode>();
  for (const state of states) {
    for (const [hash, node] of collectTree(store, state).nodes) reachable.set(hash, node);
  }
  return reachable;
};

const absorbChanges = (
  newNodes: Map<string, AccountJClaimNode>,
  replaced: Set<string>,
  mutation: AccountJClaimMutationResult,
): void => {
  for (const { hash, node } of mutation.newNodes) {
    newNodes.set(hash, node);
    replaced.delete(hash);
  }
  for (const hash of mutation.replacedNodeHashes) {
    if (!newNodes.delete(hash)) replaced.add(hash);
  }
};

export const pruneAccountJClaimsThroughHeight = (
  stateValue: AccountJClaimAccumulatorState,
  store: AccountJClaimNodeStore,
  accountKeyValue: string,
  side: AccountJClaimSide,
  jHeight: number,
): AccountJClaimPruneResult => {
  let state = assertAccountJClaimAccumulatorState(stateValue);
  const accountKey = normalizeAccountJBytes32(accountKeyValue, 'ACCOUNT_KEY');
  const initial = collectTree(store, state).records;
  const foreign = initial.find((entry) => entry.accountKey !== accountKey || entry.side !== side);
  if (foreign) throw new Error(`ACCOUNT_J_CLAIM_ROOT_DOMAIN_MISMATCH:${foreign.accountKey}:${foreign.side}`);
  const removed = initial.filter((entry) => entry.jHeight <= jHeight);
  const retained = initial.filter((entry) => entry.jHeight > jHeight);
  const newNodes = new Map<string, AccountJClaimNode>();
  const replaced = new Set<string>();
  const layered: AccountJClaimNodeStore = { get: (hash) => newNodes.get(hash) ?? store.get(hash) };
  for (const entry of removed) {
    const mutation = applyAccountJClaimDelete(state, entry, createAccountJClaimProof(layered, state.root, entry));
    state = mutation.state;
    absorbChanges(newNodes, replaced, mutation);
  }
  return Object.freeze({
    state,
    removed: Object.freeze(removed),
    retained: Object.freeze(retained),
    newNodes: immutableEntries(newNodes),
    replacedNodeHashes: Object.freeze([...replaced].sort()),
  });
};
