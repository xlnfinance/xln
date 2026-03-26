import type { EntityReplica } from './types';

export type MarketSideLevel = { price: number; size: number; total: number };

export type MarketSnapshotPayload = {
  hubEntityId: string;
  pairId: string;
  depth: number;
  bids: MarketSideLevel[];
  asks: MarketSideLevel[];
  spread: number | null;
  spreadPercent: string;
  source: 'orderbookExt';
  entityHeight: number;
  entityStateHash: string | null;
  hubUpdatedAt: number;
  updatedAt: number;
};

export const RPC_MARKET_PUBLISH_MS = 1000;
export const RPC_MARKET_MAX_DEPTH = 100;
export const RPC_MARKET_DEFAULT_DEPTH = 20;

type NumericArrayLike = ArrayLike<number>;
type TruthyArrayLike = ArrayLike<number | boolean>;

type NormalizedMarketBook = {
  params: {
    pmin: number;
    tick: number;
  };
  levelHeadBid: NumericArrayLike;
  levelHeadAsk: NumericArrayLike;
  bitmapBid: NumericArrayLike;
  bitmapAsk: NumericArrayLike;
  levels: number;
  bestBidIdx: number;
  bestAskIdx: number;
  orderActive: TruthyArrayLike;
  orderQtyLots: NumericArrayLike;
  orderNext: NumericArrayLike;
};

const EMPTY_LEVEL = -1;
const EMPTY_NUMERIC_ARRAY: number[] = [];
const EMPTY_TRUTHY_ARRAY: Array<number | boolean> = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNumericArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(item => typeof item === 'number');

const isNumericTypedArray = (value: unknown): value is NumericArrayLike => {
  if (!ArrayBuffer.isView(value)) return false;
  return value instanceof Int8Array
    || value instanceof Uint8Array
    || value instanceof Uint8ClampedArray
    || value instanceof Int16Array
    || value instanceof Uint16Array
    || value instanceof Int32Array
    || value instanceof Uint32Array
    || value instanceof Float32Array
    || value instanceof Float64Array;
};

const toNumericArrayLike = (value: unknown): NumericArrayLike =>
  isNumericArray(value) || isNumericTypedArray(value) ? value : EMPTY_NUMERIC_ARRAY;

const isTruthyArray = (value: unknown): value is Array<number | boolean> =>
  Array.isArray(value) && value.every(item => typeof item === 'number' || typeof item === 'boolean');

const isTruthyTypedArray = (value: unknown): value is TruthyArrayLike =>
  value instanceof Int8Array
  || value instanceof Uint8Array
  || value instanceof Uint8ClampedArray
  || value instanceof Int16Array
  || value instanceof Uint16Array
  || value instanceof Int32Array
  || value instanceof Uint32Array;

const toTruthyArrayLike = (value: unknown): TruthyArrayLike =>
  isTruthyArray(value) || isTruthyTypedArray(value) ? value : EMPTY_TRUTHY_ARRAY;

const toFiniteNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const normalizeMarketBook = (value: unknown): NormalizedMarketBook | null => {
  if (!isRecord(value)) return null;
  const paramsRaw = isRecord(value.params) ? value.params : null;
  if (!paramsRaw) return null;
  return {
    params: {
      pmin: toFiniteNumber(paramsRaw.pmin, 0),
      tick: toFiniteNumber(paramsRaw.tick, 1),
    },
    levelHeadBid: toNumericArrayLike(value.levelHeadBid),
    levelHeadAsk: toNumericArrayLike(value.levelHeadAsk),
    bitmapBid: toNumericArrayLike(value.bitmapBid),
    bitmapAsk: toNumericArrayLike(value.bitmapAsk),
    levels: Math.max(0, Math.floor(toFiniteNumber(value.levels, 0))),
    bestBidIdx: Math.floor(toFiniteNumber(value.bestBidIdx, EMPTY_LEVEL)),
    bestAskIdx: Math.floor(toFiniteNumber(value.bestAskIdx, EMPTY_LEVEL)),
    orderActive: toTruthyArrayLike(value.orderActive),
    orderQtyLots: toNumericArrayLike(value.orderQtyLots),
    orderNext: toNumericArrayLike(value.orderNext),
  };
};

