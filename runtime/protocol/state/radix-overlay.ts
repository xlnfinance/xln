/**
 * Explicit transaction overlay for one persistent Patricia collection.
 * Reads never claim values for mutation; writes accumulate by canonical key.
 * Human-audit importance: 100/100 — this replaces hidden machine cloning.
 */
import {
  PersistentRadixValueMap,
  type PersistentRadixNodeChanges,
} from './persistent-radix-value-map';

const RADIX_OVERLAY_VIEW = Symbol('RADIX_OVERLAY_VIEW');
const RADIX_OVERLAY_OWNER = Symbol('RADIX_OVERLAY_OWNER');

type OverlayLifecycle = 'active' | 'prepared' | 'discarded';
type OverlayPut<K, V> = Readonly<{
  kind: 'put';
  key: K;
  keyBytes: Uint8Array;
  value: V;
}>;
type OverlayDelete<K> = Readonly<{
  kind: 'delete';
  key: K;
  keyBytes: Uint8Array;
}>;
type OverlayMutation<K, V> = OverlayPut<K, V> | OverlayDelete<K>;

export interface RadixOverlayView<K, V> {
  readonly [RADIX_OVERLAY_VIEW]: true;
  readonly size: number;
  get(key: K): V | undefined;
  has(key: K): boolean;
  edit(key: K, update: (previous: V) => V): void;
  put(key: K, value: V): void;
  del(key: K): boolean;
  /** Replace the collection root with empty without enumerating live leaves. */
  reset(): void;
  entries(): IterableIterator<readonly [K, V]>;
  entriesWithPrefix(prefixBytes: Uint8Array): IterableIterator<readonly [K, V]>;
}

export interface RadixOverlayOwner<K, V> {
  readonly [RADIX_OVERLAY_OWNER]: true;
  readonly view: RadixOverlayView<K, V>;
}

export type PreparedRadixOverlay<K, V> = Readonly<{
  baseRoot: string;
  root: string;
  values: PersistentRadixValueMap<K, V>;
  nodeChanges: PersistentRadixNodeChanges<K, V>;
}>;

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

const startsWithBytes = (value: Uint8Array, prefix: Uint8Array): boolean => {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  return true;
};

const keyIdentity = (bytes: Uint8Array): string => {
  if (bytes.length === 0) throw new Error('RADIX_OVERLAY_KEY_EMPTY');
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
};

class RadixOverlayTransaction<K, V> implements RadixOverlayOwner<K, V> {
  readonly [RADIX_OVERLAY_OWNER] = true as const;
  readonly view: RadixOverlayView<K, V>;
  readonly #base: PersistentRadixValueMap<K, V>;
  readonly #mutations = new Map<string, OverlayMutation<K, V>>();
  #lifecycle: OverlayLifecycle = 'active';
  #reset = false;

  constructor(base: PersistentRadixValueMap<K, V>) {
    this.#base = base;
    this.view = new RadixOverlayReadWriteView(this);
  }

  requireActive(): void {
    if (this.#lifecycle !== 'active') {
      throw new Error(`RADIX_OVERLAY_NOT_ACTIVE:${this.#lifecycle}`);
    }
  }

  describeKey(key: K): Readonly<{ id: string; key: K; keyBytes: Uint8Array }> {
    const prepared = this.#base.prepareKey(key);
    return {
      id: keyIdentity(prepared.keyBytes),
      key: prepared.key,
      keyBytes: prepared.keyBytes,
    };
  }

  prepareValue(value: V): V {
    return this.#base.prepareValue(value);
  }

  sortedMutations(prefix?: Uint8Array): readonly OverlayMutation<K, V>[] {
    return [...this.#mutations.values()]
      .filter(mutation => prefix === undefined || startsWithBytes(mutation.keyBytes, prefix))
      .sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
  }

  mutations(): Iterable<OverlayMutation<K, V>> {
    return this.#mutations.values();
  }

  readEntry(key: K): readonly [K, V] | undefined {
    const described = this.describeKey(key);
    const mutation = this.#mutations.get(described.id);
    if (mutation) return mutation.kind === 'put' ? [mutation.key, mutation.value] : undefined;
    return this.#reset ? undefined : this.#base.getEntry(described.key);
  }

  baseSize(): number { return this.#reset ? 0 : this.#base.size; }
  baseHas(key: K): boolean { return !this.#reset && this.#base.has(key); }
  baseEntries(): IterableIterator<readonly [K, V]> {
    return this.#reset ? [][Symbol.iterator]() : this.#base.entries();
  }
  baseEntriesWithPrefix(prefix: Uint8Array): IterableIterator<readonly [K, V]> {
    return this.#reset ? [][Symbol.iterator]() : this.#base.entriesWithPrefix(prefix);
  }

  put(key: K, value: V): void {
    const described = this.describeKey(key);
    this.#mutations.set(described.id, {
      kind: 'put',
      key: described.key,
      keyBytes: described.keyBytes,
      value: this.prepareValue(value),
    });
  }

  del(key: K): void {
    const described = this.describeKey(key);
    this.#mutations.set(described.id, {
      kind: 'delete',
      key: described.key,
      keyBytes: described.keyBytes,
    });
  }

  reset(): void {
    this.requireActive();
    this.#reset = true;
    this.#mutations.clear();
  }

  prepare(): PreparedRadixOverlay<K, V> {
    this.requireActive();
    this.#base.rootHash();
    const values = this.#base.foldMutations(
      this.sortedMutations().map(mutation => mutation.kind === 'put'
        ? { kind: 'put', key: mutation.key, value: mutation.value }
        : { kind: 'delete', key: mutation.key }),
      this.#reset,
    );
    const prepared = Object.freeze({
      baseRoot: this.#base.rootHash(),
      root: values.rootHash(),
      values,
      nodeChanges: values.nodeChangesSince(this.#base),
    });
    this.#lifecycle = 'prepared';
    return prepared;
  }

  discard(): void {
    if (this.#lifecycle === 'discarded') {
      throw new Error('RADIX_OVERLAY_NOT_ACTIVE:discarded');
    }
    // Aggregate Account preparation may fail after an earlier child Patricia
    // owner was prepared. Prepared roots are still unpublished immutable
    // values, so consuming them as discarded is the only exception-safe
    // rollback; the committed base was never mutated.
    this.#lifecycle = 'discarded';
  }
}

