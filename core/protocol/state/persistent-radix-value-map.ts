import { createStructuredLogger } from '../../support/logger';

import {
  EMPTY_RADIX_MERKLE_ROOT,
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
import {
  deleteRadixNode,
  emptyRadixHashStats,
  ensureRadixRootBranch,
  foldRadixMutations,
  makeRadixBranch,
  makeRadixLeaf,
  putRadixNode,
  radixBytesEqual,
  radixBytesKey,
  radixPathSlots,
  radixPathStartsWith,
  sealRadixNode,
} from './persistent-radix-value-ops';

export type {
  PersistentRadixValueMapOptions,
  RadixFoldMutation,
  RadixHashStats,
} from './persistent-radix-value-build';

type ValueLeaf<K, V> = RadixValueLeaf<K, V>;
type ValueBranch<K, V> = RadixValueBranch<K, V>;
type ValueNode<K, V> = RadixValueNode<K, V>;

export type PersistentRadixBranchRecord = Readonly<{
  kind: 'branch';
  path: readonly number[];
  children: readonly Readonly<{
    slot: number;
    kind: 'branch' | 'leaf';
    path: readonly number[];
    edgeHash: string;
  }>[];
}>;

export type PersistentRadixLeafRecord<K, V> = Readonly<{
  kind: 'leaf';
  path: readonly number[];
  key: K;
  keyBytes: Uint8Array;
  value: V;
}>;

export type PersistentRadixNodeRecord<K, V> =
  | PersistentRadixBranchRecord
  | PersistentRadixLeafRecord<K, V>;

export type PersistentRadixNodeRef =
  | Readonly<{ kind: 'branch'; path: readonly number[] }>
  | Readonly<{ kind: 'leaf'; path: readonly number[]; keyBytes: Uint8Array }>;

export type PersistentRadixNodeChanges<K, V> = Readonly<{
  puts: readonly PersistentRadixNodeRecord<K, V>[];
  dels: readonly PersistentRadixNodeRef[];
}>;

const radixLog = createStructuredLogger('persistent-radix');

const getLeaf = <K, V>(
  node: ValueNode<K, V> | null,
  path: readonly number[],
  keyBytes: Uint8Array,
): ValueLeaf<K, V> | undefined => {
  if (!node || !radixPathStartsWith(path, node.path)) return undefined;
  if (node.kind === 'leaf') return radixBytesEqual(node.keyBytes, keyBytes) ? node : undefined;
  const slot = path[node.path.length];
  return slot === undefined ? undefined : getLeaf(node.children[slot] ?? null, path, keyBytes);
};

const prefixNode = <K, V>(
  node: ValueNode<K, V> | null,
  prefix: readonly number[],
): ValueNode<K, V> | null => {
  if (!node) return null;
  let shared = 0;
  const limit = Math.min(node.path.length, prefix.length);
  while (shared < limit && node.path[shared] === prefix[shared]) shared += 1;
  if (shared < Math.min(node.path.length, prefix.length)) return null;
  if (prefix.length <= node.path.length) return node;
  if (node.kind === 'leaf') return null;
  const slot = prefix[node.path.length];
  return slot === undefined ? null : prefixNode(node.children[slot] ?? null, prefix);
};

const extremeLeaf = <K, V>(
  node: ValueNode<K, V> | null,
  direction: 'first' | 'last',
): ValueLeaf<K, V> | undefined => {
  if (!node) return undefined;
  if (node.kind === 'leaf') return node;
  if (direction === 'first') {
    for (const child of node.children) {
      if (child) return extremeLeaf(child, direction);
    }
  } else {
    for (let slot = node.children.length - 1; slot >= 0; slot -= 1) {
      const child = node.children[slot];
      if (child) return extremeLeaf(child, direction);
    }
  }
  return undefined;
};

function* iterateLeaves<K, V>(node: ValueNode<K, V> | null): Generator<ValueLeaf<K, V>> {
  if (!node) return;
  if (node.kind === 'leaf') {
    yield node;
    return;
  }
  // Explicit iteration is O(n), but never O(n log n): branch slots already
  // encode canonical raw-key order and fanout is bounded by the radix.
  for (const child of node.children) if (child) yield* iterateLeaves(child);
}

function* iterateLeavesReverse<K, V>(node: ValueNode<K, V> | null): Generator<ValueLeaf<K, V>> {
  if (!node) return;
  if (node.kind === 'leaf') {
    yield node;
    return;
  }
  // Fanout is bounded (16 or 256). Reverse traversal visits only the required
  // Patricia branches and never materializes or globally sorts all leaves.
  for (let slot = node.children.length - 1; slot >= 0; slot -= 1) {
    const child = node.children[slot];
    if (child) yield* iterateLeavesReverse(child);
  }
}

const samePath = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((slot, index) => slot === right[index]);

const nodePathKey = (kind: 'branch' | 'leaf', path: readonly number[]): string =>
  `${kind}:${path.join('.')}`;

const compareNodePaths = (left: readonly number[], right: readonly number[]): number => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const leftSlot = left[index];
    const rightSlot = right[index];
    if (leftSlot === undefined || rightSlot === undefined) break;
    if (leftSlot !== rightSlot) return leftSlot - rightSlot;
  }
  return left.length - right.length;
};

