import { classifyRuntimeMarketMakerFailure } from '../../../protocol/errors/failure-taxonomy';
import {
  isExactMarketSnapshotOrderDepth,
  type MarketSnapshotOrderDepth,
} from './market-maker-aggregated-health';
import type { AggregatedHealth } from '../../orchestrator-types';

type MarketMakerHealth = AggregatedHealth['marketMaker'];
type FetchMarketSnapshots = (
  hubEntityId: string,
  pairIds: string[],
) => Promise<Map<string, MarketSnapshotOrderDepth>>;

const missingDepth = (): MarketSnapshotOrderDepth => ({ bidOffers: 0, askOffers: 0 });

type PublicSnapshotCache = Map<string, Map<string, MarketSnapshotOrderDepth>>;
type CrossExpectedDepth = Map<string, Map<string, MarketSnapshotOrderDepth>>;

const addCrossExpectedDepth = (
  expectedByHub: CrossExpectedDepth,
  hubEntityId: string,
  pairId: string,
  expected: MarketSnapshotOrderDepth,
): void => {
  if (!hubEntityId || !pairId) return;
  const byPair = expectedByHub.get(hubEntityId) ?? new Map<string, MarketSnapshotOrderDepth>();
  const current = byPair.get(pairId) ?? missingDepth();
  // The same canonical book can appear in several directional route-health
  // projections. Those are views of the same ten price levels, not additive
  // publishers. Max composes the configured bid/ask ownership without
  // multiplying a physical book merely because several routes observe it.
  byPair.set(pairId, {
    bidOffers: Math.max(current.bidOffers, expected.bidOffers),
    askOffers: Math.max(current.askOffers, expected.askOffers),
  });
  expectedByHub.set(hubEntityId, byPair);
};

const buildCrossExpectedDepth = (marketMaker: MarketMakerHealth): CrossExpectedDepth => {
  const expectedByHub: CrossExpectedDepth = new Map();
  for (const route of marketMaker.cross.routes) {
    for (const pair of route.pairs ?? []) {
      const expectedOffers = Number(pair.expectedOffers || 0);
      const expectedBidOffers = Number(pair.expectedBidOffers || 0);
      const expectedAskOffers = Number(pair.expectedAskOffers || 0);
      const countsAreCanonical = [expectedOffers, expectedBidOffers, expectedAskOffers]
        .every(value => Number.isSafeInteger(value) && value >= 0) &&
        expectedOffers > 0 && expectedBidOffers + expectedAskOffers === expectedOffers;
      // Missing directional counts are not inferred. A health payload
      // is protocol evidence for startup; accepting ambiguous totals would
      // reintroduce the symmetric-book substitution this gate exists to remove.
      if (!countsAreCanonical) continue;
      addCrossExpectedDepth(expectedByHub, pair.bookOwnerEntityId ?? '', pair.pairId, {
        bidOffers: expectedBidOffers,
        askOffers: expectedAskOffers,
      });
    }
  }
  return expectedByHub;
};

const addSnapshotRequest = (
  requests: Map<string, Set<string>>,
  hubEntityId: string,
  pairId: string,
): void => {
  if (!hubEntityId || !pairId) return;
  const pairIds = requests.get(hubEntityId) ?? new Set<string>();
  pairIds.add(pairId);
  requests.set(hubEntityId, pairIds);
};

const fetchPublicSnapshotCache = async (
  marketMaker: MarketMakerHealth,
  fetchSnapshots: FetchMarketSnapshots,
): Promise<PublicSnapshotCache> => {
  const requests = new Map<string, Set<string>>();
  for (const hub of marketMaker.hubs) {
    for (const pair of hub.pairs) addSnapshotRequest(requests, hub.hubEntityId, pair.pairId);
  }
  for (const route of marketMaker.cross.routes) {
    for (const pair of route.pairs ?? []) {
      // Cross-j routes may start on either jurisdiction, but their signed
      // route chooses one canonical bookOwnerEntityId. The target Account is
      // a settlement replica, not a second public book. Querying source and
      // target Hubs invents a replication invariant the protocol does not
      // have and reports healthy canonical books as empty.
      addSnapshotRequest(requests, pair.bookOwnerEntityId ?? '', pair.pairId);
    }
  }
  return new Map(await Promise.all(Array.from(requests, async ([hubEntityId, pairIds]) => [
    hubEntityId,
    await fetchSnapshots(hubEntityId, Array.from(pairIds).sort()),
  ] as const)));
};

