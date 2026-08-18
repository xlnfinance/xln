/** Pure price-page limit order book. Canonical liquidity lives only in two radix trees. */
import { invalidateBookCommitment } from './commitment';
import {
  commitBookOverlay,
  createPersistentBookOrderMap,
  forkBookState,
  getWritableBookOrder,
  setBookPageTree,
} from './book-overlay';
import {
  appendBookPricePageOrder,
  createBookPricePageTree,
  getBestBookPricePage,
  MAX_BOOK_PAGE_QTY_LOTS,
  reduceBookPricePageOrder,
  removeBookPricePageOrder,
  type BookPricePage,
  type BookPricePageTree,
} from './pages/page';
import { encodeBookPricePrefix, type BookPricePageKey } from './pages/key';

export type Side = 0 | 1;
type TIF = 0 | 1 | 2;

export class OrderbookCapacityError extends Error {
  constructor() { super('Out of order slots'); this.name = 'OrderbookCapacityError'; }
}

export type OrderCmd =
  | { kind: 0; ownerId: string; orderId: string; side: Side; tif: TIF; postOnly: boolean; priceTicks: bigint; qtyLots: bigint }
  | { kind: 1; ownerId: string; orderId: string }
  | { kind: 2; ownerId: string; orderId: string; newPriceTicks: bigint | null; qtyDeltaLots: bigint };

export type BookEvent =
  | { type: 'ACK'; orderId: string; ownerId: string }
  | { type: 'REJECT'; orderId: string; ownerId: string; reason: string; blockingOrderId?: string }
  | { type: 'TRADE'; price: bigint; qty: bigint; makerOwnerId: string; takerOwnerId: string; makerOrderId: string; takerOrderId: string; makerQtyBefore: bigint; takerQtyTotal: bigint }
  | { type: 'REDUCED'; orderId: string; ownerId: string; delta: bigint; remain: bigint }
  | { type: 'CANCELED'; orderId: string; ownerId: string };

export interface BookParams { bucketWidthTicks: bigint; maxOrders: number; stpPolicy: 0 | 1 }

/** Derived RAM locator rebuilt from pages on hydration; never persisted or committed. */
export interface BookOrderState {
  orderId: string;
  ownerId: string;
  side: Side;
  priceTicks: bigint;
  qtyLots: bigint;
  seq: number;
  pageSequence: number;
  pageSlot: number;
}

export interface BookSideLevel {
  priceTicks: bigint;
  qtyLots: bigint;
  ownerIds: string[];
  orderIds: string[];
}

export interface BookState {
  readonly params: BookParams;
  readonly orders: ReadonlyMap<string, BookOrderState>;
  readonly bidPages: BookPricePageTree;
  readonly askPages: BookPricePageTree;
  readonly nextSeq: number;
  readonly tradeCount: number;
  readonly tradeQtySum: bigint;
  readonly lastTradePriceTicks: bigint;
  readonly lastAcceptedUsdAskPriceTicks: bigint;
  readonly eventHash: bigint;
  commitmentHash?: string;
}

export interface ApplyCommandOptions {
  suspendedOrderIds?: ReadonlySet<string>;
  /** Lazy external-authority verdict for a maker actually consulted by the price walk. */
  makerDisposition?: (maker: Readonly<BookOrderState>) => 'eligible' | 'suspended' | 'cancel';
  executionPriceTicksForMatch?: (maker: bigint, taker: bigint, side: Side) => bigint;
  executionQtyMultipleAtPrice?: (priceTicks: bigint) => bigint;
}

const cacheMakerDisposition = (options: ApplyCommandOptions): ApplyCommandOptions => {
  const classify = options.makerDisposition;
  if (!classify) return options;
  const verdicts = new Map<string, 'eligible' | 'suspended' | 'cancel'>();
  return {
    ...options,
    makerDisposition: maker => {
      const cached = verdicts.get(maker.orderId);
      if (cached) return cached;
      const verdict = classify(maker);
      verdicts.set(maker.orderId, verdict);
      return verdict;
    },
  };
};