class RadixOverlayReadWriteView<K, V> implements RadixOverlayView<K, V> {
  readonly [RADIX_OVERLAY_VIEW] = true as const;
  readonly #tx: RadixOverlayTransaction<K, V>;

  constructor(tx: RadixOverlayTransaction<K, V>) {
    this.#tx = tx;
  }

  get size(): number {
    this.#tx.requireActive();
    let size = this.#tx.baseSize();
    for (const mutation of this.#tx.mutations()) {
      const existed = this.#tx.baseHas(mutation.key);
      if (mutation.kind === 'delete' && existed) size -= 1;
      if (mutation.kind === 'put' && !existed) size += 1;
    }
    return size;
  }

  get(key: K): V | undefined {
    this.#tx.requireActive();
    return this.#tx.readEntry(key)?.[1];
  }

  has(key: K): boolean {
    this.#tx.requireActive();
    return this.#tx.readEntry(key) !== undefined;
  }

  edit(key: K, update: (previous: V) => V): void {
    this.#tx.requireActive();
    const entry = this.#tx.readEntry(key);
    if (!entry) throw new Error('RADIX_OVERLAY_EDIT_MISSING');
    const previous = entry[1];
    const next = update(previous);
    if (typeof next === 'object' && next !== null && Object.is(next, previous)) {
      throw new Error('RADIX_OVERLAY_EDIT_ALIAS');
    }
    this.put(key, next);
  }

  put(key: K, value: V): void {
    this.#tx.requireActive();
    this.#tx.put(key, value);
  }

  del(key: K): boolean {
    this.#tx.requireActive();
    const existed = this.has(key);
    this.#tx.del(key);
    return existed;
  }

  reset(): void {
    this.#tx.reset();
  }

  entries(): IterableIterator<readonly [K, V]> {
    return this.mergeEntries();
  }

  entriesWithPrefix(prefixBytes: Uint8Array): IterableIterator<readonly [K, V]> {
    if (prefixBytes.length === 0) throw new Error('RADIX_OVERLAY_PREFIX_EMPTY');
    return this.mergeEntries(prefixBytes);
  }

  *mergeEntries(prefix?: Uint8Array): IterableIterator<readonly [K, V]> {
    this.#tx.requireActive();
    const base = prefix === undefined
      ? this.#tx.baseEntries()
      : this.#tx.baseEntriesWithPrefix(prefix);
    const dirty = this.#tx.sortedMutations(prefix);
    let baseEntry = base.next();
    let dirtyIndex = 0;
    while (!baseEntry.done || dirtyIndex < dirty.length) {
      this.#tx.requireActive();
      const mutation = dirty[dirtyIndex];
      if (baseEntry.done) {
        if (mutation?.kind === 'put') yield [mutation.key, mutation.value];
        dirtyIndex += 1;
        continue;
      }
      const [baseKey, baseValue] = baseEntry.value;
      if (!mutation) {
        yield [baseKey, baseValue];
        baseEntry = base.next();
        continue;
      }
      const baseBytes = this.#tx.describeKey(baseKey).keyBytes;
      const order = compareBytes(baseBytes, mutation.keyBytes);
      if (order < 0) {
        yield [baseKey, baseValue];
        baseEntry = base.next();
      } else if (order > 0) {
        if (mutation.kind === 'put') yield [mutation.key, mutation.value];
        dirtyIndex += 1;
      } else {
        if (mutation.kind === 'put') yield [mutation.key, mutation.value];
        dirtyIndex += 1;
        baseEntry = base.next();
      }
    }
  }
}

const requireTransaction = <K, V>(
  owner: RadixOverlayOwner<K, V>,
): RadixOverlayTransaction<K, V> => {
  if (!(owner instanceof RadixOverlayTransaction)) {
    throw new Error('RADIX_OVERLAY_OWNER_INVALID');
  }
  return owner;
};

export const beginRadixOverlay = <K, V>(
  base: PersistentRadixValueMap<K, V>,
): RadixOverlayOwner<K, V> => new RadixOverlayTransaction(base);

/** Machine-only owner operation. Layer barrels must not export this to handlers. */
export const prepareRadixOverlay = <K, V>(
  owner: RadixOverlayOwner<K, V>,
): PreparedRadixOverlay<K, V> => {
  const tx = requireTransaction(owner);
  return tx.prepare();
};

/** Machine-only owner operation. Discard is a consume, not an idempotent cleanup. */
export const discardRadixOverlay = <K, V>(owner: RadixOverlayOwner<K, V>): void => {
  const tx = requireTransaction(owner);
  tx.discard();
};