const readDepth = (
  snapshots: PublicSnapshotCache,
  hubEntityId: string,
  pairId: string,
): MarketSnapshotOrderDepth => snapshots.get(hubEntityId)?.get(pairId) ?? missingDepth();

const enrichSameJurisdictionHubs = async (
  marketMaker: MarketMakerHealth,
  snapshots: PublicSnapshotCache,
): Promise<MarketMakerHealth['hubs']> => marketMaker.hubs.map((hub) => {
  const pairs = hub.pairs.map((pair) => {
    // Same-j expectedOffers counts both sides; public depth is exact only when
    // half are bids and half are asks, never when merely the total matches.
    const expectedPerSide = Math.floor(Number(pair.expectedOffers || 0) / 2);
    const observed = readDepth(snapshots, hub.hubEntityId, pair.pairId);
    const snapshotDepthExact = isExactMarketSnapshotOrderDepth(observed, expectedPerSide);
    return {
      ...pair,
      bidOffers: observed.bidOffers,
      askOffers: observed.askOffers,
      snapshotDepthExact,
      ready: pair.ready === true && snapshotDepthExact,
      depthReady: pair.depthReady === true && snapshotDepthExact,
    };
  });
  const exact = pairs.length > 0 && pairs.every(pair => pair.snapshotDepthExact);
  return {
    ...hub,
    pairs,
    ready: hub.ready === true && exact,
    depthReady: hub.depthReady === true && exact,
  };
});

const enrichCrossRoutes = async (
  marketMaker: MarketMakerHealth,
  snapshots: PublicSnapshotCache,
  expectedDepth: CrossExpectedDepth,
): Promise<MarketMakerHealth['cross']['routes']> =>
  marketMaker.cross.routes.map((route) => {
    const pairs = (route.pairs ?? []).map((pair) => {
      const bookOwnerEntityId = pair.bookOwnerEntityId ?? '';
      const observed = readDepth(snapshots, bookOwnerEntityId, pair.pairId);
      const expected = expectedDepth.get(bookOwnerEntityId)?.get(pair.pairId) ?? missingDepth();
      // Cross-j liquidity is directional. A source-base route owns asks; the
      // reverse route owns bids. Compare both public sides with the union of
      // configured directions so one-way books pass, while an unconfigured
      // extra side still fails loudly instead of hiding stale liquidity.
      const snapshotDepthExact = expected.bidOffers + expected.askOffers > 0 &&
        observed.bidOffers === expected.bidOffers &&
        observed.askOffers === expected.askOffers;
      return {
        ...pair,
        bidOffers: observed.bidOffers,
        askOffers: observed.askOffers,
        snapshotDepthExact,
        ready: pair.ready === true && snapshotDepthExact,
        depthReady: pair.depthReady === true && snapshotDepthExact,
      };
    });
    const exact = pairs.length > 0 && pairs.every(pair => pair.snapshotDepthExact);
    return {
      ...route,
      pairs,
      ready: route.ready === true && exact,
      depthReady: route.depthReady === true && exact,
    };
  });

export const buildPublicMarketMakerHealth = async (
  marketMaker: MarketMakerHealth,
  fetchSnapshots: FetchMarketSnapshots,
): Promise<MarketMakerHealth> => {
  if (!marketMaker.enabled) return marketMaker;
  // One batched request per Hub avoids an O(routes) HTTP stampede during
  // startup. The old parallel fan-out could time out every large cross-book
  // response while the exact same persisted books were already healthy.
  const snapshots = await fetchPublicSnapshotCache(marketMaker, fetchSnapshots);
  const crossExpectedDepth = buildCrossExpectedDepth(marketMaker);
  const [hubs, routes] = await Promise.all([
    enrichSameJurisdictionHubs(marketMaker, snapshots),
    enrichCrossRoutes(marketMaker, snapshots, crossExpectedDepth),
  ]);
  const cross = {
    ...marketMaker.cross,
    routes,
    ok: marketMaker.cross.ok === true && routes.every(route => route.depthReady === true),
  };
  const publicDepthReady = hubs.length > 0 && hubs.every(hub => hub.depthReady === true) &&
    (!cross.applicable || cross.ok === true);
  return {
    ...marketMaker,
    hubs,
    cross,
    ok: marketMaker.ok === true && publicDepthReady,
    failure: publicDepthReady
      ? marketMaker.failure
      : classifyRuntimeMarketMakerFailure(
          'MARKET_MAKER_PUBLIC_DEPTH_NOT_READY',
          'authoritative Hub snapshots are not exact on every required bid and ask side',
        ),
  };
};
