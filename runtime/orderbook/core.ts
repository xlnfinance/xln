/**
 * Pure Orderbook Core
 *
 * Exact-price limit order book with a bucket index:
 * - canonical truth is always exact `priceTicks`
 * - buckets only accelerate lookup / grouping
 * - no price grid, repricing, or representability window
 */

export type Side = 0 | 1;        // 0 = BUY (bids), 1 = SELL (asks)
export type TIF = 0 | 1 | 2;     // 0 = GTC, 1 = IOC, 2 = FOK

export const MAX_FILL_RATIO = 65535;

export type OrderCmd =
  | { kind: 0; ownerId: string; orderId: string; side: Side; tif: TIF; postOnly: boolean; priceTicks: bigint; qtyLots: number; minFillRatio?: number }
  | { kind: 1; ownerId: string; orderId: string }
  | { kind: 2; ownerId: string; orderId: string; newPriceTicks: bigint | null; qtyDeltaLots: number };

export type BookEvent =
  | { type: 'ACK'; orderId: string; ownerId: string }
  | { type: 'REJECT'; orderId: string; ownerId: string; reason: string; blockingOrderId?: string }
  | { type: 'TRADE'; price: bigint; qty: number; makerOwnerId: string; takerOwnerId: string; makerOrderId: string; takerOrderId: string; makerQtyBefore: number; takerQtyTotal: number }
  | { type: 'REDUCED'; orderId: string; ownerId: string; delta: number; remain: number }
  | { type: 'CANCELED'; orderId: string; ownerId: string };

export interface BookParams {
  bucketWidthTicks: bigint;
  maxOrders: number;
  stpPolicy: 0 | 1; // 0=off, 1=cancel taker
}

export interface BookOrderState {
  orderId: string;
  ownerId: string;
  side: Side;
  priceTicks: bigint;
  qtyLots: number;
  seq: number;
  bucketId: bigint;
}

export interface PriceLevelState {
  priceTicks: bigint;
  orderIds: string[];
  totalQtyLots: number;
}

export interface PriceBucketState {
  bucketId: bigint;
  pricesAsc: bigint[];
  levels: Map<string, PriceLevelState>;
}

export interface BookSideLevel {
  priceTicks: bigint;
  qtyLots: number;
  ownerIds: string[];
  orderIds: string[];
}

export interface BookState {
  readonly params: BookParams;
  readonly orders: Map<string, BookOrderState>;
  readonly bidBuckets: Map<string, PriceBucketState>;
  readonly askBuckets: Map<string, PriceBucketState>;
  readonly bidBucketIdsDesc: bigint[];
  readonly askBucketIdsAsc: bigint[];
  readonly nextSeq: number;
  readonly tradeCount: number;
  readonly tradeQtySum: bigint;
  readonly eventHash: bigint;
}

const MAX_QTY = 0xFFFFFFFF;
const PRIME = 0x1_0000_01n;

type MutableBookState = {
  params: BookParams;
  orders: Map<string, BookOrderState>;
  bidBuckets: Map<string, PriceBucketState>;
  askBuckets: Map<string, PriceBucketState>;
  bidBucketIdsDesc: bigint[];
  askBucketIdsAsc: bigint[];
  nextSeq: number;
  tradeCount: number;
  tradeQtySum: bigint;
  eventHash: bigint;
};

const sideBucketMap = (state: Pick<BookState, 'bidBuckets' | 'askBuckets'>, side: Side): Map<string, PriceBucketState> =>
  side === 0 ? state.bidBuckets : state.askBuckets;

const sideBucketIds = (state: Pick<BookState, 'bidBucketIdsDesc' | 'askBucketIdsAsc'>, side: Side): bigint[] =>
  side === 0 ? state.bidBucketIdsDesc : state.askBucketIdsAsc;

const priceKey = (priceTicks: bigint): string => priceTicks.toString();
const bucketKey = (bucketId: bigint): string => bucketId.toString();

export function bucketIdForPrice(priceTicks: bigint, bucketWidthTicks: bigint): bigint {
  if (priceTicks <= 0n) throw new Error('priceTicks must be positive');
  if (bucketWidthTicks <= 0n) throw new Error('bucketWidthTicks must be positive');
  return priceTicks / bucketWidthTicks;
}