export const MAX_ORDERBOOK_QTY_LOTS = MAX_BOOK_PAGE_QTY_LOTS;
const PRIME = 0x1_0000_01n;
type MutableBookState = { -readonly [Key in keyof BookState]: BookState[Key] } & {
  orders: Map<string, BookOrderState>;
};
type PageView = readonly [BookPricePageKey, BookPricePage];

const sideTree = (state: BookState, side: Side): BookPricePageTree =>
  side === 0 ? state.bidPages : state.askPages;

const pageOrder = (
  side: Side,
  key: BookPricePageKey,
  page: BookPricePage,
  slot: number,
): BookOrderState | null => {
  const entry = page.slots[slot];
  return entry ? {
    ...entry,
    side,
    priceTicks: key.priceTicks,
    pageSequence: key.pageSequence,
    pageSlot: slot,
  } : null;
};

const pagesByDescendingPrice = function* (tree: BookPricePageTree): Generator<PageView> {
  let emittedPrice: bigint | undefined;
  for (const [key] of tree.reverseEntries()) {
    if (key.priceTicks === emittedPrice) continue;
    emittedPrice = key.priceTicks;
    yield* tree.entriesWithPrefix(encodeBookPricePrefix(key.priceTicks));
  }
};

/** Price priority is descending for bids; page sequence remains FIFO ascending. */
function* orderedPages(state: BookState, side: Side): Generator<PageView> {
  const tree = sideTree(state, side);
  if (side === 1) yield* tree.entries();
  else yield* pagesByDescendingPrice(tree);
}

function* pageOrders(side: Side, key: BookPricePageKey, page: BookPricePage): Generator<BookOrderState> {
  for (let slot = page.headSlot; slot < page.nextSlot; slot += 1) {
    const order = pageOrder(side, key, page, slot);
    if (order) yield order;
  }
}

const findBestOrder = (
  state: BookState,
  side: Side,
  options: Pick<ApplyCommandOptions, 'suspendedOrderIds' | 'makerDisposition'>,
): BookOrderState | null => {
  if (!options.suspendedOrderIds && !options.makerDisposition) {
    const best = getBestBookPricePage(sideTree(state, side), side === 0 ? 'highest' : 'lowest');
    if (!best) return null;
    for (const order of pageOrders(side, best[0], best[1])) return order;
    throw new Error('BOOK_PAGE_EMPTY_BEST');
  }
  for (const [key, page] of orderedPages(state, side)) {
    for (const order of pageOrders(side, key, page)) {
      if (options.suspendedOrderIds?.has(order.orderId)) continue;
      if ((options.makerDisposition?.(order) ?? 'eligible') === 'eligible') return order;
    }
  }
  return null;
};

const crosses = (side: Side, taker: bigint, maker: bigint): boolean =>
  side === 0 ? maker <= taker : maker >= taker;

const bumpHash = (state: MutableBookState, tag: number, a: number | bigint, b: number | bigint): void => {
  const a32 = Number((typeof a === 'bigint' ? a : BigInt(a)) & 0xffff_ffffn);
  const b32 = Number((typeof b === 'bigint' ? b : BigInt(b)) & 0xffff_ffffn);
  state.eventHash = (state.eventHash * PRIME + BigInt((tag * 2_654_435_761 >>> 0) ^ a32 ^ (b32 << 7))) & 0x1f_ffff_ffff_ffffn;
  invalidateBookCommitment(state);
};

const addOrder = (state: MutableBookState, input: Omit<BookOrderState, 'pageSequence' | 'pageSlot'>): void => {
  const appended = appendBookPricePageOrder(sideTree(state, input.side), input.priceTicks, {
    orderId: input.orderId,
    ownerId: input.ownerId,
    qtyLots: input.qtyLots,
    seq: input.seq,
  });
  setBookPageTree(state, input.side, appended.tree);
  state.orders.set(input.orderId, {
    ...input,
    pageSequence: appended.location.key.pageSequence,
    pageSlot: appended.location.slot,
  });
  invalidateBookCommitment(state);
};

