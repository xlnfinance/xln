type CandidateMapRadix = 16 | 256;

type RadixLeaf<K, V> = Readonly<{
  key: K;
  token: string;
  value: V;
  order: number;
}>;

type RadixNode<K, V> = Readonly<{
  leaf?: RadixLeaf<K, V>;
  children: ReadonlyMap<number, RadixNode<K, V>>;
}>;

const EMPTY_CHILDREN: ReadonlyMap<number, RadixNode<never, never>> = new Map<
  number,
  RadixNode<never, never>
>();

const candidateKeyToken = (key: unknown): string => {
  if (typeof key === 'string') return `s:${key}`;
  if (typeof key === 'number' && Number.isSafeInteger(key)) return `n:${key}`;
  if (typeof key === 'bigint') return `b:${key}`;
  throw new Error(`ENTITY_CANDIDATE_MAP_KEY_UNSUPPORTED:${typeof key}`);
};

const candidateKeyPath = (token: string, radix: CandidateMapRadix): readonly number[] => {
  const bytes = new TextEncoder().encode(token);
  if (radix === 256) return [...bytes];
  const path: number[] = [];
  for (const byte of bytes) path.push(byte >>> 4, byte & 0x0f);
  return path;
};

const radixGet = <K, V>(
  root: RadixNode<K, V> | undefined,
  token: string,
  radix: CandidateMapRadix,
): RadixLeaf<K, V> | undefined => {
  let node = root;
  for (const slot of candidateKeyPath(token, radix)) {
    node = node?.children.get(slot);
    if (!node) return undefined;
  }
  if (!node) return undefined;
  return node.leaf?.token === token ? node.leaf : undefined;
};

const radixSet = <K, V>(
  node: RadixNode<K, V> | undefined,
  path: readonly number[],
  depth: number,
  leaf: RadixLeaf<K, V>,
): RadixNode<K, V> => {
  if (depth === path.length) {
    return { ...(node?.leaf ? {} : {}), leaf, children: node?.children ?? EMPTY_CHILDREN };
  }
  const slot = path[depth];
  if (slot === undefined) throw new Error('ENTITY_CANDIDATE_RADIX_PATH_INVALID');
  const children = new Map(node?.children ?? EMPTY_CHILDREN);
  children.set(slot, radixSet(children.get(slot), path, depth + 1, leaf));
  return { ...(node?.leaf ? { leaf: node.leaf } : {}), children };
};

const radixDelete = <K, V>(
  node: RadixNode<K, V> | undefined,
  path: readonly number[],
  depth: number,
): RadixNode<K, V> | undefined => {
  if (!node) return undefined;
  if (depth === path.length) {
    return node.children.size === 0 ? undefined : { children: node.children };
  }
  const slot = path[depth];
  if (slot === undefined) throw new Error('ENTITY_CANDIDATE_RADIX_PATH_INVALID');
  const child = radixDelete(node.children.get(slot), path, depth + 1);
  if (child === node.children.get(slot)) return node;
  const children = new Map(node.children);
  if (child) children.set(slot, child);
  else children.delete(slot);
  if (children.size === 0 && !node.leaf) return undefined;
  return { ...(node.leaf ? { leaf: node.leaf } : {}), children };
};

const collectRadixLeaves = <K, V>(
  node: RadixNode<K, V> | undefined,
  leaves: RadixLeaf<K, V>[],
): void => {
  if (!node) return;
  if (node.leaf) leaves.push(node.leaf);
  for (const child of node.children.values()) collectRadixLeaves(child, leaves);
};

/**
 * Frame-local persistent radix overlay.
 *
 * Certified roots are immutable. A candidate stores only dirty keys and commit
 * path-copies their radix ancestry; rejection drops the candidate. Pure reads
 * never allocate or claim values for mutation.
 */
export class EntityCandidateMap<K, V> implements Map<K, V> {
  readonly [Symbol.toStringTag] = 'Map';
  #root: RadixNode<K, V> | undefined;
  readonly #changes = new Map<K, V>();
  readonly #deleted = new Set<K>();
  readonly #changeOrders = new Map<K, number>();
  readonly #forkValue: (value: V) => V;
  readonly #radix: CandidateMapRadix;
  #baseSize: number;
  #nextOrder: number;
  #cleared = false;
  #sealed = false;

