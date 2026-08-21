/** Persistent radix-16 storage for potentially large Entity string-keyed collections. */

import { computeIntegrityDigest } from '../../support/integrity-checksum';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { encodeRawRadixTextKey } from '../../protocol/state/radix-merkle';
import {
  PersistentRadixValueMap,
  type PersistentRadixNodeChanges,
  type PersistentRadixNodeRecord,
  type PersistentRadixValueMapOptions,
  type RadixFoldMutation,
} from '../../protocol/state/persistent-radix-value-map';

const UTF8 = new TextEncoder();
const MAX_ENTITY_COLLECTION_LEAF_BYTES = 10_000;

const valueHash = <Value>(value: Value): string => {
  const encoded = UTF8.encode(encodeCanonicalConsensusValue(value));
  if (encoded.byteLength > MAX_ENTITY_COLLECTION_LEAF_BYTES) {
    throw new Error(
      `ENTITY_COLLECTION_LEAF_TOO_LARGE:${encoded.byteLength}:${MAX_ENTITY_COLLECTION_LEAF_BYTES}`,
    );
  }
  return computeIntegrityDigest(encoded);
};

const sealEntityCollectionValue = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map || value instanceof Set) {
    throw new Error('ENTITY_COLLECTION_LEAF_NESTED_COLLECTION_FORBIDDEN');
  }
  const copy = Array.isArray(value)
    ? value.map(entry => sealEntityCollectionValue(entry))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, sealEntityCollectionValue(entry)]),
      );
  return Object.freeze(copy) as Value;
};

const options = <Value>(): PersistentRadixValueMapOptions<string, Value> => ({
  radix: 16 as const,
  ownKey: (key: string): string => key,
  keyBytes: encodeRawRadixTextKey,
  valueHash: (value: Value): string => valueHash(value),
  // A leaf and every nested record are immutable behind the committed root.
  // Candidate mutation must first fork this one bounded (<10 KiB) leaf.
  ownValue: (value: Value): Value => sealEntityCollectionValue(value),
});

/** Committed map: raw keys and typed values in leaves; hashes exist only on branches. */
export class PersistentEntityCollectionMap<Value> implements Map<string, Value> {
  readonly [Symbol.toStringTag] = 'Map';
  readonly #values: PersistentRadixValueMap<string, Value>;

  private constructor(values: PersistentRadixValueMap<string, Value>) {
    this.#values = values;
  }