const removeOrder = (state: MutableBookState, orderId: string): BookOrderState | null => {
  const order = state.orders.get(orderId);
  if (!order) return null;
  const tree = removeBookPricePageOrder(sideTree(state, order.side), {
    key: { priceTicks: order.priceTicks, pageSequence: order.pageSequence },
    slot: order.pageSlot,
  }, orderId);
  setBookPageTree(state, order.side, tree);
  state.orders.delete(orderId);
  invalidateBookCommitment(state);
  return order;
};

const reduceOrder = (state: MutableBookState, order: BookOrderState, qtyLots: bigint): void => {
  const tree = reduceBookPricePageOrder(sideTree(state, order.side), {
    key: { priceTicks: order.priceTicks, pageSequence: order.pageSequence },
    slot: order.pageSlot,
  }, order.orderId, qtyLots);
  setBookPageTree(state, order.side, tree);
  const writable = getWritableBookOrder(state, order.orderId);
  if (!writable) throw new Error(`BOOK_ORDER_INDEX_MISSING:${order.orderId}`);
  writable.qtyLots = qtyLots;
  invalidateBookCommitment(state);
};

/** Canonical quantity reduction used by committed cross-j ACK progress. */
export const reduceBookOrderQuantity = (
  state: BookState,
  orderId: string,
  nextQtyLots: bigint,
): BookState => {
  const current = state.orders.get(orderId);
  if (!current) throw new Error(`BOOK_ORDER_INDEX_MISSING:${orderId}`);
  if (nextQtyLots <= 0n || nextQtyLots >= current.qtyLots) {
    throw new Error(`BOOK_ORDER_REDUCTION_INVALID:${orderId}`);
  }
  const mutable = forkBookState(state) as MutableBookState;
  reduceOrder(mutable, current, nextQtyLots);
  return mutable;
};

const execution = (
  options: ApplyCommandOptions,
  makerPrice: bigint,
  takerPrice: bigint,
  side: Side,
  candidateQty: bigint,
): Readonly<{ price: bigint; qty: bigint }> => {
  const price = options.executionPriceTicksForMatch?.(makerPrice, takerPrice, side) ?? makerPrice;
  if (price <= 0n) throw new Error('BOOK_EXECUTION_PRICE_INVALID');
  const multiple = options.executionQtyMultipleAtPrice?.(price) ?? 1n;
  if (multiple <= 0n) throw new Error('BOOK_EXECUTION_QTY_MULTIPLE_INVALID');
  return { price, qty: (candidateQty / multiple) * multiple };
};

const publishMatchedPage = (
  state: MutableBookState,
  side: Side,
  key: BookPricePageKey,
  page: BookPricePage,
): void => {
  const tree = page.liveCount === 0
    ? sideTree(state, side).removed(key)
    : sideTree(state, side).updated(key, page);
  setBookPageTree(state, side, tree);
  invalidateBookCommitment(state);
};

const nextLiveSlot = (
  slots: readonly (BookPricePage['slots'][number])[],
  start: number,
): number => {
  let slot = start;
  while (slot < slots.length && slots[slot] === null) slot += 1;
  return slot;
};