const compareNodeOrder = (
  left: Readonly<{ kind: 'branch' | 'leaf'; path: readonly number[] }>,
  right: Readonly<{ kind: 'branch' | 'leaf'; path: readonly number[] }>,
): number => {
  const pathOrder = compareNodePaths(left.path, right.path);
  return pathOrder !== 0 ? pathOrder : left.kind.localeCompare(right.kind);
};

const childrenInSlotOrder = <K, V>(branch: ValueBranch<K, V>): readonly ValueNode<K, V>[] =>
  branch.children.filter((child): child is ValueNode<K, V> => child !== undefined);

const assertCanonicalBranchRecord = (record: PersistentRadixBranchRecord): void => {
  let previous = -1;
  for (const child of record.children) {
    if (!Number.isSafeInteger(child.slot) || child.slot <= previous) {
      throw new Error(`PERSISTENT_RADIX_BRANCH_CHILD_ORDER_INVALID:${record.path.join('.')}`);
    }
    previous = child.slot;
  }
};

const indexNodeRecords = <K, V>(
  records: Iterable<PersistentRadixNodeRecord<K, V>>,
): Map<string, PersistentRadixNodeRecord<K, V>> => {
  const indexed = new Map<string, PersistentRadixNodeRecord<K, V>>();
  for (const record of records) {
    if (record.kind === 'branch') assertCanonicalBranchRecord(record);
    const key = nodePathKey(record.kind, record.path);
    if (indexed.has(key)) throw new Error(`PERSISTENT_RADIX_NODE_DUPLICATE:${key}`);
    indexed.set(key, record);
  }
  return indexed;
};

const assertBranchRecordMatches = <K, V>(
  record: PersistentRadixBranchRecord,
  branch: ValueBranch<K, V>,
): void => {
  for (const child of record.children) {
    if (branch.edgeHashes[child.slot] !== child.edgeHash) {
      throw new Error(`PERSISTENT_RADIX_EDGE_HASH_MISMATCH:${record.path.join('.')}:${child.slot}`);
    }
  }
};

