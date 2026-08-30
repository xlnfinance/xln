import type { RadixMerkleRadix } from './radix-merkle';

export type PersistentRadixValueMapOptions<K, V> = Readonly<{
  radix: RadixMerkleRadix;
  /** Own an immutable key for a leaf/DB record. Not a Merkle seal. */
  ownKey(key: K): K;
  keyBytes(key: K): Uint8Array;
  valueHash(value: V): string;
  /** Own an immutable value for a leaf. Not a Merkle seal. */
  ownValue(value: V): V;
  /** Derived indexes may reuse the path-copy trie without paying for a second commitment. */
  commitment?: boolean;
}>;

export type RadixHashStats = Readonly<{
  valueHashes: number;
  leafHashes: number;
  branchHashes: number;
}>;

export type RadixFoldMutation<K, V> =
  | Readonly<{ kind: 'put'; key: K; value: V }>
  | Readonly<{ kind: 'delete'; key: K }>;

/** Mutable `.hash` is a derived RAM cache. Disk records never store it on this node. */
export type RadixValueLeaf<K, V> = {
  readonly kind: 'leaf';
  readonly key: K;
  readonly keyBytes: Uint8Array;
  readonly path: readonly number[];
  readonly value: V;
  /** Derived RAM cache of options.valueHash(value); never serialized. */
  valueHash?: string;
  hash?: string;
};

export type RadixValueBranch<K, V> = {
  readonly kind: 'branch';
  readonly path: readonly number[];
  /** Slot-indexed fanout: canonical order is structural, never sorted at runtime. */
  readonly children: readonly (RadixValueNode<K, V> | undefined)[];
  /** Parent-owned child commitments. Missing means this slot is not sealed yet. */
  readonly edgeHashes: (string | undefined)[];
  hash?: string;
};

export type RadixValueNode<K, V> = RadixValueLeaf<K, V> | RadixValueBranch<K, V>;

type BranchFactory<K, V> = (
  radix: RadixMerkleRadix,
  path: readonly number[],
  nodes: readonly RadixValueNode<K, V>[],
) => RadixValueBranch<K, V>;

const sharedPrefix = <K, V>(leaves: readonly RadixValueLeaf<K, V>[]): number => {
  const first = leaves[0];
  if (!first) throw new Error('PERSISTENT_RADIX_BUILD_EMPTY');
  let shared = first.path.length;
  for (const leaf of leaves) {
    let index = 0;
    const limit = Math.min(shared, leaf.path.length);
    while (index < limit && first.path[index] === leaf.path[index]) index += 1;
    shared = index;
  }
  return shared;
};

const bucketLeaves = <K, V>(
  leaves: readonly RadixValueLeaf<K, V>[],
  depth: number,
): Map<number, RadixValueLeaf<K, V>[]> => {
  const buckets = new Map<number, RadixValueLeaf<K, V>[]>();
  for (const leaf of leaves) {
    const slot = leaf.path[depth];
    if (slot === undefined) throw new Error('PERSISTENT_RADIX_KEY_PREFIX_COLLISION');
    const bucket = buckets.get(slot);
    if (bucket) bucket.push(leaf);
    else buckets.set(slot, [leaf]);
  }
  return buckets;
};

/** One bottom-up tree from raw prefix-free key bytes. No key sort/hash, no path-copy. */
export const buildRadixValueTree = <K, V>(
  radix: RadixMerkleRadix,
  leaves: readonly RadixValueLeaf<K, V>[],
  makeBranch: BranchFactory<K, V>,
): RadixValueNode<K, V> => {
  const first = leaves[0];
  if (!first) throw new Error('PERSISTENT_RADIX_BUILD_EMPTY');
  if (leaves.length === 1) return first;
  const depth = sharedPrefix(leaves);
  const children: RadixValueNode<K, V>[] = [];
  for (const bucket of bucketLeaves(leaves, depth).values()) {
    children.push(buildRadixValueTree(radix, bucket, makeBranch));
  }
  return makeBranch(radix, first.path.slice(0, depth), children);
};
