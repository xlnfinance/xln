import type { RadixMerkleRadix } from './radix-merkle';

export type RadixValueLeaf<K, V> = Readonly<{
  kind: 'leaf';
  key: K;
  keyBytes: Uint8Array;
  path: readonly number[];
  value: V;
  /** Cached leaf commitment; persisted only in this node's parent reference. */
  hash: string;
}>;

export type RadixValueBranch<K, V> = Readonly<{
  kind: 'branch';
  path: readonly number[];
  children: ReadonlyMap<number, RadixValueNode<K, V>>;
  edgeHashes: ReadonlyMap<number, string>;
  hash: string;
}>;

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