const matchPricePages = (
  state: MutableBookState,
  taker: Readonly<{ side: Side; ownerId: string; orderId: string; priceTicks: bigint; qtyLots: bigint }>,
  events: BookEvent[],
  options: ApplyCommandOptions,
): Readonly<{ remaining: bigint; blockingOrderId?: string }> => {
  let remaining = taker.qtyLots;
  const makerSide: Side = taker.side === 0 ? 1 : 0;
  for (const [key, sourcePage] of orderedPages(state, makerSide)) {
    if (remaining <= 0n || !crosses(taker.side, taker.priceTicks, key.priceTicks)) break;
    const slots = [...sourcePage.slots];
    let liveCount = sourcePage.liveCount;
    let totalQtyLots = sourcePage.totalQtyLots;
    let stopAfterPage = false;
    let pageChanged = false;
    for (let slot = sourcePage.headSlot; slot < sourcePage.nextSlot && remaining > 0n; slot += 1) {
      const entry = slots[slot];
      if (!entry) continue;
      const maker = pageOrder(makerSide, key, sourcePage, slot);
      if (!maker) throw new Error('BOOK_PAGE_ORDER_MISSING');
      if (options.suspendedOrderIds?.has(maker.orderId)) continue;
      const disposition = options.makerDisposition?.(maker) ?? 'eligible';
      if (disposition === 'suspended') continue;
      if (disposition === 'cancel') {
        slots[slot] = null;
        liveCount -= 1;
        totalQtyLots -= maker.qtyLots;
        state.orders.delete(maker.orderId);
        bumpHash(state, 5, maker.priceTicks, 0);
        pageChanged = true;
        continue;
      }
      if (maker.ownerId === taker.ownerId && state.params.stpPolicy === 1) {
        if (pageChanged) publishMatchedPage(state, makerSide, key, {
          ...sourcePage, headSlot: liveCount === 0 ? 0 : nextLiveSlot(slots, sourcePage.headSlot),
          liveCount, totalQtyLots, slots,
        });
        events.push({ type: 'REJECT', orderId: taker.orderId, ownerId: taker.ownerId, reason: 'STP cancel taker', blockingOrderId: maker.orderId });
        return { remaining, blockingOrderId: maker.orderId };
      }
      const fill = execution(options, maker.priceTicks, taker.priceTicks, taker.side,
        maker.qtyLots < remaining ? maker.qtyLots : remaining);
      if (fill.qty <= 0n) { stopAfterPage = true; break; }
      state.tradeCount += 1;
      state.tradeQtySum += fill.qty;
      state.lastTradePriceTicks = fill.price;
      bumpHash(state, 3, fill.price, fill.qty);
      events.push({
        type: 'TRADE', price: fill.price, qty: fill.qty,
        makerOwnerId: maker.ownerId, takerOwnerId: taker.ownerId,
        makerOrderId: maker.orderId, takerOrderId: taker.orderId,
        makerQtyBefore: maker.qtyLots, takerQtyTotal: taker.qtyLots,
      });
      remaining -= fill.qty;
      totalQtyLots -= fill.qty;
      pageChanged = true;
      if (fill.qty === maker.qtyLots) {
        slots[slot] = null;
        liveCount -= 1;
        state.orders.delete(maker.orderId);
      } else {
        const nextQty = maker.qtyLots - fill.qty;
        slots[slot] = { ...entry, qtyLots: nextQty };
        const writable = getWritableBookOrder(state, maker.orderId);
        if (!writable) throw new Error(`BOOK_ORDER_INDEX_MISSING:${maker.orderId}`);
        writable.qtyLots = nextQty;
        events.push({ type: 'REDUCED', orderId: maker.orderId, ownerId: maker.ownerId, delta: -fill.qty, remain: nextQty });
        stopAfterPage = true;
        break;
      }
    }
    if (pageChanged) publishMatchedPage(state, makerSide, key, {
        ...sourcePage,
        headSlot: liveCount === 0 ? 0 : nextLiveSlot(slots, sourcePage.headSlot),
        liveCount,
        totalQtyLots,
        slots,
      });
    if (stopAfterPage) break;
  }
  return { remaining };
};

const matchAgainstBook = matchPricePages;