function insertBigIntUnique(sorted: bigint[], value: bigint, descending: boolean): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const current = sorted[mid]!;
    if (current === value) return;
    if (descending ? current > value : current < value) low = mid + 1;
    else high = mid;
  }
  sorted.splice(low, 0, value);
}

function removeBigInt(sorted: bigint[], value: bigint): void {
  const index = sorted.findIndex((entry) => entry === value);
  if (index >= 0) sorted.splice(index, 1);
}

function insertPriceAsc(pricesAsc: bigint[], value: bigint): void {
  let low = 0;
  let high = pricesAsc.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const current = pricesAsc[mid]!;
    if (current === value) return;
    if (current < value) low = mid + 1;
    else high = mid;
  }
  pricesAsc.splice(low, 0, value);
}

function removeOrderId(orderIds: string[], orderId: string): boolean {
  const index = orderIds.indexOf(orderId);
  if (index < 0) return false;
  orderIds.splice(index, 1);
  return true;
}

function ensureBucket(state: MutableBookState, side: Side, bucketId: bigint): PriceBucketState {
  const buckets = sideBucketMap(state, side);
  const ids = sideBucketIds(state, side);
  const key = bucketKey(bucketId);
  let bucket = buckets.get(key);
  if (bucket) return bucket;
  bucket = {
    bucketId,
    pricesAsc: [],
    levels: new Map(),
  };
  buckets.set(key, bucket);
  insertBigIntUnique(ids, bucketId, side === 0);
  return bucket;
}

function cleanupBucketIfEmpty(state: MutableBookState, side: Side, bucketId: bigint): void {
  const buckets = sideBucketMap(state, side);
  const ids = sideBucketIds(state, side);
  const key = bucketKey(bucketId);
  const bucket = buckets.get(key);
  if (!bucket) return;
  if (bucket.pricesAsc.length > 0) return;
  buckets.delete(key);
  removeBigInt(ids, bucketId);
}

function addRestingOrder(state: MutableBookState, order: BookOrderState): void {
  const bucket = ensureBucket(state, order.side, order.bucketId);
  const levelKey = priceKey(order.priceTicks);
  let level = bucket.levels.get(levelKey);
  if (!level) {
    level = {
      priceTicks: order.priceTicks,
      orderIds: [],
      totalQtyLots: 0,
    };
    bucket.levels.set(levelKey, level);
    insertPriceAsc(bucket.pricesAsc, order.priceTicks);
  }
  level.orderIds.push(order.orderId);
  level.totalQtyLots += order.qtyLots;
  state.orders.set(order.orderId, order);
}

function removeExistingOrder(state: MutableBookState, orderId: string): BookOrderState | null {
  const order = state.orders.get(orderId);
  if (!order) return null;
  const buckets = sideBucketMap(state, order.side);
  const bucket = buckets.get(bucketKey(order.bucketId));
  if (!bucket) {
    throw new Error(`BOOK_CORRUPTION: missing bucket for order ${orderId}`);
  }
  const level = bucket.levels.get(priceKey(order.priceTicks));
  if (!level) {
    throw new Error(`BOOK_CORRUPTION: missing level for order ${orderId}`);
  }
  if (!removeOrderId(level.orderIds, orderId)) {
    throw new Error(`BOOK_CORRUPTION: order ${orderId} missing from level queue`);
  }
  const nextTotalQtyLots = level.totalQtyLots - order.qtyLots;
  if (nextTotalQtyLots < 0) {
    throw new Error(`BOOK_CORRUPTION: level quantity underflow while removing ${orderId}`);
  }
  level.totalQtyLots = nextTotalQtyLots;
  if (level.orderIds.length === 0 || level.totalQtyLots === 0) {
    bucket.levels.delete(priceKey(order.priceTicks));
    removeBigInt(bucket.pricesAsc, order.priceTicks);
  }
  cleanupBucketIfEmpty(state, order.side, order.bucketId);
  state.orders.delete(orderId);
  return order;
}

type OrderedLevelView = {
  bucketId: bigint;
  level: PriceLevelState;
};