const relinkNodeRecords = <K, V>(
  indexed: ReadonlyMap<string, PersistentRadixNodeRecord<K, V>>,
  options: PersistentRadixValueMapOptions<K, V>,
): Readonly<{ root: ValueBranch<K, V>; leafCount: number }> => {
  const linked = new Map<string, ValueNode<K, V>>();
  const visiting = new Set<string>();
  let leafCount = 0;
  const link = (record: PersistentRadixNodeRecord<K, V>): ValueNode<K, V> => {
    const recordKey = nodePathKey(record.kind, record.path);
    const cached = linked.get(recordKey);
    if (cached) return cached;
    if (visiting.has(recordKey)) throw new Error(`PERSISTENT_RADIX_NODE_CYCLE:${recordKey}`);
    visiting.add(recordKey);
    let node: ValueNode<K, V>;
    if (record.kind === 'leaf') {
      node = makeRadixLeaf(options, record.key, record.value);
      if (!samePath(node.path, record.path) || !radixBytesEqual(node.keyBytes, record.keyBytes)) {
        throw new Error(`PERSISTENT_RADIX_LEAF_KEY_MISMATCH:${recordKey}`);
      }
      leafCount += 1;
    } else {
      const children = record.children.map(child => {
        const target = indexed.get(nodePathKey(child.kind, child.path));
        if (!target) throw new Error(`PERSISTENT_RADIX_CHILD_MISSING:${recordKey}:${child.slot}`);
        return link(target);
      });
      node = makeRadixBranch(options, record.path, children);
    }
    visiting.delete(recordKey);
    linked.set(recordKey, node);
    return node;
  };
  const rootRecord = indexed.get(nodePathKey('branch', []));
  if (!rootRecord || rootRecord.kind !== 'branch') throw new Error('PERSISTENT_RADIX_ROOT_MISSING');
  const root = link(rootRecord);
  if (root.kind !== 'branch') throw new Error('PERSISTENT_RADIX_ROOT_INVALID');
  if (linked.size !== indexed.size) throw new Error('PERSISTENT_RADIX_NODE_ORPHAN');
  return { root, leafCount };
};

const verifyPersistedBranchRecords = <K, V>(
  node: ValueNode<K, V>,
  indexed: ReadonlyMap<string, PersistentRadixNodeRecord<K, V>>,
): void => {
  if (node.kind === 'leaf') return;
  const record = indexed.get(nodePathKey('branch', node.path));
  if (!record || record.kind !== 'branch') {
    throw new Error(`PERSISTENT_RADIX_BRANCH_RECORD_MISSING:${node.path.join('.')}`);
  }
  assertBranchRecordMatches(record, node);
  for (const child of childrenInSlotOrder(node)) verifyPersistedBranchRecords(child, indexed);
};

const nodeAtPath = <K, V>(
  root: ValueNode<K, V> | null,
  kind: 'branch' | 'leaf',
  path: readonly number[],
): ValueNode<K, V> | undefined => {
  let node = root ?? undefined;
  while (node) {
    if (node.kind === kind && samePath(node.path, path)) return node;
    if (node.kind === 'leaf' || !radixPathStartsWith(path, node.path)) return undefined;
    const slot = path[node.path.length];
    node = slot === undefined ? undefined : node.children[slot];
  }
  return undefined;
};

const branchRecord = <K, V>(branch: ValueBranch<K, V>): PersistentRadixBranchRecord => ({
  kind: 'branch',
  path: [...branch.path],
  children: branch.children.flatMap((child, slot) => {
    if (!child) return [];
    const edgeHash = branch.edgeHashes[slot];
    if (!edgeHash) throw new Error(`PERSISTENT_RADIX_EDGE_HASH_MISSING:${slot}`);
    return {
      slot,
      kind: child.kind,
      path: [...child.path],
      edgeHash,
    };
  }),
});

const nodeRecord = <K, V>(node: ValueNode<K, V>): PersistentRadixNodeRecord<K, V> =>
  node.kind === 'branch'
    ? branchRecord(node)
    : {
        kind: 'leaf',
        path: [...node.path],
        key: node.key,
        keyBytes: Uint8Array.from(node.keyBytes),
        value: node.value,
      };

const collectChangedNodePuts = <K, V>(
  node: ValueNode<K, V> | null,
  previousRoot: ValueNode<K, V> | null,
  output: PersistentRadixNodeRecord<K, V>[],
): void => {
  if (!node) return;
  const previous = nodeAtPath(previousRoot, node.kind, node.path);
  // Hot overlays share node identity. Cold storage projections do not: they
  // may independently rebuild the same typed graph from validated RAM. A
  // commitment-identical node is still the exact same durable subtree, so
  // avoid rewriting it and descend only through genuinely dirty branches.
  if (previous === node) return;
  if (
    previous?.hash !== undefined
    && node.hash !== undefined
    && previous.hash === node.hash
  ) return;
  output.push(nodeRecord(node));
  if (node.kind === 'branch') {
    for (const child of childrenInSlotOrder(node)) {
      collectChangedNodePuts(child, previousRoot, output);
    }
  }
};