export function createBook(params: BookParams): BookState {
  if (params.bucketWidthTicks <= 0n) throw new Error('bucketWidthTicks must be positive');
  if (!Number.isFinite(params.maxOrders) || params.maxOrders <= 0) throw new Error('maxOrders must be positive');
  if (params.stpPolicy !== 0 && params.stpPolicy !== 1) throw new Error('unsupported stpPolicy');
  return {
    params: { ...params, maxOrders: Math.max(1, Math.floor(params.maxOrders)) },
    orders: createPersistentBookOrderMap(),
    bidPages: createBookPricePageTree(),
    askPages: createBookPricePageTree(),
    nextSeq: 1,
    tradeCount: 0,
    tradeQtySum: 0n,
    lastTradePriceTicks: 0n,
    lastAcceptedUsdAskPriceTicks: 0n,
    eventHash: 0n,
  };
}

export function recordAcceptedUsdAskPrice(state: BookState, priceTicks: bigint): BookState {
  if (priceTicks <= 0n) throw new Error('BOOK_USD_ASK_PRICE_INVALID');
  if (state.lastAcceptedUsdAskPriceTicks === priceTicks) return state;
  const mutable = forkBookState(state) as MutableBookState;
  mutable.lastAcceptedUsdAskPriceTicks = priceTicks;
  bumpHash(mutable, 4, priceTicks, 0);
  return mutable;
}

export function materializeCommittedRemainder(
  state: BookState,
  input: Pick<BookOrderState, 'orderId' | 'ownerId' | 'side' | 'priceTicks' | 'qtyLots'>,
): BookState {
  if (input.qtyLots <= 0n || input.qtyLots > MAX_ORDERBOOK_QTY_LOTS) throw new Error('BOOK_REMAINDER_QTY_INVALID');
  if (input.priceTicks <= 0n) throw new Error('BOOK_REMAINDER_PRICE_INVALID');
  if (state.orders.has(input.orderId)) throw new Error('BOOK_REMAINDER_DUPLICATE');
  if (state.orders.size >= state.params.maxOrders) throw new OrderbookCapacityError();
  const mutable = forkBookState(state) as MutableBookState;
  addOrder(mutable, { ...input, seq: mutable.nextSeq });
  mutable.nextSeq += 1;
  bumpHash(mutable, 1, input.priceTicks, input.qtyLots);
  return mutable;
}

