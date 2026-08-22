/**
 * Typed Account-collection draft over the shared Patricia overlay engine.
 * Handlers receive only `view`; the Account machine owns prepare/discard.
 * Human-audit importance: 100/100 — this is the collection mutation boundary.
 */
import {
  beginRadixOverlay,
  discardRadixOverlay,
  prepareRadixOverlay,
  type PreparedRadixOverlay,
  type RadixOverlayOwner,
  type RadixOverlayView,
} from '../../protocol/state/radix-overlay';
import {
  PersistentAccountStateMap,
  ACCOUNT_STATE_COLLECTION,
  type AccountStateCollection,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from './persistent-state-map';

const ACCOUNT_COLLECTION_DRAFT = Symbol('ACCOUNT_COLLECTION_DRAFT');
const ACCOUNT_COLLECTION_OWNER = Symbol('ACCOUNT_COLLECTION_OWNER');

/** Handler-facing view. It cannot publish, discard, or access a committed root. */
export interface AccountCollectionDraft<K extends AccountStateMapKey, V>
  extends AccountStateCollection<K, Readonly<V>> {
  readonly [ACCOUNT_COLLECTION_DRAFT]: true;
  edit(key: K, update: (previous: Readonly<V>) => V): void;
  put(key: K, value: V): void;
  del(key: K): boolean;
  /** Finality-only root replacement; unlike Map.clear(), this is O(1) in RAM. */
  reset(): void;
}

/** Machine-facing capability. Passing only `.view` enforces ownership in TS. */
export interface AccountCollectionOverlayOwner<K extends AccountStateMapKey, V> {
  readonly [ACCOUNT_COLLECTION_OWNER]: true;
  readonly view: AccountCollectionDraft<K, V>;
}

export type PreparedAccountCollection<K extends AccountStateMapKey, V> = Readonly<{
  namespace: AccountStateMapNamespace;
  values: PersistentAccountStateMap<K, V>;
  nodeChanges: PreparedRadixOverlay<K, V>['nodeChanges'];
}>;

class AccountCollectionOverlay<K extends AccountStateMapKey, V>
  implements AccountCollectionOverlayOwner<K, V> {
  readonly [ACCOUNT_COLLECTION_OWNER] = true as const;
  readonly view: AccountCollectionDraft<K, V>;
  readonly #namespace: AccountStateMapNamespace;
  readonly #radixOwner: RadixOverlayOwner<K, V>;

  readonly #base: PersistentAccountStateMap<K, V>;

  constructor(base: PersistentAccountStateMap<K, V>) {
    this.#namespace = base.namespace;
    this.#base = base;
    this.#radixOwner = beginRadixOverlay(base.radixValuesForOverlay());
    this.view = new AccountCollectionDraftView(this.#radixOwner.view);
  }

  prepare(): PreparedAccountCollection<K, V> {
    const prepared = prepareRadixOverlay(this.#radixOwner);
    // Untouched collection: keep the committed wrapper itself. A fresh wrapper
    // over the same values broke every identity-keyed root memo downstream.
    const values = prepared.values === this.#base.radixValuesForOverlay()
      ? this.#base
      : PersistentAccountStateMap.fromRadixValues(this.#namespace, prepared.values);
    return Object.freeze({
      namespace: this.#namespace,
      values,
      get nodeChanges() { return prepared.nodeChanges; },
    });
  }

  discard(): void {
    discardRadixOverlay(this.#radixOwner);
  }
}

class AccountCollectionDraftView<K extends AccountStateMapKey, V>
  implements AccountCollectionDraft<K, V> {
  readonly [ACCOUNT_COLLECTION_DRAFT] = true as const;
  readonly [ACCOUNT_STATE_COLLECTION] = true as const;
  readonly #view: RadixOverlayView<K, V>;

  constructor(view: RadixOverlayView<K, V>) {
    this.#view = view;
  }

  get size(): number { return this.#view.size; }
  get(key: K): Readonly<V> | undefined { return this.#view.get(key); }
  has(key: K): boolean { return this.#view.has(key); }
  edit(key: K, update: (previous: Readonly<V>) => V): void {
    this.#view.edit(key, update);
  }
  put(key: K, value: V): void { this.#view.put(key, value); }
  del(key: K): boolean { return this.#view.del(key); }
  reset(): void { this.#view.reset(); }

  *entries(): MapIterator<[K, Readonly<V>]> {
    for (const [key, value] of this.#view.entries()) yield [key, value];
  }
  *entriesWithPrefix(prefixBytes: Uint8Array): MapIterator<[K, Readonly<V>]> {
    for (const [key, value] of this.#view.entriesWithPrefix(prefixBytes)) yield [key, value];
  }
  *keys(): MapIterator<K> { for (const [key] of this.entries()) yield key; }
  *values(): MapIterator<Readonly<V>> { for (const [, value] of this.entries()) yield value; }
  [Symbol.iterator](): MapIterator<[K, Readonly<V>]> { return this.entries(); }
  forEach(
    callback: (value: Readonly<V>, key: K, map: ReadonlyMap<K, Readonly<V>>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

const requireOwner = <K extends AccountStateMapKey, V>(
  owner: AccountCollectionOverlayOwner<K, V>,
): AccountCollectionOverlay<K, V> => {
  if (!(owner instanceof AccountCollectionOverlay)) {
    throw new Error('ACCOUNT_COLLECTION_OVERLAY_OWNER_INVALID');
  }
  return owner;
};

export const beginAccountCollectionOverlay = <K extends AccountStateMapKey, V>(
  base: PersistentAccountStateMap<K, V>,
): AccountCollectionOverlayOwner<K, V> => new AccountCollectionOverlay(base);

/** Account-machine-only; handler modules must not import this function. */
export const prepareAccountCollectionOverlay = <K extends AccountStateMapKey, V>(
  owner: AccountCollectionOverlayOwner<K, V>,
): PreparedAccountCollection<K, V> => requireOwner(owner).prepare();

/** Account-machine-only; rejection consumes the draft without touching its base. */
export const discardAccountCollectionOverlay = <K extends AccountStateMapKey, V>(
  owner: AccountCollectionOverlayOwner<K, V>,
): void => requireOwner(owner).discard();

/** Draft collections own their own lifecycle and must stay opaque to object CoW. */
export const isAccountCollectionDraft = (
  value: unknown,
): value is AccountCollectionDraft<AccountStateMapKey, unknown> =>
  typeof value === 'object' && value !== null && ACCOUNT_COLLECTION_DRAFT in value;
