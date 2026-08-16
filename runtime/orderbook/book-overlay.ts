import type { BookOrderState, BookState, Side } from './core';
import type { BookPricePageTree } from './pages/page';
import { PersistentRadixValueMap } from '../protocol/state/persistent-radix-value-map';

type MutableBookState = { -readonly [Key in keyof BookState]: BookState[Key] };
const sealOrder = (order: BookOrderState): BookOrderState => Object.freeze({ ...order });

const BOOK_ORDER_KEY_ENCODER = new TextEncoder();
const encodeBookOrderLocatorKey = (key: string): Uint8Array => {
  const raw = BOOK_ORDER_KEY_ENCODER.encode(key);
  if (raw.length === 0 || raw.length > 0xffff) throw new Error(`BOOK_ORDER_LOCATOR_KEY_BYTES:${raw.length}`);
  const encoded = new Uint8Array(raw.length + 2);
  encoded[0] = raw.length >>> 8;
  encoded[1] = raw.length;
  encoded.set(raw, 2);
  return encoded;
};
const bookOrderMapOptions = {
  radix: 16,
  sealKey: (key: string): string => key,
  keyBytes: encodeBookOrderLocatorKey,
  valueHash: (): string => { throw new Error('BOOK_ORDER_LOCATOR_HASH_FORBIDDEN'); },
  sealValue: sealOrder,
  commitment: false,
} as const;

type PublishedBookOrderMap = PersistentRadixValueMap<string, BookOrderState>;

/** RAM-only order locator overlay. Its root is never persisted or committed. */
export class BookBranchMap<Value> extends Map<string, Value> {
  readonly #base: ReadonlyMap<string, Value>;
  readonly #changes = new Map<string, Value>();
  readonly #deleted = new Set<string>();

