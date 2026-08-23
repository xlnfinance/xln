/**
 * Overlay-first Patricia node ops: own keys/values, path-copy, one-shot fold, lazy seal.
 * Hash work exists only at the root/storage boundary.
 */
import { hexToBytes } from '../../support/bytes/hex-bytes';
import {
  computeRadixMerkleBranchHashFromSlots,
  computeRadixMerkleEdgeHash,
  computeRadixMerkleLeafHash,
  radixMerklePathSlots,
} from './radix-merkle';
import {
  buildRadixValueTree,
  type PersistentRadixValueMapOptions,
  type RadixFoldMutation,
  type RadixHashStats,
  type RadixValueBranch,
  type RadixValueLeaf,
  type RadixValueNode,
} from './persistent-radix-value-build';

type ValueLeaf<K, V> = RadixValueLeaf<K, V>;
type ValueBranch<K, V> = RadixValueBranch<K, V>;
type ValueNode<K, V> = RadixValueNode<K, V>;

type FoldItem<K, V> = Readonly<{
  kind: 'put' | 'delete';
  key: K;
  keyBytes: Uint8Array;
  path: readonly number[];
  hex: string;
  value?: V;
}>;

type FoldResult<K, V> = Readonly<{
  node: ValueNode<K, V> | null;
  delta: number;
}>;

export const emptyRadixHashStats = (): { -readonly [K in keyof RadixHashStats]: number } => ({
  valueHashes: 0,
  leafHashes: 0,
  branchHashes: 0,
});

export const radixPathSlots = (bytes: Uint8Array, radix: PersistentRadixValueMapOptions<unknown, unknown>['radix']): readonly number[] =>
  radixMerklePathSlots(bytes, radix);

const HEX_BYTE = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

export const radixBytesKey = (bytes: Uint8Array): string => {
  let output = '0x';
  for (let index = 0; index < bytes.length; index += 1) output += HEX_BYTE[bytes[index]!];
  return output;
};

export const radixBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
};

const radixCommonPrefixLength = (left: readonly number[], right: readonly number[]): number => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
};

export const radixPathStartsWith = (path: readonly number[], prefix: readonly number[], from = 0): boolean => {
  if (prefix.length > path.length) return false;
  for (let index = from; index < prefix.length; index += 1) {
    if (path[index] !== prefix[index]) return false;
  }
  return true;
};

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};


const childSlot = <K, V>(parentPath: readonly number[], child: ValueNode<K, V>): number => {
  const slot = child.path[parentPath.length];
  if (slot === undefined) throw new Error('PERSISTENT_RADIX_CHILD_SLOT_MISSING');
  return slot;
};

export const makeRadixLeaf = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  key: K,
  value: V,
): ValueLeaf<K, V> => {
  const ownedKey = options.ownKey(key);
  const keyBytes = Uint8Array.from(options.keyBytes(ownedKey));
  if (keyBytes.length === 0) throw new Error('PERSISTENT_RADIX_KEY_EMPTY');
  return {
    kind: 'leaf',
    key: ownedKey,
    keyBytes,
    path: radixPathSlots(keyBytes, options.radix),
    value: options.ownValue(value),
  };
};

export const makeRadixBranch = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  path: readonly number[],
  nodes: readonly ValueNode<K, V>[],
  previous?: ValueBranch<K, V>,
): ValueBranch<K, V> => {
  const children: Array<ValueNode<K, V> | undefined> = Array(options.radix);
  const edgeHashes: Array<string | undefined> = Array(options.radix);
  for (const child of nodes) {
    const slot = childSlot(path, child);
    if (children[slot]) throw new Error('PERSISTENT_RADIX_BRANCH_SLOT_COLLISION');
    children[slot] = child;
    if (options.commitment !== false && previous?.children[slot] === child) {
      edgeHashes[slot] = previous.edgeHashes[slot];
    }
  }
  return {
    kind: 'branch',
    path: [...path],
    children,
    edgeHashes,
  };
};

export const putRadixNode = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  node: ValueNode<K, V> | null,
  leaf: ValueLeaf<K, V>,
): Readonly<{ node: ValueNode<K, V>; inserted: boolean }> => {
  if (!node) return { node: leaf, inserted: true };
  if (node.kind === 'leaf') {
    if (radixBytesEqual(node.keyBytes, leaf.keyBytes)) {
      return { node: node.value === leaf.value ? node : leaf, inserted: false };
    }
    const shared = radixCommonPrefixLength(node.path, leaf.path);
    if (shared >= node.path.length || shared >= leaf.path.length) {
      throw new Error('PERSISTENT_RADIX_KEY_PREFIX_COLLISION');
    }
    return { node: makeRadixBranch(options, node.path.slice(0, shared), [node, leaf]), inserted: true };
  }
  const shared = radixCommonPrefixLength(node.path, leaf.path);
  if (shared < node.path.length) {
    return { node: makeRadixBranch(options, node.path.slice(0, shared), [node, leaf]), inserted: true };
  }
  const slot = leaf.path[node.path.length];
  if (slot === undefined) throw new Error('PERSISTENT_RADIX_LEAF_SLOT_MISSING');
  const previous = node.children[slot] ?? null;
  const updated = putRadixNode(options, previous, leaf);
  if (updated.node === previous) return { node, inserted: updated.inserted };
  const children = [...node.children];
  children[slot] = updated.node;
  return {
    node: makeRadixBranch(
      options,
      node.path,
      children.filter(Boolean) as ValueNode<K, V>[],
      node,
    ),
    inserted: updated.inserted,
  };
};

