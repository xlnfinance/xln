import type { AggregatedHealth, MarketMakerHealthPayload } from './orchestrator-types';

type AggregatedMarketMakerHealth = AggregatedHealth['marketMaker'];

type BuildAggregatedMarketMakerHealthParams = {
  mmEnabled: boolean;
  marketMakerActive: boolean;
  marketMakerHealth: MarketMakerHealthPayload | null;
  hubEntityIds: string[];
  expectedHubCount: number;
  entityId: string | null;
  startupPhase: string | null;
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
      (!!expectedOffersPerHub && offers >= expectedOffersPerHub);
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
  const ok = !mmEnabled
    ? true
    : marketMakerActive &&
      childReady &&
      hubs.length === expectedHubCount &&
      hubs.every((hub) => hub.depthReady) &&
      crossReady;

  return {
    enabled: mmEnabled,
    ok,
    entityId,
    startupPhase,
    expectedOffersPerHub,
    expectedOffersPerPair: Number(marketMakerHealth?.marketMaker?.expectedOffersPerPair || 0),
    cross,
    hubs,
  };
};
