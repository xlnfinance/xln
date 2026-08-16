/** Persistent radix-16 storage for potentially large Entity string-keyed collections. */

import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { encodeRawRadixTextKey } from '../../protocol/state/radix-merkle';
import {
  PersistentRadixValueMap,
  type PersistentRadixValueMapOptions,
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
  sealKey: (key: string): string => key,
  keyBytes: encodeRawRadixTextKey,
  valueHash: (value: Value): string => valueHash(value),
  // A leaf and every nested record are immutable behind the committed root.
  // Candidate mutation must first fork this one bounded (<10 KiB) leaf.
  sealValue: (value: Value): Value => sealEntityCollectionValue(value),
});

/** Committed map: raw keys and typed values in leaves; hashes exist only on branches. */
export class PersistentEntityCollectionMap<Value> extends Map<string, Value> {
  readonly #values: PersistentRadixValueMap<string, Value>;

  private constructor(values: PersistentRadixValueMap<string, Value>) {
    super();
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

  updated(key: string, value: Value): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap(this.#values.updated(key, value));
  }

  removed(key: string): PersistentEntityCollectionMap<Value> {
    return new PersistentEntityCollectionMap(this.#values.removed(key));
  }

  rootHash(): string { return this.#values.rootHash(); }
  override get size(): number { return this.#values.size; }
  override get(key: string): Value | undefined { return this.#values.get(key); }
  override has(key: string): boolean { return this.#values.has(key); }
  override entries(): MapIterator<[string, Value]> { return this.#values.entries(); }
  override keys(): MapIterator<string> { return this.#values.keys(); }
  override values(): MapIterator<Value> { return this.#values.values(); }
  override [Symbol.iterator](): MapIterator<[string, Value]> { return this.entries(); }
  override forEach(
    callback: (value: Value, key: string, map: Map<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
  override set(_key: string, _value: Value): this { throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE'); }
  override delete(_key: string): boolean { throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE'); }
  override clear(): void { throw new Error('PERSISTENT_ENTITY_COLLECTION_IMMUTABLE'); }
}

/** RAM-only dirty-key overlay. Rejection drops it; certification path-copies only changed branches. */
export class EntityCollectionCandidateMap<Value> extends Map<string, Value> {
  readonly #base: PersistentEntityCollectionMap<Value>;
  readonly #forkValue: (value: Value) => Value;
  readonly #changes = new Map<string, Value>();
  readonly #deleted = new Set<string>();
  #projection: PersistentEntityCollectionMap<Value> | undefined;
  #sealed = false;

  constructor(source: ReadonlyMap<string, Value>, forkValue: (value: Value) => Value) {
    super();
    this.#base = PersistentEntityCollectionMap.from(source);
    this.#forkValue = forkValue;
  }

  override get size(): number {
    let size = this.#base.size - this.#deleted.size;
    for (const key of this.#changes.keys()) if (!this.#base.has(key)) size += 1;
    return size;
  }

  override get(key: string): Value | undefined {
    this.#requireActive();
    if (this.#deleted.has(key)) return undefined;
    const changed = this.#changes.get(key);
    if (changed !== undefined) return changed;
    return this.#base.get(key);
  }

  /** Claim one exact leaf for mutation; ordinary reads never dirty the root. */
  getForWrite(key: string): Value | undefined {
    this.#requireActive();
    if (this.#deleted.has(key)) return undefined;
    const changed = this.#changes.get(key);
    if (changed !== undefined) return changed;
    const committed = this.#base.get(key);
    if (committed === undefined) return undefined;
    const forked = this.#forkValue(committed);
    this.#changes.set(key, forked);
    this.#projection = undefined;
    return forked;
  }

  override has(key: string): boolean {
    return !this.#deleted.has(key) && (this.#changes.has(key) || this.#base.has(key));
  }

  override set(key: string, value: Value): this {
    this.#requireActive();
    this.#deleted.delete(key);
    this.#changes.set(key, value);
    this.#projection = undefined;
    return this;
  }

  override delete(key: string): boolean {
    this.#requireActive();
    const existed = this.has(key);
    this.#changes.delete(key);
    if (this.#base.has(key)) this.#deleted.add(key);
    this.#projection = undefined;
    return existed;
  }

  override clear(): void {
    this.#requireActive();
    this.#changes.clear();
    for (const key of this.#base.keys()) this.#deleted.add(key);
    this.#projection = undefined;
  }

  override *entries(): MapIterator<[string, Value]> {
    for (const [key, value] of this.#base) {
      if (!this.#deleted.has(key)) yield [key, this.#changes.get(key) ?? value];
    }
    for (const [key, value] of this.#changes) if (!this.#base.has(key)) yield [key, value];
  }
  override *keys(): MapIterator<string> { for (const [key] of this.entries()) yield key; }
  override *values(): MapIterator<Value> { for (const [, value] of this.entries()) yield value; }
  override [Symbol.iterator](): MapIterator<[string, Value]> { return this.entries(); }
  override forEach(
    callback: (value: Value, key: string, map: Map<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }

  rootHash(): string { return this.#project().rootHash(); }

  snapshotCandidate(): PersistentEntityCollectionMap<Value> { return this.#project(); }

  sealCandidate(): PersistentEntityCollectionMap<Value> {
    const projected = this.#project();
    this.#sealed = true;
    return projected;
  }

  #project(): PersistentEntityCollectionMap<Value> {
    if (this.#projection) return this.#projection;
    let projected = this.#base;
    for (const key of this.#deleted) projected = projected.removed(key);
    for (const [key, value] of this.#changes) projected = projected.updated(key, value);
    this.#projection = projected;
    return projected;
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
