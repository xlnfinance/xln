import { compareStableText } from '../../../protocol/serialization';
import type { MarketSideLevel, MarketSnapshotPayload } from './snapshot';

export type RelayMarketSource = Readonly<{
  hubEntityId: string;
  jurisdictionRef: string;
  entityHeight: number;
  entityStateHash: string | null;
  hubUpdatedAt: number;
  snapshotUpdatedAt: number;
  tradeCount: number;
  lastTradePrice: string | null;
}>;

export type RelayMarketSnapshotPayload = Readonly<{
  format: 'exact-price-levels';
  pairId: string;
  jurisdictionRef: string;
  depth: number;
  displayDecimals: number;
  priceScale: string;
  bids: MarketSideLevel[];
  asks: MarketSideLevel[];
  spread: string | null;
  spreadPercent: string;
  lastTradePrice: string | null;
  lastTradeObservedAt: number | null;
  lastTradeHubEntityId: string | null;
  source: 'relayAggregate';
  sourceCount: number;
  sources: RelayMarketSource[];
  updatedAt: number;
}>;

type TradeObservation = Readonly<{
  tradeCount: number;
  lastTradePrice: string;
  observedAt: number;
}>;

export type RelayTradeObservationStore = Map<string, TradeObservation>;

const observationKey = (
  snapshot: Pick<MarketSnapshotPayload, 'hubEntityId' | 'jurisdictionRef' | 'pairId'>,
): string => `${snapshot.hubEntityId}:${snapshot.jurisdictionRef}:${snapshot.pairId}`;

const observeTrade = (
  store: RelayTradeObservationStore,
  snapshot: MarketSnapshotPayload,
  observedAt: number,
): TradeObservation | null => {
  const key = observationKey(snapshot);
  const previous = store.get(key);
  if (snapshot.tradeCount === 0) {
    if (snapshot.lastTradePrice !== null) throw new Error(`MARKET_LAST_TRADE_WITHOUT_COUNT:${key}`);
    if (previous) throw new Error(`MARKET_TRADE_COUNT_ROLLBACK:${key}:${previous.tradeCount}:0`);
    return null;
  }
  if (snapshot.lastTradePrice === null) throw new Error(`MARKET_LAST_TRADE_MISSING:${key}`);
  if (previous && snapshot.tradeCount < previous.tradeCount) {
    throw new Error(`MARKET_TRADE_COUNT_ROLLBACK:${key}:${previous.tradeCount}:${snapshot.tradeCount}`);
  }
  if (previous && snapshot.tradeCount === previous.tradeCount) {
    if (snapshot.lastTradePrice !== previous.lastTradePrice) {
      throw new Error(`MARKET_LAST_TRADE_REWRITE:${key}:${previous.lastTradePrice}:${snapshot.lastTradePrice}`);
    }
    return previous;
  }
  const next = {
    tradeCount: snapshot.tradeCount,
    lastTradePrice: snapshot.lastTradePrice,
    observedAt,
  };
  store.set(key, next);
  return next;
};

type MutableLevel = {
  size: bigint;
  orderCount: number;
  ownerIds: Set<string>;
  orderIds: Set<string>;
  sourceHubEntityIds: Set<string>;
};

const mergeLevels = (
  snapshots: readonly MarketSnapshotPayload[],
  side: 'bids' | 'asks',
  depth: number,
): MarketSideLevel[] => {
  const levels = new Map<string, MutableLevel>();
  for (const snapshot of snapshots) {
    for (const source of snapshot[side]) {
      const current = levels.get(source.price) ?? {
        size: 0n,
        orderCount: 0,
        ownerIds: new Set<string>(),
        orderIds: new Set<string>(),
        sourceHubEntityIds: new Set<string>(),
      };
      current.size += BigInt(source.size);
      current.orderCount += source.orderCount ?? 0;
      for (const ownerId of source.ownerIds ?? []) current.ownerIds.add(ownerId);
      for (const orderId of source.orderIds ?? []) current.orderIds.add(orderId);
      current.sourceHubEntityIds.add(snapshot.hubEntityId);
      levels.set(source.price, current);
    }
  }
  const sorted = Array.from(levels.entries()).sort(([left], [right]) => {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a === b) return 0;
    if (side === 'bids') return a > b ? -1 : 1;
    return a < b ? -1 : 1;
  }).slice(0, depth);
  let running = 0n;
  return sorted.map(([price, level]) => {
    running += level.size;
    return {
      price,
      size: level.size.toString(),
      total: running.toString(),
      orderCount: level.orderCount,
      ownerIds: Array.from(level.ownerIds).sort(compareStableText),
      orderIds: Array.from(level.orderIds).sort(compareStableText),
      sourceHubEntityIds: Array.from(level.sourceHubEntityIds).sort(compareStableText),
    };
  });
};