function* iterateOrderedLevels(
  state: Pick<BookState, 'bidBuckets' | 'askBuckets' | 'bidBucketIdsDesc' | 'askBucketIdsAsc'>,
  side: Side,
): Generator<OrderedLevelView, void, undefined> {
  const buckets = sideBucketMap(state, side);
  const bucketIds = sideBucketIds(state, side);
  for (const bucketId of bucketIds) {
    const bucket = buckets.get(bucketKey(bucketId));
    if (!bucket) continue;
    if (side === 0) {
      for (let i = bucket.pricesAsc.length - 1; i >= 0; i -= 1) {
        const priceTicks = bucket.pricesAsc[i]!;
        const level = bucket.levels.get(priceKey(priceTicks));
        if (!level || level.orderIds.length === 0 || level.totalQtyLots <= 0) continue;
        yield { bucketId, level };
      }
      continue;
    }
    for (const priceTicks of bucket.pricesAsc) {
      const level = bucket.levels.get(priceKey(priceTicks));
      if (!level || level.orderIds.length === 0 || level.totalQtyLots <= 0) continue;
      yield { bucketId, level };
    }
  }
}

function getTopLevel(
  state: Pick<BookState, 'bidBuckets' | 'askBuckets' | 'bidBucketIdsDesc' | 'askBucketIdsAsc'>,
  side: Side,
): OrderedLevelView | null {
  for (const level of iterateOrderedLevels(state, side)) return level;
  return null;
}

function getOrderedLevels(state: Pick<BookState, 'bidBuckets' | 'askBuckets' | 'bidBucketIdsDesc' | 'askBucketIdsAsc'>, side: Side): OrderedLevelView[] {
  return Array.from(iterateOrderedLevels(state, side));
}

function crosses(takerSide: Side, takerPriceTicks: bigint, makerPriceTicks: bigint): boolean {
  return takerSide === 0 ? makerPriceTicks <= takerPriceTicks : makerPriceTicks >= takerPriceTicks;
}

function bumpHash(state: MutableBookState, tag: number, a: number | bigint, b: number | bigint): void {
  const a32 = Number((typeof a === 'bigint' ? a : BigInt(a)) & 0xffffffffn);
  const b32 = Number((typeof b === 'bigint' ? b : BigInt(b)) & 0xffffffffn);
  state.eventHash = (state.eventHash * PRIME + BigInt((tag * 2654435761 >>> 0) ^ a32 ^ (b32 << 7))) & 0x1fffffffffffffn;
}

function estimateImmediateFill(
  state: BookState,
  takerSide: Side,
  takerOwnerId: string,
  takerPriceTicks: bigint,
  qtyLots: number,
): { filledQty: number; blockingOrderId?: string } {
  let remaining = qtyLots;
  const oppositeSide: Side = takerSide === 0 ? 1 : 0;
  for (const view of iterateOrderedLevels(state, oppositeSide)) {
    if (!crosses(takerSide, takerPriceTicks, view.level.priceTicks)) break;
    for (const makerOrderId of view.level.orderIds) {
      const maker = state.orders.get(makerOrderId);
      if (!maker || maker.qtyLots <= 0) continue;
      if (maker.ownerId === takerOwnerId && state.params.stpPolicy === 1) {
        // STP cancels the remaining taker quantity from the first self-cross onward.
        // Better-priced third-party liquidity ahead of that self order is still fillable.
        return { filledQty: qtyLots - remaining, blockingOrderId: makerOrderId };
      }
      remaining -= Math.min(maker.qtyLots, remaining);
      if (remaining <= 0) return { filledQty: qtyLots };
    }
  }
  return { filledQty: qtyLots - remaining };
}

