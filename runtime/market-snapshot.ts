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
  book: any,
  side: 'bid' | 'ask',
  depth: number,
): MarketSideLevel[] => {
  const { orderQtyLots, orderNext, orderActive, params } = book || {};
  const pmin = Number(params?.pmin || 0);
  const tick = Number(params?.tick || 1);
  const levelHead = side === 'bid' ? (book?.levelHeadBid || []) : (book?.levelHeadAsk || []);
  const bitmap = side === 'bid' ? (book?.bitmapBid || []) : (book?.bitmapAsk || []);
  const levels = Number(book?.levels || 0);
  const capDepth = Math.max(1, Math.min(depth, RPC_MARKET_MAX_DEPTH));
  const maxLevelsPerBook = Math.max(capDepth * 6, capDepth);

  let idx = side === 'bid' ? Number(book?.bestBidIdx ?? -1) : Number(book?.bestAskIdx ?? -1);
  let visitedLevels = 0;
  const out: Array<{ price: number; size: number }> = [];

  while (idx !== -1 && visitedLevels < maxLevelsPerBook && out.length < capDepth) {
    visitedLevels += 1;
    let headIdx = levelHead[idx];
    let levelSize = 0;
    while (headIdx !== -1) {
      if (orderActive?.[headIdx]) {
        levelSize += Number(orderQtyLots?.[headIdx] || 0);
      }
      headIdx = orderNext?.[headIdx];
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
  const book = books instanceof Map ? books.get(pairId) : null;
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