export const deleteRadixNode = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  node: ValueNode<K, V> | null,
  path: readonly number[],
  keyHex: string,
): Readonly<{ node: ValueNode<K, V> | null; deleted: boolean }> => {
  if (!node || !radixPathStartsWith(path, node.path)) return { node, deleted: false };
  if (node.kind === 'leaf') {
    return radixBytesKey(node.keyBytes) === keyHex
      ? { node: null, deleted: true }
      : { node, deleted: false };
  }
  const slot = path[node.path.length];
  if (slot === undefined) return { node, deleted: false };
  const previous = node.children[slot];
  if (!previous) return { node, deleted: false };
  const updated = deleteRadixNode(options, previous, path, keyHex);
  if (!updated.deleted) return { node, deleted: false };
  const children = [...node.children];
  children[slot] = updated.node ?? undefined;
  const remaining = children.filter(Boolean) as ValueNode<K, V>[];
  if (remaining.length === 0) return { node: null, deleted: true };
  if (remaining.length === 1) return { node: remaining[0]!, deleted: true };
  return { node: makeRadixBranch(options, node.path, remaining, node), deleted: true };
};

export const ensureRadixRootBranch = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  node: ValueNode<K, V> | null,
): ValueBranch<K, V> | null => {
  if (!node) return null;
  if (node.kind === 'branch' && node.path.length === 0) return node;
  return makeRadixBranch(options, [], [node]);
};

export const sealRadixNode = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  node: ValueNode<K, V>,
  stats: { -readonly [K in keyof RadixHashStats]: number },
): string => {
  if (options.commitment === false) {
    throw new Error('PERSISTENT_RADIX_COMMITMENT_DISABLED');
  }
  if (node.hash !== undefined) return node.hash;
  if (node.kind === 'leaf') {
    stats.valueHashes += 1;
    const digest = options.valueHash(node.value);
    stats.leafHashes += 1;
    node.hash = computeRadixMerkleLeafHash(node.keyBytes, hexToBytes(digest));
    return node.hash;
  }
  for (let slot = 0; slot < node.children.length; slot += 1) {
    const child = node.children[slot];
    if (!child) continue;
    const childHash = sealRadixNode(options, child, stats);
    if (node.edgeHashes[slot] === undefined) {
      node.edgeHashes[slot] = computeRadixMerkleEdgeHash(
        options.radix,
        node.path,
        child.kind,
        child.path,
        childHash,
      );
    }
  }
  stats.branchHashes += 1;
  node.hash = computeRadixMerkleBranchHashFromSlots(options.radix, node.edgeHashes);
  return node.hash;
};

const collapseChildren = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  path: readonly number[],
  children: readonly ValueNode<K, V>[],
  previous?: ValueBranch<K, V>,
): ValueNode<K, V> | null => {
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return makeRadixBranch(options, path, children, previous);
};

const collapseFoldItems = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  mutations: readonly RadixFoldMutation<K, V>[],
): FoldItem<K, V>[] => {
  const last = new Map<string, FoldItem<K, V>>();
  for (const mutation of mutations) {
    const key = options.ownKey(mutation.key);
    const keyBytes = Uint8Array.from(options.keyBytes(key));
    if (keyBytes.length === 0) throw new Error('PERSISTENT_RADIX_KEY_EMPTY');
    const hex = radixBytesKey(keyBytes);
    last.set(hex, {
      kind: mutation.kind,
      key,
      keyBytes,
      path: radixPathSlots(keyBytes, options.radix),
      hex,
      ...(mutation.kind === 'put' ? { value: options.ownValue(mutation.value) } : {}),
    });
  }
  return [...last.values()].sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
};

const splitBySlot = <K, V>(items: readonly FoldItem<K, V>[], depth: number): Map<number, FoldItem<K, V>[]> => {
  const buckets = new Map<number, FoldItem<K, V>[]>();
  for (const item of items) {
    const slot = item.path[depth];
    if (slot === undefined) throw new Error('PERSISTENT_RADIX_KEY_PREFIX_COLLISION');
    const bucket = buckets.get(slot);
    if (bucket) bucket.push(item);
    else buckets.set(slot, [item]);
  }
  return buckets;
};

const foldEmpty = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  items: readonly FoldItem<K, V>[],
): FoldResult<K, V> => {
  const leaves: ValueLeaf<K, V>[] = [];
  for (const item of items) {
    if (item.kind !== 'put') continue;
    leaves.push({
      kind: 'leaf',
      key: item.key,
      keyBytes: item.keyBytes,
      path: item.path,
      value: item.value as V,
    });
  }
  if (leaves.length === 0) return { node: null, delta: 0 };
  if (leaves.length === 1) return { node: leaves[0]!, delta: 1 };
  return {
    node: buildRadixValueTree(
      options.radix,
      leaves,
      (_radix, path, nodes) => makeRadixBranch(options, path, nodes),
    ),
    delta: leaves.length,
  };
};