function matchAgainstBook(
  state: MutableBookState,
  takerSide: Side,
  takerOwnerId: string,
  takerOrderId: string,
  takerPriceTicks: bigint,
  takerQtyLots: number,
  events: BookEvent[],
): { remaining: number; blockingOrderId?: string } {
  let remaining = takerQtyLots;
  const oppositeSide: Side = takerSide === 0 ? 1 : 0;

  while (remaining > 0) {
    const best = getTopLevel(state, oppositeSide);
    if (!best) break;
    if (!crosses(takerSide, takerPriceTicks, best.level.priceTicks)) break;

    const makerOrderId = best.level.orderIds[0];
    if (!makerOrderId) break;
    const maker = state.orders.get(makerOrderId);
    if (!maker || maker.qtyLots <= 0) {
      if (!removeOrderId(best.level.orderIds, makerOrderId)) {
        throw new Error(`BOOK_CORRUPTION: top-of-book order ${makerOrderId} missing from level queue`);
      }
      state.orders.delete(makerOrderId);
      if (best.level.orderIds.length === 0) {
        const bucket = sideBucketMap(state, oppositeSide).get(bucketKey(best.bucketId));
        if (bucket) {
          bucket.levels.delete(priceKey(best.level.priceTicks));
          removeBigInt(bucket.pricesAsc, best.level.priceTicks);
          cleanupBucketIfEmpty(state, oppositeSide, best.bucketId);
        }
      }
      continue;
    }

    if (maker.ownerId === takerOwnerId && state.params.stpPolicy === 1) {
      events.push({
        type: 'REJECT',
        orderId: takerOrderId,
        ownerId: takerOwnerId,
        reason: 'STP cancel taker',
        blockingOrderId: maker.orderId,
      });
      return { remaining, blockingOrderId: maker.orderId };
    }

    const tradeQty = Math.min(maker.qtyLots, remaining);
    const makerQtyBefore = maker.qtyLots;

    state.tradeCount += 1;
    state.tradeQtySum += BigInt(tradeQty);
    bumpHash(state, 3, best.level.priceTicks, tradeQty);

    events.push({
      type: 'TRADE',
      price: best.level.priceTicks,
      qty: tradeQty,
      makerOwnerId: maker.ownerId,
      takerOwnerId,
      makerOrderId: maker.orderId,
      takerOrderId,
      makerQtyBefore,
      takerQtyTotal: takerQtyLots,
    });

    remaining -= tradeQty;

    if (tradeQty === maker.qtyLots) {
      removeExistingOrder(state, maker.orderId);
    } else {
      maker.qtyLots -= tradeQty;
      const nextTotalQtyLots = best.level.totalQtyLots - tradeQty;
      if (nextTotalQtyLots < 0) {
        throw new Error(`BOOK_CORRUPTION: level quantity underflow while reducing ${maker.orderId}`);
      }
      best.level.totalQtyLots = nextTotalQtyLots;
      events.push({ type: 'REDUCED', orderId: maker.orderId, ownerId: maker.ownerId, delta: -tradeQty, remain: maker.qtyLots });
    }
  }

  return { remaining };
}

export function createBook(params: BookParams): BookState {
  const { bucketWidthTicks, maxOrders, stpPolicy } = params;
  if (bucketWidthTicks <= 0n) throw new Error('bucketWidthTicks must be positive');
  if (!Number.isFinite(maxOrders) || maxOrders <= 0) throw new Error('maxOrders must be positive');
  if (stpPolicy !== 0 && stpPolicy !== 1) throw new Error('unsupported stpPolicy');
  return {
    params: {
      bucketWidthTicks,
      maxOrders: Math.max(1, Math.floor(maxOrders)),
      stpPolicy,
    },
    orders: new Map(),
    bidBuckets: new Map(),
    askBuckets: new Map(),
    bidBucketIdsDesc: [],
    askBucketIdsAsc: [],
    nextSeq: 1,
    tradeCount: 0,
    tradeQtySum: 0n,
    eventHash: 0n,
  };
}