  static empty<Value>(): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap<Value>(
      PersistentRadixValueMap.empty<string, Value>(options<Value>()),
    );
  }

  static from<Value>(source: ReadonlyMap<string, Value>): PersistentEntityCollectionMap<Value> {
    if (source instanceof PersistentEntityCollectionMap) return source;
    if (source instanceof EntityCollectionCandidateMap) return source.snapshotCandidate();
    return new PersistentEntityCollectionMap<Value>(
      PersistentRadixValueMap.fromMap<string, Value>(source, options<Value>()),
    );
  }

  /** Cold storage boundary: relink the persisted graph without rebuilding it. */
  static fromNodeRecords<Value>(
    records: Iterable<PersistentRadixNodeRecord<string, Value>>,
  ): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap<Value>(
      PersistentRadixValueMap.fromNodeRecords(records, options<Value>()),
    );
  }

  updated(key: string, value: Value): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap(this.#values.updated(key, value));
  }

  removed(key: string): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap(this.#values.removed(key));
  }

  foldDirty(
    mutations: Iterable<RadixFoldMutation<string, Value>>,
    reset = false,
  ): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap(this.#values.foldMutations(mutations, reset));
  }

  rootHash(): string { return this.#values.rootHash(); }

  /** Full traversal is reserved for a first checkpoint or cold snapshot. */
  nodeRecords(): Generator<PersistentRadixNodeRecord<string, Value>> {
    return this.#values.nodeRecords();
  }

  /** Exact dirty Patricia paths since the previously materialized root. */
  nodeChangesSince(
    previous: PersistentEntityCollectionMap<Value>,
  ): PersistentRadixNodeChanges<string, Value> {
    return this.#values.nodeChangesSince(previous.#values);
  }
  get size(): number { return this.#values.size; }
  get(key: string): Value | undefined { return this.#values.get(key); }
  has(key: string): boolean { return this.#values.has(key); }
  entries(): MapIterator<[string, Value]> { return this.#values.entries(); }
  keys(): MapIterator<string> { return this.#values.keys(); }
  values(): MapIterator<Value> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[string, Value]> { return this.entries(); }
  forEach(
    callback: (value: Value, key: string, map: Map<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
  set(_key: string, _value: Value): this { throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE'); }
  delete(_key: string): boolean { throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE'); }
  clear(): void { throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE'); }
  getOrInsert(_key: string, _defaultValue: Value): Value {
    throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE');
  }
  getOrInsertComputed(_key: string, _callback: (key: string) => Value): Value {
    throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE');
  }
}

export const isPersistentEntityCollectionMap = (
  value: unknown,
): value is PersistentEntityCollectionMap<unknown> =>
  value instanceof PersistentEntityCollectionMap;

/** RAM-only dirty-key overlay. Rejection drops it; certification path-copies only changed branches. */
export class EntityCollectionCandidateMap<Value> implements Map<string, Value> {
  readonly [Symbol.toStringTag] = 'Map';
  readonly #base: PersistentEntityCollectionMap<Value>;
  readonly #forkValue: (value: Value) => Value;
  readonly #changes = new Map<string, Value>();
  readonly #deleted = new Set<string>();
  #projection: PersistentEntityCollectionMap<Value> | undefined;
  #cleared = false;
  #sealed = false;

  constructor(source: ReadonlyMap<string, Value>, forkValue: (value: Value) => Value) {
    this.#base = PersistentEntityCollectionMap.from(source);
    this.#forkValue = forkValue;
  }

  get size(): number {
    if (this.#cleared) return this.#changes.size;
    let size = this.#base.size - this.#deleted.size;
    for (const key of this.#changes.keys()) if (!this.#base.has(key)) size += 1;
    return size;
  }

  get(key: string): Value | undefined {
    this.#requireActive();
    if (this.#deleted.has(key)) return undefined;
    const changed = this.#changes.get(key);
    if (changed !== undefined) return changed;
    return this.#cleared ? undefined : this.#base.get(key);
  }

  /** Claim one exact leaf for mutation; ordinary reads never dirty the root. */
  getForWrite(key: string): Value | undefined {
    this.#requireActive();
    if (this.#deleted.has(key)) return undefined;
    const changed = this.#changes.get(key);
    if (changed !== undefined) {
      if (typeof changed === 'object' && changed !== null && Object.isFrozen(changed)) {
        const forked = this.#forkValue(changed);
        this.#changes.set(key, forked);
        this.#projection = undefined;
        return forked;
      }
      return changed;
    }
    const committed = this.#cleared ? undefined : this.#base.get(key);
    if (committed === undefined) return undefined;
    const forked = this.#forkValue(committed);
    this.#changes.set(key, forked);
    this.#projection = undefined;
    return forked;
  }

  has(key: string): boolean {
    return !this.#deleted.has(key) && (
      this.#changes.has(key) || (!this.#cleared && this.#base.has(key))
    );
  }

  set(key: string, value: Value): this {
    this.#requireActive();
    this.#deleted.delete(key);
    this.#changes.set(key, value);
    this.#projection = undefined;
    return this;
  }
  getOrInsert(key: string, defaultValue: Value): Value {
    const current = this.get(key);
    if (current !== undefined || this.has(key)) return current as Value;
    this.set(key, defaultValue);
    return defaultValue;
  }
  getOrInsertComputed(key: string, callback: (key: string) => Value): Value {
    const current = this.get(key);
    if (current !== undefined || this.has(key)) return current as Value;
    const value = callback(key);
    this.set(key, value);
    return value;
  }

  delete(key: string): boolean {
    this.#requireActive();
    const existed = this.has(key);
    this.#changes.delete(key);
    if (!this.#cleared && this.#base.has(key)) this.#deleted.add(key);
    this.#projection = undefined;
    return existed;
  }

  clear(): void {
    this.#requireActive();
    this.#changes.clear();
    this.#deleted.clear();
    this.#cleared = true;
    this.#projection = undefined;
  }

  *entries(): MapIterator<[string, Value]> {
    if (!this.#cleared) {
      for (const [key, value] of this.#base) {
        if (!this.#deleted.has(key)) yield [key, this.#changes.get(key) ?? value];
      }
    }
    for (const [key, value] of this.#changes) {
      if (this.#cleared || !this.#base.has(key)) yield [key, value];
    }
  }
  *keys(): MapIterator<string> { for (const [key] of this.entries()) yield key; }
  *values(): MapIterator<Value> { for (const [, value] of this.entries()) yield value; }
  [Symbol.iterator](): MapIterator<[string, Value]> { return this.entries(); }
  forEach(
    callback: (value: Value, key: string, map: Map<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }

  rootHash(): string { return this.#project().rootHash(); }

  get hash(): string { return this.rootHash(); }

  snapshotCandidate(): PersistentEntityCollectionMap<Value> { return this.#project(); }

  sealCandidate(): PersistentEntityCollectionMap<Value> {
    const projected = this.#project();
    this.#sealed = true;
    return projected;
  }

  #project(): PersistentEntityCollectionMap<Value> {
    if (this.#projection) return this.#projection;
    const mutations: RadixFoldMutation<string, Value>[] = [
      ...[...this.#deleted].sort().map(key => ({ kind: 'delete' as const, key })),
      ...[...this.#changes]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => ({ kind: 'put' as const, key, value })),
    ];
    this.#projection = this.#base.foldDirty(mutations, this.#cleared);
    return this.#projection;
  }

  #requireActive(): void {
    if (this.#sealed) throw new Error('ENTITY_COLLECTION_CANDIDATE_SEALED');
  }
}

/** Entity handlers must state write intent before mutating a growing leaf. */
export const getEntityCollectionValueForWrite = <Value>(
  source: Map<string, Value>,
  key: string,
): Value | undefined => {
  if (!(source instanceof EntityCollectionCandidateMap)) {
    throw new Error('ENTITY_COLLECTION_WRITE_OUTSIDE_CANDIDATE');
  }
  return source.getForWrite(key);
};

/** Start an optional growing collection inside an already-owned Entity frame. */
export const createEmptyEntityCollectionCandidate = <Value>(
  forkValue: (value: Value) => Value,
): EntityCollectionCandidateMap<Value> => new EntityCollectionCandidateMap(
  PersistentEntityCollectionMap.empty<Value>(),
  forkValue,
);

/** Own a missing optional collection; never replace a committed Patricia map with a plain Map. */
export const ensureEntityCollectionCandidate = <Value>(
  source: Map<string, Value> | undefined,
  forkValue: (value: Value) => Value,
): EntityCollectionCandidateMap<Value> => {
  if (source instanceof EntityCollectionCandidateMap) return source;
  if (source === undefined) return createEmptyEntityCollectionCandidate(forkValue);
  throw new Error('ENTITY_COLLECTION_WRITE_OUTSIDE_CANDIDATE');
};

export const entityCollectionCommitment = <Value>(source: ReadonlyMap<string, Value>): Readonly<{
  radix: 16;
  leafCount: number;
  root: string;
}> => {
  const persistent = source instanceof EntityCollectionCandidateMap
    ? source
    : PersistentEntityCollectionMap.from(source);
  return { radix: 16, leafCount: persistent.size, root: persistent.rootHash() };
};