export const normalizeMarketEntityId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

export const normalizeMarketPairId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a === b) return null;
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  return `${left}/${right}`;
};

const findPrevBookLevel = (bitmap: Uint32Array | number[], start: number): number => {
  for (let i = start; i >= 0; i--) {
    const w = Math.floor(i / 32);
    const b = i & 31;
    if (bitmap[w] && (bitmap[w] & (1 << b))) return i;
  }
  return -1;
};

const findNextBookLevel = (bitmap: Uint32Array | number[], levels: number, start: number): number => {
  for (let i = start; i < levels; i++) {
    const w = Math.floor(i / 32);
    const b = i & 31;
    if (bitmap[w] && (bitmap[w] & (1 << b))) return i;
  }
  return -1;
};

const extractMarketSideLevels = (
  book: NormalizedMarketBook,
  side: 'bid' | 'ask',
  depth: number,
): MarketSideLevel[] => {
  const { orderQtyLots, orderNext, orderActive, params, levels } = book;
  const pmin = params.pmin;
  const tick = params.tick;
  const levelHead = side === 'bid' ? book.levelHeadBid : book.levelHeadAsk;
  const bitmap = side === 'bid' ? book.bitmapBid : book.bitmapAsk;
  const capDepth = Math.max(1, Math.min(depth, RPC_MARKET_MAX_DEPTH));
  const maxLevelsPerBook = Math.max(capDepth * 6, capDepth);

  let idx = side === 'bid' ? book.bestBidIdx : book.bestAskIdx;
  let visitedLevels = 0;
  const out: Array<{ price: number; size: number }> = [];

  while (idx !== EMPTY_LEVEL && visitedLevels < maxLevelsPerBook && out.length < capDepth) {
    visitedLevels += 1;
    let headIdx = levelHead[idx];
    let levelSize = 0;
    while (headIdx !== EMPTY_LEVEL) {
      if (orderActive[headIdx]) {
        levelSize += Number(orderQtyLots[headIdx] || 0);
      }
      headIdx = orderNext[headIdx] ?? EMPTY_LEVEL;
    }
    if (levelSize > 0) {
      out.push({
        price: pmin + idx * tick,
        size: levelSize,
      });
    }
    idx = side === 'bid'
      ? findPrevBookLevel(bitmap, idx - 1)
      : findNextBookLevel(bitmap, levels, idx + 1);
  }

  let running = 0;
  return out.map(level => {
    running += level.size;
    return {
      price: level.price,
      size: level.size,
      total: running,
    };
  });
};

export const buildMarketSnapshotForReplica = (
  replica: EntityReplica | null | undefined,
  hubEntityId: string,
  pairId: string,
  depth: number,
): MarketSnapshotPayload => {
  const books = replica?.state?.orderbookExt?.books;
  const rawBook = books instanceof Map ? books.get(pairId) : null;
  const book = normalizeMarketBook(rawBook);
  const bids = book ? extractMarketSideLevels(book, 'bid', depth) : [];
  const asks = book ? extractMarketSideLevels(book, 'ask', depth) : [];
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;
  const spreadPercent = bestBid && bestAsk && bestAsk.price > 0
    ? ((spread! / bestAsk.price) * 100).toFixed(3)
    : '-';
  const entityHeight =
    Number(replica?.state?.height || 0)
    || Number(replica?.state?.currentHeight || 0)
    || 0;
  const entityStateHash = typeof replica?.state?.stateHash === 'string'
    ? replica.state.stateHash
    : null;
  const hubUpdatedAt = Number(replica?.state?.timestamp || 0);
  return {
    hubEntityId,
    pairId,
    depth: Math.max(1, Math.min(depth, RPC_MARKET_MAX_DEPTH)),
    bids,
    asks,
    spread,
    spreadPercent,
    source: 'orderbookExt',
    entityHeight,
    entityStateHash,
    hubUpdatedAt,
    updatedAt: Date.now(),
  };
};