const percent = (spread: bigint, ask: bigint): string => {
  if (spread < 0n || ask <= 0n) return '-';
  const scaled = (spread * 100_000n) / ask;
  return `${(scaled / 1_000n).toString()}.${(scaled % 1_000n).toString().padStart(3, '0')}`;
};

export const aggregateMarketSnapshots = (
  snapshots: readonly MarketSnapshotPayload[],
  depth: number,
  observedAt: number,
  observations: RelayTradeObservationStore,
): RelayMarketSnapshotPayload => {
  if (snapshots.length === 0) throw new Error('MARKET_AGGREGATE_SOURCES_REQUIRED');
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error('MARKET_AGGREGATE_TIME_INVALID');
  const [first] = snapshots;
  if (!first) throw new Error('MARKET_AGGREGATE_SOURCES_REQUIRED');
  const sourceIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (sourceIds.has(snapshot.hubEntityId)) throw new Error(`MARKET_AGGREGATE_SOURCE_DUPLICATE:${snapshot.hubEntityId}`);
    sourceIds.add(snapshot.hubEntityId);
    if (snapshot.pairId !== first.pairId) throw new Error('MARKET_AGGREGATE_PAIR_MISMATCH');
    if (snapshot.jurisdictionRef !== first.jurisdictionRef) throw new Error('MARKET_AGGREGATE_JURISDICTION_MISMATCH');
    if (snapshot.priceScale !== first.priceScale || snapshot.displayDecimals !== first.displayDecimals) {
      throw new Error('MARKET_AGGREGATE_SCALE_MISMATCH');
    }
  }
  const cappedDepth = Math.max(1, Math.min(Math.floor(depth), 100));
  const bids = mergeLevels(snapshots, 'bids', cappedDepth);
  const asks = mergeLevels(snapshots, 'asks', cappedDepth);
  const bestBid = bids[0] ? BigInt(bids[0].price) : null;
  const bestAsk = asks[0] ? BigInt(asks[0].price) : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const trades = snapshots.flatMap(snapshot => {
    const observation = observeTrade(observations, snapshot, observedAt);
    return observation ? [{ hubEntityId: snapshot.hubEntityId, ...observation }] : [];
  }).sort((left, right) =>
    right.observedAt - left.observedAt || compareStableText(left.hubEntityId, right.hubEntityId)
  );
  const lastTrade = trades[0] ?? null;
  const sources = snapshots.map(snapshot => ({
    hubEntityId: snapshot.hubEntityId,
    jurisdictionRef: snapshot.jurisdictionRef,
    entityHeight: snapshot.entityHeight,
    entityStateHash: snapshot.entityStateHash,
    hubUpdatedAt: snapshot.hubUpdatedAt,
    snapshotUpdatedAt: snapshot.updatedAt,
    tradeCount: snapshot.tradeCount,
    lastTradePrice: snapshot.lastTradePrice,
  })).sort((left, right) => compareStableText(left.hubEntityId, right.hubEntityId));
  return {
    format: 'exact-price-levels',
    pairId: first.pairId,
    jurisdictionRef: first.jurisdictionRef,
    depth: cappedDepth,
    displayDecimals: first.displayDecimals,
    priceScale: first.priceScale,
    bids,
    asks,
    spread: spread?.toString() ?? null,
    spreadPercent: spread !== null && bestAsk !== null ? percent(spread, bestAsk) : '-',
    lastTradePrice: lastTrade?.lastTradePrice ?? null,
    lastTradeObservedAt: lastTrade?.observedAt ?? null,
    lastTradeHubEntityId: lastTrade?.hubEntityId ?? null,
    source: 'relayAggregate',
    sourceCount: sources.length,
    sources,
    updatedAt: observedAt,
  };
};