  constructor(
    base: Map<K, V>,
    forkValue: (value: V) => V,
    _cloneOnIteration = false,
    radix: CandidateMapRadix = 16,
  ) {
    this.#forkValue = forkValue;
    this.#radix = base instanceof EntityCandidateMap ? base.#radix : radix;
    if (base instanceof EntityCandidateMap) {
      const visible = base.#visibleRoot();
      this.#root = visible.root;
      this.#baseSize = visible.size;
      this.#nextOrder = visible.nextOrder;
      return;
    }
    let root: RadixNode<K, V> | undefined;
    let order = 0;
    for (const [key, value] of base) {
      const token = candidateKeyToken(key);
      root = radixSet(root, candidateKeyPath(token, this.#radix), 0, {
        key,
        token,
        value,
        order,
      });
      order += 1;
    }
    this.#root = root;
    this.#baseSize = base.size;
    this.#nextOrder = order;
  }

  get size(): number {
    if (this.#cleared) return this.#changes.size;
    let size = this.#baseSize - this.#deleted.size;
    for (const key of this.#changes.keys()) {
      if (!radixGet(this.#root, candidateKeyToken(key), this.#radix)) size += 1;
    }
    return size;
  }

  has(key: K): boolean {
    return !this.#deleted.has(key) &&
      (this.#changes.has(key) || (!this.#cleared && radixGet(
        this.#root,
        candidateKeyToken(key),
        this.#radix,
      ) !== undefined));
  }

  get(key: K): V | undefined {
    if (this.#deleted.has(key)) return undefined;
    if (this.#changes.has(key)) return this.#changes.get(key);
    if (this.#cleared) return undefined;
    return radixGet(this.#root, candidateKeyToken(key), this.#radix)?.value;
  }

  getForWrite(key: K): V | undefined {
    if (this.#sealed) throw new Error('ENTITY_CANDIDATE_MAP_SEALED');
    if (this.#deleted.has(key)) return undefined;
    if (this.#changes.has(key)) {
      const changed = this.#changes.get(key);
      if (changed === undefined) return undefined;
      if (typeof changed === 'object' && changed !== null && Object.isFrozen(changed)) {
        const candidate = this.#forkValue(changed);
        this.#changes.set(key, candidate);
        return candidate;
      }
      return changed;
    }
    if (this.#cleared) return undefined;
    const certified = radixGet(this.#root, candidateKeyToken(key), this.#radix)?.value;
    if (certified === undefined) return undefined;
    const candidate = this.#forkValue(certified);
    this.#changes.set(key, candidate);
    return candidate;
  }

  set(key: K, value: V): this {
    if (this.#sealed) throw new Error('ENTITY_CANDIDATE_MAP_SEALED');
    this.#deleted.delete(key);
    if (!this.has(key) && !this.#changeOrders.has(key)) {
      this.#changeOrders.set(key, this.#nextOrder);
      this.#nextOrder += 1;
    }
    this.#changes.set(key, value);
    return this;
  }
  getOrInsert(key: K, defaultValue: V): V {
    const current = this.get(key);
    if (current !== undefined || this.has(key)) return current as V;
    this.set(key, defaultValue);
    return defaultValue;
  }
  getOrInsertComputed(key: K, callback: (key: K) => V): V {
    const current = this.get(key);
    if (current !== undefined || this.has(key)) return current as V;
    const value = callback(key);
    this.set(key, value);
    return value;
  }

  delete(key: K): boolean {
    if (this.#sealed) throw new Error('ENTITY_CANDIDATE_MAP_SEALED');
    const existed = this.has(key);
    this.#changes.delete(key);
    this.#changeOrders.delete(key);
    if (!this.#cleared && radixGet(this.#root, candidateKeyToken(key), this.#radix)) {
      this.#deleted.add(key);
    }
    return existed;
  }

  clear(): void {
    if (this.#sealed) throw new Error('ENTITY_CANDIDATE_MAP_SEALED');
    this.#changes.clear();
    this.#deleted.clear();
    this.#changeOrders.clear();
    this.#cleared = true;
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  *entries(): MapIterator<[K, V]> {
    const leaves: RadixLeaf<K, V>[] = [];
    if (!this.#cleared) collectRadixLeaves(this.#root, leaves);
    const visible: Array<RadixLeaf<K, V>> = [];
    for (const leaf of leaves) {
      if (this.#deleted.has(leaf.key)) continue;
      visible.push(this.#changes.has(leaf.key)
        ? { ...leaf, value: this.#changes.get(leaf.key) as V }
        : leaf);
    }
    for (const [key, value] of this.#changes) {
      if (!this.#cleared && radixGet(this.#root, candidateKeyToken(key), this.#radix)) continue;
      visible.push({
        key,
        token: candidateKeyToken(key),
        value,
        order: this.#changeOrders.get(key) ?? Number.MAX_SAFE_INTEGER,
      });
    }
    visible.sort((left, right) => left.order - right.order);
    for (const leaf of visible) yield [leaf.key, leaf.value];
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(
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
    if (this.#sealed) return this;
    const visible = this.#visibleRoot();
    this.#root = visible.root;
    this.#baseSize = visible.size;
    this.#nextOrder = visible.nextOrder;
    this.#changes.clear();
    this.#deleted.clear();
    this.#changeOrders.clear();
    this.#cleared = false;
    this.#sealed = true;
    return this;
  }

  stats(): Readonly<{ base: number; changed: number; deleted: number }> {
    return {
      base: this.#baseSize,
      changed: this.#changes.size,
      deleted: this.#deleted.size,
    };
  }

  /** True when no write reached this candidate: its visible content is the base content. */
  isClean(): boolean {
    return this.#changes.size === 0 && this.#deleted.size === 0 && !this.#cleared;
  }

  isSealed(): boolean {
    return this.#sealed;
  }

  /** Keys whose visible value can no longer use a certified-base commitment. */
  dirtyKeys(): ReadonlySet<K> {
    return new Set([...this.#changes.keys(), ...this.#deleted]);
  }

  #visibleRoot(): Readonly<{
    root: RadixNode<K, V> | undefined;
    size: number;
    nextOrder: number;
  }> {
    let root = this.#cleared ? undefined : this.#root;
    let size = this.#cleared ? 0 : this.#baseSize;
    for (const key of this.#deleted) {
      const token = candidateKeyToken(key);
      if (radixGet(root, token, this.#radix)) size -= 1;
      root = radixDelete(root, candidateKeyPath(token, this.#radix), 0);
    }
    for (const [key, value] of this.#changes) {
      const token = candidateKeyToken(key);
      const existing = radixGet(root, token, this.#radix);
      if (!existing) size += 1;
      root = radixSet(root, candidateKeyPath(token, this.#radix), 0, {
        key,
        token,
        value,
        order: existing?.order ?? this.#changeOrders.get(key) ?? this.#nextOrder,
      });
    }
    return { root, size, nextOrder: this.#nextOrder };
  }
}

export const getEntityCandidateValueForWrite = <K, V>(
  map: Map<K, V>,
  key: K,
): V | undefined => map instanceof EntityCandidateMap
  ? map.getForWrite(key)
  : map.get(key);

import {
  EntityAccountCandidateMap,
  type PersistentEntityAccountMap,
} from './persistent-account-map';

/**
 * Account values are immutable committed views. getForWrite() owns a bounded
 * replica shell; Account transitions begin their own Patricia overlays and
 * publish prepared replacements into that shell.
 */
export const createEntityAccountCandidateMap = (
  accounts: PersistentEntityAccountMap,
): EntityAccountCandidateMap => new EntityAccountCandidateMap(accounts);

export const commitEntityAccountCandidate = (
  accounts: PersistentEntityAccountMap | EntityAccountCandidateMap,
): PersistentEntityAccountMap =>
  accounts instanceof EntityAccountCandidateMap ? accounts.sealCandidate() : accounts;

const forkBook = (book: BookState): BookState => forkBookState(book);

const clonePairs = (pairs: string[]): string[] => [...pairs];
const clonePairDimensions = (dimensions: OrderbookExtState['pairDimensions'] extends Map<string, infer Value>
  ? Value
  : never) => ({ ...dimensions });

const cloneReferral = (
  referral: OrderbookExtState['referrals'] extends Map<string, infer Value>
    ? Value
    : never,
) => ({ ...referral });

const forkHubProfile = (source: OrderbookExtState['hubProfile']): OrderbookExtState['hubProfile'] => ({
  ...source,
  spreadDistribution: { ...source.spreadDistribution },
  supportedPairs: [...source.supportedPairs],
});

/**
 * Symbol-keyed so canonical/binary encoders and structuredClone never see it:
 * the committed base an orderbook candidate was forked from. A candidate that
 * received no write commits back to that exact base object, so the Entity
 * State-root memo (reference shell) stays warm across mempool-only inputs.
 */
const ORDERBOOK_CANDIDATE_BASE = Symbol('orderbookCandidateBase');
type OrderbookCandidate = OrderbookExtState & { [ORDERBOOK_CANDIDATE_BASE]?: OrderbookExtState };

export const createEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => ({
  books: new EntityCandidateMap(source.books, forkBook, false),
  orderPairs: new EntityCandidateMap(source.orderPairs, clonePairs, false),
  pairDimensions: new EntityCandidateMap(source.pairDimensions, clonePairDimensions, false),
  referrals: new EntityCandidateMap(source.referrals, cloneReferral, false),
  hubProfile: forkHubProfile(source.hubProfile),
  [ORDERBOOK_CANDIDATE_BASE]: source,
} as OrderbookCandidate);

const sameHubProfile = (left: HubProfile, right: HubProfile): boolean =>
  left.entityId === right.entityId &&
  left.name === right.name &&
  left.referenceTokenId === right.referenceTokenId &&
  left.usdQuoteAuthorityEntityId === right.usdQuoteAuthorityEntityId &&
  left.minTradeSize === right.minTradeSize &&
  left.supportedPairs.length === right.supportedPairs.length &&
  left.supportedPairs.every((pair, index) => pair === right.supportedPairs[index]) &&
  Object.keys(left.spreadDistribution).length === Object.keys(right.spreadDistribution).length &&
  Object.entries(left.spreadDistribution).every(
    ([key, value]) => right.spreadDistribution[key as keyof SpreadDistribution] === value,
  );

const isCleanCandidateMap = (map: Map<unknown, unknown>): boolean =>
  map instanceof EntityCandidateMap && map.isClean();

const commitBookTransition = (book: BookState): BookState => {
  let committed = book;
  while (isBookOverlay(committed)) committed = commitBookOverlay(committed);
  return committed;
};

const commitOrderbookBooks = (
  books: Map<string, BookState>,
): Map<string, BookState> => {
  if (!(books instanceof EntityCandidateMap)) return books;
  for (const pairId of books.dirtyKeys()) {
    const book = books.get(pairId);
    if (book) books.set(pairId, commitBookTransition(book));
  }
  return books.commit();
};

export const commitEntityOrderbookCandidate = (
  source: OrderbookExtState,
): OrderbookExtState => {
  // Already committed (plain Maps or sealed candidates): idempotent.
  if (!(source.books instanceof EntityCandidateMap) || source.books.isSealed()) return source;
  const base = (source as OrderbookCandidate)[ORDERBOOK_CANDIDATE_BASE];
  if (
    base &&
    isCleanCandidateMap(source.books) &&
    isCleanCandidateMap(source.orderPairs) &&
    isCleanCandidateMap(source.pairDimensions) &&
    isCleanCandidateMap(source.referrals) &&
    sameHubProfile(source.hubProfile, base.hubProfile)
  ) {
    return base;
  }
  return {
    books: commitOrderbookBooks(source.books),
    orderPairs: source.orderPairs instanceof EntityCandidateMap
      ? source.orderPairs.commit()
      : source.orderPairs,
    pairDimensions: source.pairDimensions instanceof EntityCandidateMap
      ? source.pairDimensions.commit()
      : source.pairDimensions,
    referrals: source.referrals instanceof EntityCandidateMap
      ? source.referrals.commit()
      : source.referrals,
    hubProfile: source.hubProfile,
  };
};
export { EntityAccountCandidateMap } from './persistent-account-map';
import {
  commitBookOverlay,
  forkBookState,
  isBookOverlay,
  type BookState,
  type HubProfile,
  type OrderbookExtState,
  type SpreadDistribution,
} from '../../orderbook';
