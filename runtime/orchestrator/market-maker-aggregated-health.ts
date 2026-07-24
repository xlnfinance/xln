import type { AggregatedHealth, MarketMakerHealthPayload } from './orchestrator-types';
import { classifyRuntimeMarketMakerFailure, type RuntimeFailureSignal } from '../protocol/failure-taxonomy';
import type { MarketSnapshotPayload } from '../relay/market-snapshot';

type AggregatedMarketMakerHealth = AggregatedHealth['marketMaker'];

export type MarketSnapshotOrderDepth = Readonly<{
  bidOffers: number;
  askOffers: number;
}>;

export const countMarketSnapshotOrderDepth = (
  snapshot: MarketSnapshotPayload | undefined,
): MarketSnapshotOrderDepth => {
  const countSide = (levels: MarketSnapshotPayload['bids'] | undefined): number =>
    (levels ?? []).reduce((sum, level) => {
      const orderCount = Number(level.orderCount);
      return sum + (Number.isFinite(orderCount) && orderCount > 0 ? Math.floor(orderCount) : 1);
    }, 0);
  return {
    bidOffers: countSide(snapshot?.bids),
    askOffers: countSide(snapshot?.asks),
  };
};

export const mergeMarketSnapshotOrderDepth = (
  ...depths: readonly MarketSnapshotOrderDepth[]
): MarketSnapshotOrderDepth => ({
  bidOffers: Math.max(0, ...depths.map(depth => depth.bidOffers)),
  askOffers: Math.max(0, ...depths.map(depth => depth.askOffers)),
});

export const isExactMarketSnapshotOrderDepth = (
  depth: MarketSnapshotOrderDepth,
  expectedPerSide: number,
): boolean =>
  expectedPerSide > 0 &&
  depth.bidOffers === expectedPerSide &&
  depth.askOffers === expectedPerSide;

type BuildAggregatedMarketMakerHealthParams = {
  mmEnabled: boolean;
  marketMakerActive: boolean;
  marketMakerHealth: MarketMakerHealthPayload | null;
  hubEntityIds: string[];
  expectedHubCount: number;
  entityId: string | null;
  startupPhase: string | null;
};

type ResolveMarketMakerFailureParams = {
  mmEnabled: boolean;
  marketMakerActive: boolean;
  marketMakerHealth: MarketMakerHealthPayload | null;
  childReady: boolean;
  startupPhase: string | null;
  hubs: AggregatedMarketMakerHealth['hubs'];
  expectedHubCount: number;
  crossReady: boolean;
};

const resolveMarketMakerFailure = ({
  mmEnabled,
  marketMakerActive,
  marketMakerHealth,
  childReady,
  startupPhase,
  hubs,
  expectedHubCount,
  crossReady,
}: ResolveMarketMakerFailureParams): RuntimeFailureSignal | null => {
  if (!mmEnabled) return null;
  if (!marketMakerActive) {
    return classifyRuntimeMarketMakerFailure('MARKET_MAKER_CHILD_INACTIVE', 'market-maker child process is not active');
  }
  if (!marketMakerHealth?.marketMaker) {
    return classifyRuntimeMarketMakerFailure('MARKET_MAKER_HEALTH_MISSING', 'market-maker health payload is missing');
  }
  if (startupPhase !== 'offers-ready') {
    return classifyRuntimeMarketMakerFailure(
      'MARKET_MAKER_STARTUP_PHASE_NOT_READY',
      `market-maker startup phase is ${startupPhase || 'unknown'}`,
    );
  }
  if (!childReady) {
    return classifyRuntimeMarketMakerFailure('MARKET_MAKER_CHILD_NOT_READY', 'market-maker child health is not ready');
  }
  if (hubs.length !== expectedHubCount) {
    return classifyRuntimeMarketMakerFailure(
      'MARKET_MAKER_HUB_COUNT_MISMATCH',
      `market-maker sees ${hubs.length} hubs, expected ${expectedHubCount}`,
    );
  }
  if (!hubs.every((hub) => hub.depthReady === true)) {
    return classifyRuntimeMarketMakerFailure('MARKET_MAKER_HUB_DEPTH_NOT_READY', 'market-maker hub offer depth is not ready');
  }
  if (!crossReady) {
    return classifyRuntimeMarketMakerFailure('MARKET_MAKER_CROSS_NOT_READY', 'market-maker cross routes are not ready');
  }
  return null;
};