export function applyCommand(
  state: BookState,
  cmd: OrderCmd,
  options: ApplyCommandOptions = {},
): { state: BookState; events: BookEvent[] } {
  if (cmd.kind === 2) return { state: forkBookState(state), events: [{ type: 'REJECT', orderId: cmd.orderId, ownerId: cmd.ownerId, reason: 'replace unsupported' }] };
  const mutable = forkBookState(state) as MutableBookState;
  if (cmd.kind === 1) {
    const existing = mutable.orders.get(cmd.orderId);
    if (!existing) return { state: mutable, events: [{ type: 'REJECT', orderId: cmd.orderId, ownerId: cmd.ownerId, reason: 'not found' }] };
    if (existing.ownerId !== cmd.ownerId) return { state: mutable, events: [{ type: 'REJECT', orderId: cmd.orderId, ownerId: cmd.ownerId, reason: 'not owner' }] };
    removeOrder(mutable, cmd.orderId);
    bumpHash(mutable, 5, existing.priceTicks, 0);
    return { state: mutable, events: [{ type: 'CANCELED', orderId: cmd.orderId, ownerId: cmd.ownerId }] };
  }
  const { ownerId, orderId, side, tif, postOnly, priceTicks, qtyLots } = cmd;
  const commandOptions = cacheMakerDisposition(options);
  if (qtyLots <= 0n || qtyLots > MAX_ORDERBOOK_QTY_LOTS) return { state: mutable, events: [{ type: 'REJECT', orderId, ownerId, reason: 'qty out of range' }] };
  if (priceTicks <= 0n) return { state: mutable, events: [{ type: 'REJECT', orderId, ownerId, reason: 'price must be positive' }] };
  if (mutable.orders.has(orderId)) return { state: mutable, events: [{ type: 'REJECT', orderId, ownerId, reason: 'duplicate orderId' }] };
  const opposite = postOnly
    ? findBestOrder(mutable, side === 0 ? 1 : 0, commandOptions)
    : null;
  if (postOnly && opposite && crosses(side, priceTicks, opposite.priceTicks)) {
    return { state: mutable, events: [{ type: 'REJECT', orderId, ownerId, reason: 'postOnly would cross' }] };
  }
  const events: BookEvent[] = [];
  const matched = matchAgainstBook(
    mutable,
    { side, ownerId, orderId, priceTicks, qtyLots },
    events,
    commandOptions,
  );
  if (tif === 2 && matched.remaining > 0n) {
    return { state: forkBookState(state), events: [{ type: 'REJECT', orderId, ownerId, reason: 'FOK cannot fill entirely' }] };
  }
  if (matched.remaining > 0n && matched.blockingOrderId === undefined && tif === 0) {
    if (mutable.orders.size >= mutable.params.maxOrders) throw new OrderbookCapacityError();
    const multiple = options.executionQtyMultipleAtPrice?.(priceTicks) ?? 1n;
    if (multiple <= 0n) throw new Error('BOOK_EXECUTION_QTY_MULTIPLE_INVALID');
    const resting = (matched.remaining / multiple) * multiple;
    if (resting > 0n) {
      addOrder(mutable, { orderId, ownerId, side, priceTicks, qtyLots: resting, seq: mutable.nextSeq });
      mutable.nextSeq += 1;
      events.push({ type: 'ACK', orderId, ownerId });
      bumpHash(mutable, 1, priceTicks, resting);
    }
  } else if (matched.remaining === qtyLots && events.length === 0) {
    events.push({ type: 'REJECT', orderId, ownerId, reason: 'no fill' });
  }
  return { state: mutable, events };
}

export type ResumeCrossedBookResult = { state: BookState; events: BookEvent[]; takerOrderId: string };
export function resumeCrossedBook(state: BookState, options: ApplyCommandOptions = {}): ResumeCrossedBookResult | null {
  const mutable = forkBookState(state) as MutableBookState;
  const commandOptions = cacheMakerDisposition(options);
  const bid = findBestOrder(mutable, 0, commandOptions);
  const ask = findBestOrder(mutable, 1, commandOptions);
  if (!bid || !ask || bid.priceTicks < ask.priceTicks) return null;
  if (bid.seq === ask.seq) throw new Error(`BOOK_CORRUPTION: crossed top orders share seq ${bid.seq}`);
  const taker = bid.seq > ask.seq ? bid : ask;
  const events: BookEvent[] = [];
  const matched = matchAgainstBook(mutable, taker, events, commandOptions);
  if (matched.blockingOrderId !== undefined) {
    removeOrder(mutable, taker.orderId);
    bumpHash(mutable, 5, taker.priceTicks, 0);
  } else if (matched.remaining === 0n) removeOrder(mutable, taker.orderId);
  else if (matched.remaining < taker.qtyLots) reduceOrder(mutable, taker, matched.remaining);
  if (events.length === 0) return null;
  return { state: mutable, events, takerOrderId: taker.orderId };
}

export const getBestBid = (state: BookState): bigint | null =>
  getBestBookPricePage(state.bidPages, 'highest')?.[0].priceTicks ?? null;
export const getBestAsk = (state: BookState): bigint | null =>
  getBestBookPricePage(state.askPages, 'lowest')?.[0].priceTicks ?? null;
export const getBookOrder = (state: BookState, orderId: string): BookOrderState | null =>
  state.orders.get(orderId) ?? null;
export const getBookOrders = (state: BookState): BookOrderState[] =>
  Array.from(state.orders.values()).sort((left, right) => left.seq - right.seq);