const collectChangedNodeDels = <K, V>(
  node: ValueNode<K, V> | null,
  nextRoot: ValueNode<K, V> | null,
  output: PersistentRadixNodeRef[],
): void => {
  if (!node) return;
  const replacement = nodeAtPath(nextRoot, node.kind, node.path);
  if (replacement === node) return;
  if (
    replacement?.hash !== undefined
    && node.hash !== undefined
    && replacement.hash === node.hash
  ) return;
  // A changed node retains its physical `(kind,path)` key. It is replaced by
  // the corresponding put, never deleted afterwards. Only nodes unreachable
  // from the new root become delete operations.
  if (!replacement) {
    output.push(node.kind === 'branch'
      ? { kind: 'branch', path: [...node.path] }
      : { kind: 'leaf', path: [...node.path], keyBytes: Uint8Array.from(node.keyBytes) });
  }
  if (node.kind === 'branch') {
    for (const child of childrenInSlotOrder(node)) {
      collectChangedNodeDels(child, nextRoot, output);
    }
  }
};

/** Overlay-first value store. Mutations do not hash; rootHash seals dirty nodes once. */
export class PersistentRadixValueMap<K, V> implements ReadonlyMap<K, V> {
  readonly #root: ValueBranch<K, V> | null;
  #hash: string | undefined;
  readonly #leafCount: number;
  readonly #options: PersistentRadixValueMapOptions<K, V>;
  readonly #stats = emptyRadixHashStats();

  private constructor(
    root: ValueBranch<K, V> | null,
    leafCount: number,
    options: PersistentRadixValueMapOptions<K, V>,
  ) {
    this.#root = root;
    this.#leafCount = leafCount;
    this.#options = options;
    if (root === null && options.commitment !== false) this.#hash = EMPTY_RADIX_MERKLE_ROOT;
    else if (root?.hash !== undefined) this.#hash = root.hash;
  }

  static empty<K, V>(
    options: PersistentRadixValueMapOptions<K, V>,
  ): PersistentRadixValueMap<K, V> {
    return new PersistentRadixValueMap(null, 0, options);
  }

  /** Cold hydration only. Later updates stay path-copy; this never rebuilds. */
  static fromMap<K, V>(
    source: Iterable<readonly [K, V]>,
    options: PersistentRadixValueMapOptions<K, V>,
  ): PersistentRadixValueMap<K, V> {
    const leaves: ValueLeaf<K, V>[] = [];
    const seen = new Set<string>();
    for (const [key, value] of source) {
      const leaf = makeRadixLeaf(options, key, value);
      const hex = radixBytesKey(leaf.keyBytes);
      if (seen.has(hex)) throw new Error(`PERSISTENT_RADIX_DUPLICATE_KEY:${hex}`);
      seen.add(hex);
      leaves.push(leaf);
    }
    radixLog.debug('from_map', { leaves: leaves.length, radix: options.radix });
    const built = leaves.length === 0
      ? null
      : buildRadixValueTree(
          options.radix,
          leaves,
          (_radix, path, nodes) => makeRadixBranch(options, path, nodes),
        );
    return new PersistentRadixValueMap(
      ensureRadixRootBranch(options, built),
      leaves.length,
      options,
    );
  }

  /** Cold storage boundary: validate and relink the exact persisted graph. */
  static fromNodeRecords<K, V>(
    records: Iterable<PersistentRadixNodeRecord<K, V>>,
    options: PersistentRadixValueMapOptions<K, V>,
  ): PersistentRadixValueMap<K, V> {
    if (options.commitment === false) {
      throw new Error('PERSISTENT_RADIX_NODE_STORAGE_REQUIRES_COMMITMENT');
    }
    const indexed = indexNodeRecords(records);
    if (indexed.size === 0) return PersistentRadixValueMap.empty(options);
    const linked = relinkNodeRecords(indexed, options);
    const hydrated = new PersistentRadixValueMap(linked.root, linked.leafCount, options);
    hydrated.rootHash();
    verifyPersistedBranchRecords(linked.root, indexed);
    return hydrated;
  }

  get size(): number {
    return this.#leafCount;
  }