export const buildAggregatedMarketMakerHealth = ({
  mmEnabled,
  marketMakerActive,
  marketMakerHealth,
  hubEntityIds,
  expectedHubCount,
  entityId,
  startupPhase,
}: BuildAggregatedMarketMakerHealthParams): AggregatedMarketMakerHealth => {
  const expectedOffersPerHub = Number(marketMakerHealth?.marketMaker?.expectedOffersPerHub || 0);
  const hubsById = new Map<string, {
    hubEntityId: string;
    offers: number;
    ready: boolean;
    depthReady: boolean;
    blockers: unknown[];
    pairs: AggregatedMarketMakerHealth['hubs'][number]['pairs'];
  }>();

  for (const hub of marketMakerHealth?.marketMaker?.hubs ?? []) {
    const hubEntityId = String(hub.hubEntityId || '').toLowerCase();
    if (!hubEntityId) continue;
    hubsById.set(hubEntityId, {
      hubEntityId,
      offers: Number(hub.offers || 0),
      ready: hub.ready === true,
      depthReady: hub.depthReady === true,
      blockers: Array.isArray(hub.blockers) ? hub.blockers : [],
      pairs: Array.isArray(hub.pairs)
        ? hub.pairs.map((pair) => ({
            pairId: String(pair.pairId || ''),
            offers: Number(pair.offers || 0),
            ready: pair.ready === true,
            depthReady: pair.depthReady === true,
            expectedOffers: Number(pair.expectedOffers || 0),
          }))
        : [],
    });
  }

  const rawCross = marketMakerHealth?.marketMaker?.cross;
  const cross: AggregatedMarketMakerHealth['cross'] = {
    applicable: rawCross?.applicable === true || Number(rawCross?.expectedRoutes || 0) > 0,
    ok: rawCross?.ok === true,
    expectedRoutes: Number(rawCross?.expectedRoutes || 0),
    expectedOffersPerRoute: Number(rawCross?.expectedOffersPerRoute || 0),
    expectedOffersPerPair: Number(rawCross?.expectedOffersPerPair || 0),
    routeCount: Number(rawCross?.routeCount || (Array.isArray(rawCross?.routes) ? rawCross.routes.length : 0)),
    routes: Array.isArray(rawCross?.routes)
      ? rawCross.routes.map((route) => ({
          sourceJurisdiction: String(route.sourceJurisdiction || ''),
          targetJurisdiction: String(route.targetJurisdiction || ''),
          sourceMmEntityId: String(route.sourceMmEntityId || '').toLowerCase(),
          targetMmEntityId: String(route.targetMmEntityId || '').toLowerCase(),
          sourceHubEntityId: String(route.sourceHubEntityId || '').toLowerCase(),
          targetHubEntityId: String(route.targetHubEntityId || '').toLowerCase(),
          offers: Number(route.offers || 0),
          ready: route.ready === true,
          depthReady: route.depthReady === true,
          blockers: Array.isArray(route.blockers) ? route.blockers : [],
          pairs: Array.isArray(route.pairs)
            ? route.pairs.map((pair) => ({
                pairId: String(pair.pairId || ''),
                offers: Number(pair.offers || 0),
                ready: pair.ready === true,
                depthReady: pair.depthReady === true,
                expectedOffers: Number(pair.expectedOffers || 0),
                sourceTokenIds: Array.isArray(pair.sourceTokenIds)
                  ? pair.sourceTokenIds.map(Number).filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
                  : [],
                targetTokenIds: Array.isArray(pair.targetTokenIds)
                  ? pair.targetTokenIds.map(Number).filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
                  : [],
              }))
            : [],
        }))
      : [],
  };

  const hubs = hubEntityIds.map((hubEntityId) => {
    const existing = hubsById.get(hubEntityId);
    const offers = existing?.offers ?? 0;
    const depthReady = existing?.depthReady === true ||
      (!!expectedOffersPerHub && offers === expectedOffersPerHub);
    const ready = existing?.ready === true || depthReady;
    return {
      hubEntityId,
      offers,
      ready,
      depthReady,
      blockers: existing?.blockers ?? [],
      pairs: existing?.pairs ?? [],
    };
  });

  const childReady = marketMakerHealth?.marketMaker?.ok === true;
  const crossReady = Boolean(rawCross) && cross.ok;
  const failure = resolveMarketMakerFailure({
    mmEnabled,
    marketMakerActive,
    marketMakerHealth,
    expectedHubCount,
    startupPhase,
    childReady,
    hubs,
    crossReady,
  });
  const ok = !mmEnabled || failure === null;

  return {
    enabled: mmEnabled,
    ok,
    failure,
    entityId,
    startupPhase,
    quiescence: marketMakerHealth?.marketMaker?.quiescence ?? null,
    expectedOffersPerHub,
    expectedOffersPerPair: Number(marketMakerHealth?.marketMaker?.expectedOffersPerPair || 0),
    cross,
    hubs,
  };
};