/** Visit only Patricia tails outside the accepted price interval. */
export function* bookOrdersOutsidePriceRange(
  state: BookState,
  minPriceTicks: bigint,
  maxPriceTicks: bigint,
): Generator<BookOrderState> {
  if (minPriceTicks <= 0n || maxPriceTicks < minPriceTicks) {
    throw new Error('BOOK_PRICE_RANGE_INVALID');
  }
  for (const side of [0, 1] as const) {
    const tree = sideTree(state, side);
    for (const [key, page] of tree.entries()) {
      if (key.priceTicks >= minPriceTicks) break;
      yield* pageOrders(side, key, page);
    }
    for (const [key, page] of pagesByDescendingPrice(tree)) {
      if (key.priceTicks <= maxPriceTicks) break;
      yield* pageOrders(side, key, page);
    }
  }
}

/** Bounded transport projection; canonical state remains the full page trees. */
export function projectBookDepth(
  state: BookState,
  maxLevelsPerSide = 5,
  maxOrdersPerLevel = 20,
): BookState {
  const projected = forkBookState(createBook(state.params)) as MutableBookState;
  for (const side of [0, 1] as const) {
    for (const level of getBookSideLevels(state, side, maxLevelsPerSide)) {
      for (const orderId of level.orderIds.slice(0, maxOrdersPerLevel)) {
        const source = state.orders.get(orderId);
        if (!source) throw new Error(`BOOK_VIEW_ORDER_MISSING:${orderId}`);
        addOrder(projected, {
          orderId: source.orderId,
          ownerId: source.ownerId,
          side: source.side,
          priceTicks: source.priceTicks,
          qtyLots: source.qtyLots,
          seq: source.seq,
        });
      }
    }
  }
  projected.nextSeq = state.nextSeq;
  projected.tradeCount = state.tradeCount;
  projected.tradeQtySum = state.tradeQtySum;
  projected.lastTradePriceTicks = state.lastTradePriceTicks;
  projected.lastAcceptedUsdAskPriceTicks = state.lastAcceptedUsdAskPriceTicks;
  projected.eventHash = state.eventHash;
  delete projected.commitmentHash;
  return commitBookOverlay(projected);
}

export function getBookSideLevels(state: BookState, side: Side, depth = 10): BookSideLevel[] {
  const levels: BookSideLevel[] = [];
  for (const [key, page] of orderedPages(state, side)) {
    let level = levels.at(-1);
    if (!level || level.priceTicks !== key.priceTicks) {
      if (levels.length >= depth) break;
      level = { priceTicks: key.priceTicks, qtyLots: 0n, ownerIds: [], orderIds: [] };
      levels.push(level);
    }
    for (const order of pageOrders(side, key, page)) {
      level.qtyLots += order.qtyLots;
      if (!level.ownerIds.includes(order.ownerId)) level.ownerIds.push(order.ownerId);
      level.orderIds.push(order.orderId);
    }
  }
  return levels;
}

export function computeBookHash(state: BookState): string {
  const text = `${state.eventHash}|${state.tradeCount}|${state.tradeQtySum}|${getBestBid(state) ?? '-'}|${getBestAsk(state) ?? '-'}`;
  let hash = 0n;
  for (const char of text) hash = (hash * 31n + BigInt(char.charCodeAt(0))) & 0xffff_ffff_ffff_ffffn;
  return hash.toString(16).padStart(16, '0');
}

export function renderAscii(state: BookState, depth = 10): string {
  const bids = getBookSideLevels(state, 0, depth);
  const asks = getBookSideLevels(state, 1, depth);
  const rows = ['BID | ASK'];
  for (let index = 0; index < depth; index += 1) {
    const bid = bids[index];
    const ask = asks[index];
    rows.push(`${bid ? `${bid.priceTicks}:${bid.qtyLots}` : '-'} | ${ask ? `${ask.priceTicks}:${ask.qtyLots}` : '-'}`);
  }
  return rows.join('\n');
}
