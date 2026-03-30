import type { EntityReplica } from './types';
import { ORDERBOOK_PRICE_SCALE, getBookSideLevels, type BookState } from './orderbook';

export type MarketSideLevel = { price: string; size: number; total: number };

export type MarketSnapshotPayload = {
  format: 'exact-price-levels-v2';
  hubEntityId: string;
  pairId: string;
  depth: number;
  displayDecimals: number;
  priceScale: string;
  bucketWidthTicks: string | null;
  bids: MarketSideLevel[];
  asks: MarketSideLevel[];
  spread: string | null;
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

const extractMarketSideLevels = (
  book: BookState,
  side: 0 | 1,
  depth: number,
): MarketSideLevel[] => {
  const capDepth = Math.max(1, Math.min(depth, RPC_MARKET_MAX_DEPTH));
  const levels = getBookSideLevels(book, side, capDepth);
  let running = 0;
  return levels.map((level) => {
    running += level.qtyLots;
    return {
      price: level.priceTicks.toString(),
      size: level.qtyLots,
      total: running,
    };
  });
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

function formatPercent3(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return '-';
  }
  return ((numerator / denominator) * 100).toFixed(3);
}

export const buildMarketSnapshotForReplica = (
  replica: EntityReplica | null | undefined,
  hubEntityId: string,
  pairId: string,
  depth: number,
): MarketSnapshotPayload => {
  const books = replica?.state?.orderbookExt?.books;
  const book = books instanceof Map ? books.get(pairId) ?? null : null;
  const bids = book ? extractMarketSideLevels(book, 0, depth) : [];
  const asks = book ? extractMarketSideLevels(book, 1, depth) : [];
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const bestBidTicks = bestBid ? BigInt(bestBid.price) : null;
  const bestAskTicks = bestAsk ? BigInt(bestAsk.price) : null;
  const spreadTicks = bestBidTicks !== null && bestAskTicks !== null ? bestAskTicks - bestBidTicks : null;
  const spreadPercent = bestBidTicks !== null && bestAskTicks !== null
    ? formatPercent3(Number(spreadTicks ?? 0n), Number(bestAskTicks))
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
    format: 'exact-price-levels-v2',
    hubEntityId,
    pairId,
    depth: Math.max(1, Math.min(depth, RPC_MARKET_MAX_DEPTH)),
    displayDecimals: 4,
    priceScale: ORDERBOOK_PRICE_SCALE.toString(),
    bucketWidthTicks: book ? book.params.bucketWidthTicks.toString() : null,
    bids,
    asks,
    spread: spreadTicks?.toString() ?? null,
    spreadPercent,
    source: 'orderbookExt',
    entityHeight,
    entityStateHash,
    hubUpdatedAt,
    updatedAt: Date.now(),
  };
};
