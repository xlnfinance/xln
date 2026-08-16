import type { EntityReplica } from '../../../entity/types';
import { ORDERBOOK_PRICE_SCALE, getBookSideLevels, type BookState } from '../../../orderbook';
import { getJurisdictionIdentityRef } from '../../../jurisdiction/machine/jurisdiction-runtime';
export { normalizeMarketEntityId, normalizeMarketPairId } from './identifiers';

export type MarketSideLevel = {
  price: string;
  size: string;
  total: string;
  orderCount?: number;
  ownerIds?: string[];
  orderIds?: string[];
  sourceHubEntityIds?: string[];
};

export type MarketPairCatalogPayload = {
  format: 'market-pair-catalog';
  hubEntityId: string;
  jurisdictionRef: string;
  pairIds: string[];
  entityHeight: number;
  entityStateHash: string | null;
  updatedAt: number;
};

export type MarketSnapshotPayload = {
  format: 'exact-price-levels';
  hubEntityId: string;
  jurisdictionRef: string;
  pairId: string;
  depth: number;
  displayDecimals: number;
  priceScale: string;
  bucketWidthTicks: string | null;
  bids: MarketSideLevel[];
  asks: MarketSideLevel[];
  spread: string | null;
  spreadPercent: string;
  /** Maker price of the most recently committed trade in this exact Hub book. */
  lastTradePrice: string | null;
  /** Monotonic committed trade counter used by the relay to detect a new trade. */
  tradeCount: number;
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
  let running = 0n;
  return levels.map((level) => {
    running += level.qtyLots;
    return {
      price: level.priceTicks.toString(),
      size: level.qtyLots.toString(),
      total: running.toString(),
      orderCount: level.orderIds.length,
      ownerIds: level.ownerIds,
      orderIds: level.orderIds,
    };
  });
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
  const book = books?.get(pairId) ?? null;
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
  const lastTradePrice = book && book.tradeCount > 0 && book.lastTradePriceTicks > 0n
    ? book.lastTradePriceTicks.toString()
    : null;
  const entityHeight = Number(replica?.state?.height || 0) || 0;
  const entityStateHash = typeof replica?.lockedFrame?.hash === 'string'
    ? replica.lockedFrame.hash
    : null;
  const hubUpdatedAt = Number(replica?.state?.timestamp || 0);
  const jurisdictionRef = getJurisdictionIdentityRef(replica?.state?.config?.jurisdiction);
  if (!jurisdictionRef) throw new Error(`MARKET_JURISDICTION_REF_MISSING:${hubEntityId}`);
  return {
    format: 'exact-price-levels',
    hubEntityId,
    jurisdictionRef,
    pairId,
    depth: Math.max(1, Math.min(depth, RPC_MARKET_MAX_DEPTH)),
    displayDecimals: 4,
    priceScale: ORDERBOOK_PRICE_SCALE.toString(),
    bucketWidthTicks: book ? book.params.bucketWidthTicks.toString() : null,
    bids,
    asks,
    spread: spreadTicks?.toString() ?? null,
    spreadPercent,
    lastTradePrice,
    tradeCount: book?.tradeCount ?? 0,
    source: 'orderbookExt',
    entityHeight,
    entityStateHash,
    hubUpdatedAt,
    updatedAt: Date.now(),
  };
};

export const buildMarketPairCatalogForReplica = (
  replica: EntityReplica | null | undefined,
  hubEntityId: string,
): MarketPairCatalogPayload => {
  const jurisdictionRef = getJurisdictionIdentityRef(replica?.state?.config?.jurisdiction);
  if (!jurisdictionRef) throw new Error(`MARKET_JURISDICTION_REF_MISSING:${hubEntityId}`);
  const books = replica?.state?.orderbookExt?.books;
  const pairIds = books ? Array.from(books.keys()).sort() : [];
  return {
    format: 'market-pair-catalog',
    hubEntityId,
    jurisdictionRef,
    pairIds,
    entityHeight: Number(replica?.state?.height || 0) || 0,
    entityStateHash: typeof replica?.lockedFrame?.hash === 'string'
      ? replica.lockedFrame.hash
      : null,
    updatedAt: Date.now(),
  };
};