export function applyCommand(state: BookState, cmd: OrderCmd): { state: BookState; events: BookEvent[] } {
  /**
   * Hot-path note:
   *
   * The orderbook no longer clones the full pair book on every command.
   * That old "pure per-command" shape was convenient, but it multiplied work
   * and garbage for no real safety benefit at the book layer.
   *
   * Why in-place mutation is correct here:
   * - rollback boundaries live above the book, at runtime/entity/account
   *   working-state clones, not inside one book command
   * - a book command is not a persistence boundary
   * - if a process crashes, canonical recovery is snapshot + WAL replay
   * - if a pair book corrupts, the caller can rebuild that pair from canonical
   *   live offers instead of relying on a pre-command copy
   *
   * In other words: the book is a hot in-memory cache of canonical offers, not
   * the source of truth for disaster recovery. The source of truth is the
   * replicated entity/account state plus persisted snapshot/WAL.
   *
   * So `applyCommand` now mutates the provided working book directly and returns
   * that same object for API compatibility.
   */
  const events: BookEvent[] = [];
  const m = state as MutableBookState;

  if (cmd.kind === 2) {
    events.push({ type: 'REJECT', orderId: cmd.orderId, ownerId: cmd.ownerId, reason: 'replace unsupported' });
    return { state, events };
  }

  if (cmd.kind === 1) {
    const existing = m.orders.get(cmd.orderId);
    if (!existing) {
      events.push({ type: 'REJECT', orderId: cmd.orderId, ownerId: cmd.ownerId, reason: 'not found' });
      return { state, events };
    }
    if (existing.ownerId !== cmd.ownerId) {
      events.push({ type: 'REJECT', orderId: cmd.orderId, ownerId: cmd.ownerId, reason: 'not owner' });
      return { state, events };
    }
    removeExistingOrder(m, cmd.orderId);
    events.push({ type: 'CANCELED', orderId: cmd.orderId, ownerId: cmd.ownerId });
    bumpHash(m, 5, existing.bucketId, 0);
    return { state, events };
  }

  const { ownerId, orderId, side, tif, postOnly, priceTicks, qtyLots, minFillRatio = 0 } = cmd;

  if (qtyLots <= 0 || qtyLots > MAX_QTY) {
    events.push({ type: 'REJECT', orderId, ownerId, reason: 'qty out of range' });
    return { state, events };
  }
  if (priceTicks <= 0n) {
    events.push({ type: 'REJECT', orderId, ownerId, reason: 'price must be positive' });
    return { state, events };
  }
  if (minFillRatio < 0 || minFillRatio > MAX_FILL_RATIO) {
    events.push({ type: 'REJECT', orderId, ownerId, reason: `minFillRatio must be 0-${MAX_FILL_RATIO}` });
    return { state, events };
  }
  if (m.orders.has(orderId)) {
    events.push({ type: 'REJECT', orderId, ownerId, reason: 'duplicate orderId' });
    return { state, events };
  }

  const bestBid = getBestBid(m as BookState);
  const bestAsk = getBestAsk(m as BookState);

  if (postOnly) {
    if (side === 0 && bestAsk !== null && bestAsk <= priceTicks) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'postOnly would cross' });
      return { state, events };
    }
    if (side === 1 && bestBid !== null && bestBid >= priceTicks) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: 'postOnly would cross' });
      return { state, events };
    }
  }

  const estimate = estimateImmediateFill(m as BookState, side, ownerId, priceTicks, qtyLots);
  if (tif === 2 && estimate.filledQty < qtyLots) {
    events.push({ type: 'REJECT', orderId, ownerId, reason: 'FOK cannot fill entirely' });
    return { state, events };
  }
  if (minFillRatio > 0 && (tif === 1 || tif === 2)) {
    const fillRatio = Math.floor((estimate.filledQty * MAX_FILL_RATIO) / qtyLots);
    if (fillRatio < minFillRatio) {
      events.push({ type: 'REJECT', orderId, ownerId, reason: `minFillRatio not met: ${fillRatio} < ${minFillRatio} (pre-check)` });
      return { state, events };
    }
  }

  const match = matchAgainstBook(m, side, ownerId, orderId, priceTicks, qtyLots, events);
  const remaining = match.remaining;
  const filledQty = qtyLots - remaining;
  const stpBlocked = match.blockingOrderId !== undefined;

  if (remaining > 0) {
    if (stpBlocked) {
      // STP is an explicit cancel-remainder outcome. We never rest the leftover taker size.
    } else if (tif === 1 || tif === 2) {
      if (filledQty === 0) {
        events.push({ type: 'REJECT', orderId, ownerId, reason: 'no fill' });
      }
    } else {
      if (m.orders.size >= m.params.maxOrders) throw new Error('Out of order slots');
      const order: BookOrderState = {
        orderId,
        ownerId,
        side,
        priceTicks,
        qtyLots: remaining,
        seq: m.nextSeq,
        bucketId: bucketIdForPrice(priceTicks, m.params.bucketWidthTicks),
      };
      m.nextSeq += 1;
      addRestingOrder(m, order);
      events.push({ type: 'ACK', orderId, ownerId });
      bumpHash(m, 1, order.bucketId, remaining);
    }
  }

  return { state, events };
}