  get(key: K): V | undefined {
    const keyBytes = this.#options.keyBytes(key);
    return getLeaf(this.#root, radixPathSlots(keyBytes, this.#options.radix), keyBytes)?.value;
  }

  /** Presence-preserving lookup for collections whose value domain includes undefined. */
  getEntry(key: K): readonly [K, V] | undefined {
    const keyBytes = this.#options.keyBytes(key);
    const leaf = getLeaf(this.#root, radixPathSlots(keyBytes, this.#options.radix), keyBytes);
    return leaf ? [leaf.key, leaf.value] : undefined;
  }

  /**
   * Membership is leaf presence. `get !== undefined` is wrong: an explicit
   * undefined leaf is a stored value, not a missing key.
   */
  has(key: K): boolean {
    const keyBytes = this.#options.keyBytes(key);
    return getLeaf(this.#root, radixPathSlots(keyBytes, this.#options.radix), keyBytes) !== undefined;
  }

  encodeKey(key: K): Uint8Array {
    const keyBytes = Uint8Array.from(this.#options.keyBytes(key));
    if (keyBytes.length === 0) throw new Error('PERSISTENT_RADIX_KEY_EMPTY');
    return keyBytes;
  }

  /** Overlay boundary: snapshot the key object and its canonical bytes once. */
  prepareKey(key: K): Readonly<{ key: K; keyBytes: Uint8Array }> {
    const owned = this.#options.ownKey(key);
    return { key: owned, keyBytes: this.encodeKey(owned) };
  }

  /** Overlay boundary: own an immutable candidate value before retaining it. */
  prepareValue(value: V): V {
    return this.#options.ownValue(value);
  }

  /** One-shot overlay fold. Does not hash; call rootHash at the Runtime boundary. */
  foldMutations(
    mutations: Iterable<RadixFoldMutation<K, V>>,
    reset = false,
  ): PersistentRadixValueMap<K, V> {
    const folded = foldRadixMutations(
      this.#options,
      this.#root,
      this.#leafCount,
      [...mutations],
      reset,
    );
    if (folded.root === this.#root && folded.leafCount === this.#leafCount) return this;
    radixLog.debug('fold', { leaves: folded.leafCount, reset });
    return new PersistentRadixValueMap(folded.root, folded.leafCount, this.#options);
  }

  hashStats(): RadixHashStats {
    return { ...this.#stats };
  }

  updated(key: K, value: V): PersistentRadixValueMap<K, V> {
    const result = putRadixNode(this.#options, this.#root, makeRadixLeaf(
      this.#options,
      key,
      value,
    ));
    return result.node === this.#root
      ? this
      : new PersistentRadixValueMap(
          ensureRadixRootBranch(this.#options, result.node),
          this.#leafCount + (result.inserted ? 1 : 0),
          this.#options,
        );
  }

  removed(key: K): PersistentRadixValueMap<K, V> {
    const keyBytes = this.#options.keyBytes(key);
    const result = deleteRadixNode(
      this.#options,
      this.#root,
      radixPathSlots(keyBytes, this.#options.radix),
      radixBytesKey(keyBytes),
    );
    return result.deleted
      ? new PersistentRadixValueMap(
          ensureRadixRootBranch(this.#options, result.node),
          this.#leafCount - 1,
          this.#options,
        )
      : this;
  }

  emptied(): PersistentRadixValueMap<K, V> {
    return this.#root === null
      ? this
      : new PersistentRadixValueMap(null, 0, this.#options);
  }

  rootHash(): string {
    if (this.#options.commitment === false) {
      throw new Error('PERSISTENT_RADIX_COMMITMENT_DISABLED');
    }
    if (this.#hash !== undefined) return this.#hash;
    if (!this.#root) {
      this.#hash = EMPTY_RADIX_MERKLE_ROOT;
      return this.#hash;
    }
    this.#hash = sealRadixNode(this.#options, this.#root, this.#stats);
    return this.#hash;
  }

  /**
   * Physical DB projection of this exact RAM Patricia graph.
   *
   * This is intentionally a node stream, never a flat key/value rebuild:
   * branch records retain the same compressed paths and child integrity edges
   * that make path-copy updates O(dirty path). Full traversal is reserved for
   * cold snapshots; ordinary frames use `nodeChangesSince` below.
   */
  *nodeRecords(): Generator<PersistentRadixNodeRecord<K, V>> {
    if (this.#options.commitment === false) {
      throw new Error('PERSISTENT_RADIX_NODE_STORAGE_REQUIRES_COMMITMENT');
    }
    this.rootHash();
    const visit = function* (
      node: ValueNode<K, V> | null,
    ): Generator<PersistentRadixNodeRecord<K, V>> {
      if (!node) return;
      yield nodeRecord(node);
      if (node.kind === 'branch') {
        for (const child of childrenInSlotOrder(node)) yield* visit(child);
      }
    };
    yield* visit(this.#root);
  }

  /**
   * Exact physical mutations between two persistent roots.
   * Shared subtrees are skipped by object identity; a one-leaf update emits
   * only that leaf and its compressed parent chain, never all market pages.
   */
  nodeChangesSince(previous: PersistentRadixValueMap<K, V>): PersistentRadixNodeChanges<K, V> {
    if (this.#options !== previous.#options) {
      throw new Error('PERSISTENT_RADIX_NODE_DIFF_OPTIONS_MISMATCH');
    }
    if (this.#options.commitment === false) {
      throw new Error('PERSISTENT_RADIX_NODE_STORAGE_REQUIRES_COMMITMENT');
    }
    this.rootHash();
    previous.rootHash();
    const puts: PersistentRadixNodeRecord<K, V>[] = [];
    const dels: PersistentRadixNodeRef[] = [];
    collectChangedNodePuts(this.#root, previous.#root, puts);
    collectChangedNodeDels(previous.#root, this.#root, dels);
    puts.sort(compareNodeOrder);
    dels.sort(compareNodeOrder);
    // Replacement keeps the physical `(kind,path)` key as a put. A del at that
    // same key would delete the node we just wrote.
    const putKeys = new Set(puts.map(record => nodePathKey(record.kind, record.path)));
    for (const record of dels) {
      const key = nodePathKey(record.kind, record.path);
      if (putKeys.has(key)) throw new Error(`PERSISTENT_RADIX_NODE_DIFF_OVERLAP:${key}`);
    }
    return { puts, dels };
  }

  firstEntry(): [K, V] | undefined {
    const leaf = extremeLeaf(this.#root, 'first');
    return leaf ? [leaf.key, leaf.value] : undefined;
  }

  lastEntry(): [K, V] | undefined {
    const leaf = extremeLeaf(this.#root, 'last');
    return leaf ? [leaf.key, leaf.value] : undefined;
  }

  firstEntryWithPrefix(prefixBytes: Uint8Array): [K, V] | undefined {
    if (prefixBytes.length === 0) throw new Error('PERSISTENT_RADIX_PREFIX_EMPTY');
    const leaf = extremeLeaf(
      prefixNode(this.#root, radixPathSlots(prefixBytes, this.#options.radix)),
      'first',
    );
    return leaf ? [leaf.key, leaf.value] : undefined;
  }

  lastEntryWithPrefix(prefixBytes: Uint8Array): [K, V] | undefined {
    if (prefixBytes.length === 0) throw new Error('PERSISTENT_RADIX_PREFIX_EMPTY');
    const leaf = extremeLeaf(
      prefixNode(this.#root, radixPathSlots(prefixBytes, this.#options.radix)),
      'last',
    );
    return leaf ? [leaf.key, leaf.value] : undefined;
  }

  *entriesWithPrefix(prefixBytes: Uint8Array): MapIterator<[K, V]> {
    if (prefixBytes.length === 0) throw new Error('PERSISTENT_RADIX_PREFIX_EMPTY');
    const node = prefixNode(this.#root, radixPathSlots(prefixBytes, this.#options.radix));
    for (const leaf of iterateLeaves(node)) yield [leaf.key, leaf.value];
  }

  *entries(): MapIterator<[K, V]> {
    for (const leaf of iterateLeaves(this.#root)) yield [leaf.key, leaf.value];
  }

  *reverseEntries(): MapIterator<[K, V]> {
    for (const leaf of iterateLeavesReverse(this.#root)) yield [leaf.key, leaf.value];
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}
