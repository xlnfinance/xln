/**
 * A frame-local Map overlay. Certified entries remain untouched until commit;
 * only keys read for mutation or explicitly replaced allocate candidate data.
 */
export class EntityCandidateMap<K, V> extends Map<K, V> {
  readonly #base: Map<K, V>;
  readonly #changes = new Map<K, V>();
  readonly #deleted = new Set<K>();
  readonly #cloneValue: (value: V) => V;
  readonly #cloneOnIteration: boolean;

  constructor(
    base: Map<K, V>,
    cloneValue: (value: V) => V,
    cloneOnIteration: boolean,
  ) {
    super();
    // Pure planners may feed one uncommitted candidate into the next frame
    // simulation. Never retain an overlay chain: flatten its visible view into
    // a private Map so later commit cannot reach or mutate an earlier base.
    this.#base = base instanceof EntityCandidateMap
      ? base.snapshot()
      : base;
    this.#cloneValue = cloneValue;
    this.#cloneOnIteration = cloneOnIteration;
  }

  override get size(): number {
    let size = this.#base.size - this.#deleted.size;
    for (const key of this.#changes.keys()) {
      if (!this.#base.has(key)) size += 1;
    }
    return size;
  }

  override has(key: K): boolean {
    return !this.#deleted.has(key) &&
      (this.#changes.has(key) || this.#base.has(key));
  }

  #read(key: K): V | undefined {
    if (this.#deleted.has(key)) return undefined;
    return this.#changes.has(key)
      ? this.#changes.get(key)
      : this.#base.get(key);
  }

  override get(key: K): V | undefined {
    if (this.#deleted.has(key)) return undefined;
    if (this.#changes.has(key)) return this.#changes.get(key);
    const certified = this.#base.get(key);
    if (certified === undefined) return undefined;
    const candidate = this.#cloneValue(certified);
    this.#changes.set(key, candidate);
    return candidate;
  }

  override set(key: K, value: V): this {
    this.#deleted.delete(key);
    this.#changes.set(key, value);
    return this;
  }

  override delete(key: K): boolean {
    const existed = this.has(key);
    this.#changes.delete(key);
    if (this.#base.has(key)) this.#deleted.add(key);
    return existed;
  }

  override clear(): void {
    this.#changes.clear();
    for (const key of this.#base.keys()) this.#deleted.add(key);
  }

  override *keys(): MapIterator<K> {
    for (const key of this.#base.keys()) {
      if (!this.#deleted.has(key)) yield key;
    }
    for (const key of this.#changes.keys()) {
      if (!this.#base.has(key)) yield key;
    }
  }

  override *values(): MapIterator<V> {
    for (const key of this.keys()) {
      const value = this.#cloneOnIteration
        ? this.get(key)
        : this.#read(key);
      if (value !== undefined) yield value;
    }
  }

  override *entries(): MapIterator<[K, V]> {
    for (const key of this.keys()) {
      const value = this.#cloneOnIteration
        ? this.get(key)
        : this.#read(key);
      if (value !== undefined) yield [key, value];
    }
  }

  /**
   * Read the visible overlay without claiming base values for mutation.
   *
   * Subclasses may expose this only to pure projections. Normal iteration
   * deliberately keeps clone-on-read semantics for reducers that mutate
   * nested values while iterating.
   */
  protected *visibleEntriesWithoutCloning(): MapIterator<[K, V]> {
    for (const key of this.keys()) {
      const value = this.#read(key);
      if (value !== undefined) yield [key, value];
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  override forEach(
    callback: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) {
      callback.call(thisArg, value, key, this);
    }
  }

  snapshot(): Map<K, V> {
    return new Map(this.entries());
  }

  commit(): Map<K, V> {
    for (const key of this.#deleted) this.#base.delete(key);
    for (const [key, value] of this.#changes) this.#base.set(key, value);
    return this.#base;
  }

  stats(): Readonly<{ base: number; changed: number; deleted: number }> {
    return {
      base: this.#base.size,
      changed: this.#changes.size,
      deleted: this.#deleted.size,
    };
  }

  /** Keys whose visible value can no longer use a certified-base commitment. */
  dirtyKeys(): ReadonlySet<K> {
    return new Set([...this.#changes.keys(), ...this.#deleted]);
  }
}

/**
 * Account iteration is mutation-capable by convention, so it clones values.
 * This protects older reducers that mutate nested Maps inside `for..of`.
 */
export class EntityAccountCandidateMap
  extends EntityCandidateMap<string, AccountReplica> {
  constructor(base: Map<string, AccountReplica>) {
    super(base, cloneAccountReplica, true);
  }

  /** Pure commitment projection that does not claim untouched values for mutation. */
  entriesForConsensusCommitment(): MapIterator<[string, AccountReplica]> {
    return this.visibleEntriesWithoutCloning();
  }
}

export const createEntityAccountCandidateMap = (
  accounts: Map<string, AccountReplica>,
): EntityAccountCandidateMap => new EntityAccountCandidateMap(accounts);

export const snapshotEntityAccountMap = (
  accounts: Map<string, AccountReplica>,
): Map<string, AccountReplica> =>
  accounts instanceof EntityAccountCandidateMap ? accounts.snapshot() : accounts;

export const commitEntityAccountCandidate = (
  accounts: Map<string, AccountReplica>,
): Map<string, AccountReplica> =>
  accounts instanceof EntityAccountCandidateMap ? accounts.commit() : accounts;

export const entityAccountCommitmentEntries = (
  accounts: Map<string, AccountReplica>,
): MapIterator<[string, AccountReplica]> =>
  accounts instanceof EntityAccountCandidateMap
    ? accounts.entriesForConsensusCommitment()
    : accounts.entries();

const cloneBook = (book: BookState): BookState =>
  structuredCloneOrThrow(book, 'ENTITY_ORDERBOOK_BOOK_CLONE_FAILED');

const clonePairs = (pairs: string[]): string[] => [...pairs];

const cloneReferral = (
  referral: OrderbookExtState['referrals'] extends Map<string, infer Value>
    ? Value
    : never,
) => ({ ...referral });

export const createEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: new EntityCandidateMap(source.books, cloneBook, false),
  orderPairs: new EntityCandidateMap(source.orderPairs, clonePairs, false),
  referrals: new EntityCandidateMap(source.referrals, cloneReferral, false),
  hubProfile: structuredCloneOrThrow(source.hubProfile, 'ENTITY_ORDERBOOK_PROFILE_CLONE_FAILED'),
});

export const snapshotEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: source.books instanceof EntityCandidateMap ? source.books.snapshot() : source.books,
  orderPairs: source.orderPairs instanceof EntityCandidateMap
    ? source.orderPairs.snapshot()
    : source.orderPairs,
  referrals: source.referrals instanceof EntityCandidateMap
    ? source.referrals.snapshot()
    : source.referrals,
  hubProfile: source.hubProfile,
});

export const commitEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: source.books instanceof EntityCandidateMap ? source.books.commit() : source.books,
  orderPairs: source.orderPairs instanceof EntityCandidateMap
    ? source.orderPairs.commit()
    : source.orderPairs,
  referrals: source.referrals instanceof EntityCandidateMap
    ? source.referrals.commit()
    : source.referrals,
  hubProfile: source.hubProfile,
});
import { cloneAccountReplica } from '../../account/state/state-clone';
import type { AccountReplica } from '../../types/account';
import type { BookState, OrderbookExtState } from '../../orderbook';
import { structuredCloneOrThrow } from '../../protocol/structured-clone';