  constructor(base: ReadonlyMap<string, Value>) {
    super();
    this.#base = base;
  }
  override get size(): number {
    let size = this.#base.size - this.#deleted.size;
    for (const key of this.#changes.keys()) if (!this.#base.has(key)) size += 1;
    return size;
  }
  override get(key: string): Value | undefined {
    return this.#deleted.has(key) ? undefined : this.#changes.get(key) ?? this.#base.get(key);
  }
  override has(key: string): boolean {
    return !this.#deleted.has(key) && (this.#changes.has(key) || this.#base.has(key));
  }
  override set(key: string, value: Value): this {
    this.#deleted.delete(key);
    this.#changes.set(key, value);
    return this;
  }
  override delete(key: string): boolean {
    const existed = this.has(key);
    this.#changes.delete(key);
    if (this.#base.has(key)) this.#deleted.add(key);
    return existed;
  }
  override clear(): void {
    this.#changes.clear();
    for (const key of this.#base.keys()) this.#deleted.add(key);
  }
  override *keys(): MapIterator<string> {
    for (const key of this.#base.keys()) if (!this.#deleted.has(key)) yield key;
    for (const key of this.#changes.keys()) if (!this.#base.has(key)) yield key;
  }
  override *entries(): MapIterator<[string, Value]> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== undefined) yield [key, value];
    }
  }
  override *values(): MapIterator<Value> { for (const [, value] of this.entries()) yield value; }
  override [Symbol.iterator](): MapIterator<[string, Value]> { return this.entries(); }
  override forEach(
    callback: (value: Value, key: string, map: Map<string, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  hasOwnValue(key: string): boolean { return this.#changes.has(key); }
  changedEntries(): MapIterator<[string, Value]> { return this.#changes.entries(); }
  deletedKeys(): SetIterator<string> { return this.#deleted.values(); }
  commitInto(target: BookBranchMap<Value>): void {
    for (const key of this.#deleted) target.delete(key);
    for (const [key, value] of this.#changes) target.set(key, value);
  }
  deletedKeysView(): Iterable<string> { return this.#deleted; }
}

class BookOverlayState implements BookState {
  readonly base: BookState;
  params: BookState['params'];
  orders: Map<string, BookOrderState>;
  bidPages: BookPricePageTree;
  askPages: BookPricePageTree;
  nextSeq: number;
  tradeCount: number;
  tradeQtySum: bigint;
  lastTradePriceTicks: bigint;
  lastAcceptedUsdAskPriceTicks: bigint;
  eventHash: bigint;
  commitmentHash?: string;
  status: 'active' | 'sealed' = 'active';
  constructor(base: BookState) {
    this.base = base;
    this.params = base.params;
    this.orders = new BookBranchMap(base.orders);
    this.bidPages = base.bidPages;
    this.askPages = base.askPages;
    this.nextSeq = base.nextSeq;
    this.tradeCount = base.tradeCount;
    this.tradeQtySum = base.tradeQtySum;
    this.lastTradePriceTicks = base.lastTradePriceTicks;
    this.lastAcceptedUsdAskPriceTicks = base.lastAcceptedUsdAskPriceTicks;
    this.eventHash = base.eventHash;
    if (base.commitmentHash !== undefined) this.commitmentHash = base.commitmentHash;
  }
}

export const createPersistentBookOrderMap = (): ReadonlyMap<string, BookOrderState> =>
  PersistentRadixValueMap.empty(bookOrderMapOptions);
export const buildPersistentBookOrderMap = (
  entries: Iterable<readonly [string, BookOrderState]>,
): ReadonlyMap<string, BookOrderState> => PersistentRadixValueMap.fromMap(entries, bookOrderMapOptions);
export const forkBookState = (base: BookState): BookState => new BookOverlayState(base);
const requireOverlay = (state: BookState): BookOverlayState => {
  if (!(state instanceof BookOverlayState) || state.status !== 'active') throw new Error('BOOK_OVERLAY_REQUIRED');
  return state;
};
export const getWritableBookOrder = (state: BookState, orderId: string): BookOrderState | undefined => {
  const overlay = requireOverlay(state);
  const orders = overlay.orders as BookBranchMap<BookOrderState>;
  const order = orders.get(orderId);
  if (!order || orders.hasOwnValue(orderId)) return order;
  const writable = { ...order };
  orders.set(orderId, writable);
  return writable;
};
export const setBookPageTree = (state: BookState, side: Side, tree: BookPricePageTree): void => {
  const overlay = requireOverlay(state);
  if (side === 0) overlay.bidPages = tree;
  else overlay.askPages = tree;
};
const copyScalars = (target: MutableBookState, source: BookState): void => {
  target.bidPages = source.bidPages;
  target.askPages = source.askPages;
  target.nextSeq = source.nextSeq;
  target.tradeCount = source.tradeCount;
  target.tradeQtySum = source.tradeQtySum;
  target.lastTradePriceTicks = source.lastTradePriceTicks;
  target.lastAcceptedUsdAskPriceTicks = source.lastAcceptedUsdAskPriceTicks;
  target.eventHash = source.eventHash;
  if (source.commitmentHash === undefined) delete target.commitmentHash;
  else target.commitmentHash = source.commitmentHash;
};
const sealOverlay = (overlay: BookOverlayState): BookState => {
  const changes = overlay.orders as BookBranchMap<BookOrderState>;
  let orders: PublishedBookOrderMap = overlay.base.orders instanceof PersistentRadixValueMap
    ? overlay.base.orders
    : PersistentRadixValueMap.fromMap(overlay.base.orders, bookOrderMapOptions);
  for (const key of changes.deletedKeysView()) orders = orders.removed(key);
  for (const [key, value] of changes.changedEntries()) orders = orders.updated(key, value);
  const sealed: BookState = {
    params: Object.freeze({ ...overlay.params }),
    orders,
    bidPages: overlay.bidPages,
    askPages: overlay.askPages,
    nextSeq: overlay.nextSeq,
    tradeCount: overlay.tradeCount,
    tradeQtySum: overlay.tradeQtySum,
    lastTradePriceTicks: overlay.lastTradePriceTicks,
    lastAcceptedUsdAskPriceTicks: overlay.lastAcceptedUsdAskPriceTicks,
    eventHash: overlay.eventHash,
  };
  if (overlay.commitmentHash !== undefined) sealed.commitmentHash = overlay.commitmentHash;
  overlay.status = 'sealed';
  return sealed;
};
export const commitBookOverlay = (state: BookState): BookState => {
  const overlay = requireOverlay(state);
  if (!(overlay.base instanceof BookOverlayState) || overlay.base.status !== 'active') return sealOverlay(overlay);
  (overlay.orders as BookBranchMap<BookOrderState>).commitInto(
    overlay.base.orders as BookBranchMap<BookOrderState>,
  );
  copyScalars(overlay.base, overlay);
  overlay.status = 'sealed';
  return overlay.base;
};
export const commitBookOverlayInto = (state: BookState, parent: BookState): BookState => {
  let current = state;
  while (current !== parent) {
    if (!(current instanceof BookOverlayState)) throw new Error('BOOK_OVERLAY_PARENT_MISMATCH');
    const directParent = current.base;
    const next = commitBookOverlay(current);
    if (directParent === parent && next !== parent) return next;
    current = next;
  }
  return parent;
};
export const isBookOverlay = (state: BookState): boolean =>
  state instanceof BookOverlayState && state.status === 'active';