const foldLeaf = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  leaf: ValueLeaf<K, V>,
  items: readonly FoldItem<K, V>[],
): FoldResult<K, V> => {
  const others: FoldItem<K, V>[] = [];
  let current: ValueNode<K, V> | null = leaf;
  let delta = 0;
  for (const item of items) {
    if (!radixBytesEqual(item.keyBytes, leaf.keyBytes)) {
      others.push(item);
      continue;
    }
    if (item.kind === 'delete') {
      current = null;
      delta = -1;
      continue;
    }
    if (item.value === leaf.value && current === leaf) continue;
    current = {
      kind: 'leaf',
      key: item.key,
      keyBytes: item.keyBytes,
      path: item.path,
      value: item.value as V,
    };
    delta = 0;
  }
  if (others.length === 0) return { node: current, delta };
  const rest = foldEmpty(options, others);
  if (!current) return { node: rest.node, delta: delta + rest.delta };
  if (!rest.node) return { node: current, delta };
  if (current.kind !== 'leaf') throw new Error('PERSISTENT_RADIX_FOLD_LEAF_EXPECTED');
  return {
    node: putRadixNode(options, rest.node, current).node,
    delta: delta + rest.delta,
  };
};

const foldBranch = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  branch: ValueBranch<K, V>,
  items: readonly FoldItem<K, V>[],
): FoldResult<K, V> => {
  // Items arrive sorted by key, so their agreement with one fixed path rises
  // then falls: the shortest shared prefix is at one of the two ends.
  let splitAt = branch.path.length;
  const first = items[0];
  const last = items[items.length - 1];
  if (first) splitAt = Math.min(splitAt, radixCommonPrefixLength(first.path, branch.path));
  if (last) splitAt = Math.min(splitAt, radixCommonPrefixLength(last.path, branch.path));
  if (splitAt < branch.path.length) {
    const slotOfBranch = branch.path[splitAt];
    if (slotOfBranch === undefined) throw new Error('PERSISTENT_RADIX_CHILD_SLOT_MISSING');
    const into: FoldItem<K, V>[] = [];
    const other: FoldItem<K, V>[] = [];
    for (const item of items) {
      if (item.path[splitAt] === slotOfBranch) into.push(item);
      else other.push(item);
    }
    const foldedSelf = foldItems(options, branch, into);
    const nodes: ValueNode<K, V>[] = [];
    if (foldedSelf.node) nodes.push(foldedSelf.node);
    let otherDelta = 0;
    /*
     * `other` may span several slots at the new compressed parent. Building
     * all of it at once would return a branch whose path equals that parent,
     * then incorrectly try to install the branch as its own child. Fold each
     * sibling slot independently so every returned child is strictly below
     * `splitAt`, exactly like the normal branch path below.
     */
    const otherBuckets = splitBySlot(other, splitAt);
    for (let slot = 0; slot < options.radix; slot += 1) {
      const bucket = otherBuckets.get(slot);
      if (!bucket) continue;
      const folded = foldEmpty(options, bucket);
      otherDelta += folded.delta;
      if (folded.node) nodes.push(folded.node);
    }
    return {
      node: collapseChildren(options, branch.path.slice(0, splitAt), nodes),
      delta: foldedSelf.delta + otherDelta,
    };
  }
  const buckets = splitBySlot(items, branch.path.length);
  const nextChildren: ValueNode<K, V>[] = [];
  let delta = 0;
  for (let slot = 0; slot < options.radix; slot += 1) {
    const child = branch.children[slot];
    const bucket = buckets.get(slot);
    if (!bucket) {
      if (child) nextChildren.push(child);
      continue;
    }
    const folded = foldItems(options, child ?? null, bucket);
    delta += folded.delta;
    if (folded.node) nextChildren.push(folded.node);
  }
  return {
    node: collapseChildren(options, branch.path, nextChildren, branch),
    delta,
  };
};

const foldItems = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  node: ValueNode<K, V> | null,
  items: readonly FoldItem<K, V>[],
): FoldResult<K, V> => {
  if (items.length === 0) return { node, delta: 0 };
  if (!node) return foldEmpty(options, items);
  if (node.kind === 'leaf') return foldLeaf(options, node, items);
  return foldBranch(options, node, items);
};

export const foldRadixMutations = <K, V>(
  options: PersistentRadixValueMapOptions<K, V>,
  root: ValueBranch<K, V> | null,
  leafCount: number,
  mutations: readonly RadixFoldMutation<K, V>[],
  reset: boolean,
): Readonly<{ root: ValueBranch<K, V> | null; leafCount: number }> => {
  const items = collapseFoldItems(options, mutations);
  if (!reset && items.length === 0) return { root, leafCount };
  const folded = foldItems(options, reset ? null : root, items);
  return {
    root: ensureRadixRootBranch(options, folded.node),
    leafCount: (reset ? 0 : leafCount) + folded.delta,
  };
};
