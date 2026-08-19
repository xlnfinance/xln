/**
 * Persistent radix16 storage for every Account collection that may grow.
 * Raw branded keys select Patricia paths; values are sealed before commitment.
 * Human-audit importance: 100/100 — this keeps Account updates O(dirty path).
 */
import { computeIntegrityDigest } from '../../support/integrity-checksum';
import { encodeRawRadixTextKey } from '../../protocol/state/radix-merkle';
import {
  PersistentRadixValueMap,
  type PersistentRadixNodeChanges,
  type PersistentRadixNodeRecord,
  type PersistentRadixValueMapOptions,
} from '../../protocol/state/persistent-radix-value-map';
import { encodeAccountStateValue } from '../commitment/account-state-value';

export const ACCOUNT_STATE_MAP_NAMESPACES = [
  'deltas',
  'locks',
  'pulls',
  'swapOffers',
  'subcontracts',
  'lendingIntents',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
  'pendingWithdrawals',
  'rebalanceShadowPolicy',
  'rebalanceShadowSubmitted',
] as const;

export type AccountStateMapNamespace = (typeof ACCOUNT_STATE_MAP_NAMESPACES)[number];
export type AccountStateMapKey = number | string;
export type AccountStateRadixKey = Uint8Array & {
  readonly __accountStateRadixKey: 'AccountStateRadixKey';
};

export const ACCOUNT_STATE_COLLECTION: unique symbol = Symbol('ACCOUNT_STATE_COLLECTION');
const READONLY_ACCOUNT_STATE_MAP: unique symbol = Symbol('READONLY_ACCOUNT_STATE_MAP');

/** Shared read contract implemented by committed maps and ephemeral drafts. */
export interface AccountStateCollection<K extends AccountStateMapKey, V> extends ReadonlyMap<K, V> {
  readonly [ACCOUNT_STATE_COLLECTION]: true;
}

/** Financial handlers can read this committed view but cannot mutate it. */
export interface ReadonlyAccountStateMap<K extends AccountStateMapKey, V>
  extends AccountStateCollection<K, V> {
  readonly [READONLY_ACCOUNT_STATE_MAP]: true;
  readonly namespace: AccountStateMapNamespace;
  rootHash(): string;
  coldRootHash(): string;
  updated(key: K, value: V): ReadonlyAccountStateMap<K, V>;
  removed(key: K): ReadonlyAccountStateMap<K, V>;
  emptied(): ReadonlyAccountStateMap<K, V>;
}

const MAX_ACCOUNT_STATE_LEAF_BYTES = 10_000;

const tokenKeyBytes = (tokenId: number): Uint8Array => {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
    throw new Error(`ACCOUNT_STATE_TOKEN_KEY_INVALID:${String(tokenId)}`);
  }
  const output = new Uint8Array(32);
  let remaining = BigInt(tokenId);
  for (let index = output.length - 1; index >= 0 && remaining > 0n; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
};

/** Prefix-free raw key bytes: uint256 tokens or length-prefixed UTF-8 IDs. */
export const encodeAccountStateRadixKey = <N extends AccountStateMapNamespace>(
  _namespace: N,
  key: AccountStateMapKey,
): AccountStateRadixKey => {
  const bytes = typeof key === 'number' ? tokenKeyBytes(key) : encodeRawRadixTextKey(key);
  return bytes as AccountStateRadixKey;
};

const sealValue = <V>(value: V): V => {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map || value instanceof Set) {
    throw new Error('ACCOUNT_STATE_LEAF_NESTED_COLLECTION_FORBIDDEN');
  }
  const copy = Array.isArray(value)
    ? value.map(entry => sealValue(entry))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sealValue(entry)]));
  // A Patricia leaf is immutable by identity. `configurable: true` is not
  // sufficient: delete/defineProperty could change bytes behind an old hash.
  // Nested values are sealed first, then the containing record is frozen.
  return Object.freeze(copy) as V;
};

const commitmentValue = (
  namespace: AccountStateMapNamespace,
  value: unknown,
): unknown => {
  if (namespace !== 'pendingWithdrawals' || value === null || typeof value !== 'object') return value;
  const { signature: _signature, ...unsigned } = value as Record<string, unknown>;
  return unsigned;
};

const assertAccountStateLeafSize = (
  namespace: AccountStateMapNamespace,
  value: unknown,
): void => {
  const encoded = encodeAccountStateValue(commitmentValue(namespace, value));
  if (encoded.byteLength > MAX_ACCOUNT_STATE_LEAF_BYTES) {
    throw new Error(`ACCOUNT_STATE_LEAF_TOO_LARGE:${encoded.byteLength}:${MAX_ACCOUNT_STATE_LEAF_BYTES}`);
  }
};

const valueHash = (namespace: AccountStateMapNamespace, value: unknown): string =>
  computeIntegrityDigest(encodeAccountStateValue(commitmentValue(namespace, value)));

const namespaceOptions = <K extends AccountStateMapKey, V>(
  namespace: AccountStateMapNamespace,
): PersistentRadixValueMapOptions<K, V> => ({
  radix: 16,
  ownKey: (key: K): K => key,
  keyBytes: (key: K): Uint8Array => encodeAccountStateRadixKey(namespace, key),
  valueHash: (value: V): string => valueHash(namespace, value),
  ownValue: (value: V): V => {
    const sealed = sealValue(value);
    assertAccountStateLeafSize(namespace, sealed);
    return sealed;
  },
});