export function getBestBid(state: BookState): bigint | null {
  const first = getTopLevel(state, 0);
  return first?.level.priceTicks ?? null;
}

export function getBestAsk(state: BookState): bigint | null {
  const first = getTopLevel(state, 1);
  return first?.level.priceTicks ?? null;
}

export function getSpread(state: BookState): bigint | null {
  const bid = getBestBid(state);
  const ask = getBestAsk(state);
  if (bid === null || ask === null) return null;
  return ask - bid;
}

export function getBookOrder(state: BookState, orderId: string): BookOrderState | null {
  return state.orders.get(orderId) ?? null;
}

export function getBookOrders(state: BookState): BookOrderState[] {
  return Array.from(state.orders.values()).sort((left, right) => left.seq - right.seq);
}

export function getBookSideLevels(state: BookState, side: Side, depth = 10): BookSideLevel[] {
  const out: BookSideLevel[] = [];
  for (const view of getOrderedLevels(state, side)) {
    const ownerIds = new Set<string>();
    const orderIds: string[] = [];
    let totalQtyLots = 0;
    for (const orderId of view.level.orderIds) {
      const order = state.orders.get(orderId);
      if (!order || order.qtyLots <= 0) continue;
      ownerIds.add(order.ownerId);
      orderIds.push(orderId);
      totalQtyLots += order.qtyLots;
    }
    if (totalQtyLots <= 0) continue;
    out.push({
      priceTicks: view.level.priceTicks,
      qtyLots: totalQtyLots,
      ownerIds: Array.from(ownerIds),
      orderIds,
    });
    if (out.length >= depth) break;
  }
  return out;
}

export function computeBookHash(state: BookState): string {
  const bid = getBestBid(state)?.toString() ?? '-';
  const ask = getBestAsk(state)?.toString() ?? '-';
  const combined = `${state.eventHash.toString(16)}|${state.tradeCount}|${state.tradeQtySum}|${state.orders.size}|${bid}|${ask}`;
  let hash = 0n;
  for (let i = 0; i < combined.length; i += 1) {
    hash = (hash * 31n + BigInt(combined.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

export function renderAscii(state: BookState, depth = 10, perLevelOrders = 10, lineWidth = 40): string {
  const rows: string[] = [];
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const pad = (value: string, width: number) => (value.length >= width ? value : ' '.repeat(width - value.length) + value);

  const bids = getBookSideLevels(state, 0, depth).map((level) => ({
    px: level.priceTicks,
    orders: level.orderIds
      .slice(0, perLevelOrders)
      .map((orderId) => {
        const order = state.orders.get(orderId);
        return order ? `${order.qtyLots}@${order.ownerId.slice(-4)}` : null;
      })
      .filter(Boolean)
      .join(','),
  }));

  const asks = getBookSideLevels(state, 1, depth).map((level) => ({
    px: level.priceTicks,
    orders: level.orderIds
      .slice(0, perLevelOrders)
      .map((orderId) => {
        const order = state.orders.get(orderId);
        return order ? `${order.qtyLots}@${order.ownerId.slice(-4)}` : null;
      })
      .filter(Boolean)
      .join(','),
  }));

  rows.push(`${BOLD}     BID (qty@owner)      |      ASK (qty@owner)     ${RESET}`);
  rows.push(`${DIM}  PX      ORDERS          |   PX      ORDERS         ${RESET}`);
  for (let i = 0; i < depth; i += 1) {
    const bid = bids[i];
    const ask = asks[i];
    const bidPx = bid ? pad(String(bid.px), 6) : '      ';
    const askPx = ask ? pad(String(ask.px), 6) : '      ';
    const bidOrders = bid ? pad(bid.orders.slice(0, lineWidth), lineWidth) : ' '.repeat(lineWidth);
    const askOrders = ask ? pad(ask.orders.slice(0, lineWidth), lineWidth) : ' '.repeat(lineWidth);
    rows.push(`${GREEN}${bidPx} ${bidOrders}${RESET} | ${RED}${askPx} ${askOrders}${RESET}`);
  }
  return rows.join('\n');
}