/**
 * A Map-compatible read view backed by one persistent Patricia root.
 * Mutations are accepted only by AccountTransitionOverlay; direct writes fail.
 */
export class PersistentAccountStateMap<K extends AccountStateMapKey, V>
  implements ReadonlyAccountStateMap<K, V> {
  readonly [READONLY_ACCOUNT_STATE_MAP] = true as const;
  readonly [ACCOUNT_STATE_COLLECTION] = true as const;
  readonly #values: PersistentRadixValueMap<K, V>;
  readonly namespace: AccountStateMapNamespace;

  private constructor(
    namespace: AccountStateMapNamespace,
    values: PersistentRadixValueMap<K, V>,
  ) {
    this.namespace = namespace;
    this.#values = values;
  }

  static empty<K extends AccountStateMapKey, V>(
    namespace: AccountStateMapNamespace,
  ): PersistentAccountStateMap<K, V> {
    return new PersistentAccountStateMap(
      namespace,
      PersistentRadixValueMap.empty(namespaceOptions<K, V>(namespace)),
    );
  }

  static fromEntries<K extends AccountStateMapKey, V>(
    namespace: AccountStateMapNamespace,
    entries: Iterable<readonly [K, V]>,
  ): PersistentAccountStateMap<K, V> {
    return new PersistentAccountStateMap(
      namespace,
      PersistentRadixValueMap.fromMap(entries, namespaceOptions<K, V>(namespace)),
    );
  }

  /** Cold storage boundary: relink the exact branch/leaf graph without flattening it. */
  static fromNodeRecords<K extends AccountStateMapKey, V>(
    namespace: AccountStateMapNamespace,
    records: Iterable<PersistentRadixNodeRecord<K, V>>,
  ): PersistentAccountStateMap<K, V> {
    return new PersistentAccountStateMap(
      namespace,
      PersistentRadixValueMap.fromNodeRecords(records, namespaceOptions<K, V>(namespace)),
    );
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }

  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) callback.call(thisArg, value, key, this);
  }

  updated(key: K, value: V): PersistentAccountStateMap<K, V> {
    const next = this.#values.updated(key, value);
    return next === this.#values ? this : new PersistentAccountStateMap(this.namespace, next);
  }

  removed(key: K): PersistentAccountStateMap<K, V> {
    const next = this.#values.removed(key);
    return next === this.#values ? this : new PersistentAccountStateMap(this.namespace, next);
  }

  emptied(): PersistentAccountStateMap<K, V> {
    const next = this.#values.emptied();
    return next === this.#values ? this : new PersistentAccountStateMap(this.namespace, next);
  }

  rootHash(): string { return this.#values.rootHash(); }

  get hash(): string { return this.rootHash(); }

  /** Expensive independent oracle reserved for recovery checks and diagnostics. */
  coldRootHash(): string {
    return PersistentRadixValueMap.fromMap(
      this.#values,
      namespaceOptions<K, V>(this.namespace),
    ).rootHash();
  }

  /** Full traversal is snapshot-only; ordinary commits use `nodeChangesSince`. */
  nodeRecords(): Generator<PersistentRadixNodeRecord<K, V>> {
    return this.#values.nodeRecords();
  }

  /** Exact O(dirty-path) physical mutations for the authoritative LevelDB graph. */
  nodeChangesSince(
    previous: PersistentAccountStateMap<K, V>,
  ): PersistentRadixNodeChanges<K, V> {
    if (previous.namespace !== this.namespace) {
      throw new Error(`ACCOUNT_STATE_NODE_DIFF_NAMESPACE_MISMATCH:${this.namespace}`);
    }
    return this.#values.nodeChangesSince(previous.#values);
  }

  /** Machine-only bridge; financial handlers receive only the overlay view. */
  radixValuesForOverlay(): PersistentRadixValueMap<K, V> {
    return this.#values;
  }

  /** Machine-only bridge from a prepared generic overlay to the typed collection. */
  static fromRadixValues<K extends AccountStateMapKey, V>(
    namespace: AccountStateMapNamespace,
    values: PersistentRadixValueMap<K, V>,
  ): PersistentAccountStateMap<K, V> {
    return new PersistentAccountStateMap(namespace, values);
  }
}

export const isPersistentAccountStateMap = (
  value: unknown,
): value is PersistentAccountStateMap<AccountStateMapKey, unknown> =>
  value instanceof PersistentAccountStateMap;

/**
 * Account decoders accept either a freshly decoded Map or our branded
 * Patricia-backed view. The unique symbol cannot arrive from disk/network,
 * so untrusted bytes still have to decode into a real Map first.
 */
export const isAccountStateCollection = (
  value: unknown,
): value is AccountStateCollection<AccountStateMapKey, unknown> =>
  value instanceof Map
  || (
    typeof value === 'object'
    && value !== null
    && ACCOUNT_STATE_COLLECTION in value
    && value[ACCOUNT_STATE_COLLECTION] === true
  );

export const requirePersistentAccountStateMap = <K extends AccountStateMapKey, V>(
  value: AccountStateCollection<K, V>,
  namespace: AccountStateMapNamespace,
): PersistentAccountStateMap<K, V> => {
  if (!(value instanceof PersistentAccountStateMap) || value.namespace !== namespace) {
    throw new Error(`ACCOUNT_STATE_COLLECTION_NOT_COMMITTED:${namespace}`);
  }
  return value;
};
