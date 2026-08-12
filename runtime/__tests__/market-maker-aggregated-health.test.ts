import { describe, expect, test } from 'bun:test';
import {
  buildAggregatedMarketMakerHealth,
  countMarketSnapshotOrderDepth,
  isExactMarketSnapshotOrderDepth,
  mergeMarketSnapshotOrderDepth,
} from '../orchestrator/market-maker/health/market-maker-aggregated-health';
import { buildPublicMarketMakerHealth } from '../orchestrator/market-maker/health/market-maker-public-health';
import type { MarketMakerHealthPayload } from '../orchestrator/orchestrator-types';

describe('aggregated market maker health', () => {
  test('treats configured depth as an exact per-side invariant', () => {
    const exact = countMarketSnapshotOrderDepth({
      format: 'exact-price-levels',
      hubEntityId: '0xhub',
      pairId: '1/2',
      depth: 10,
      displayDecimals: 4,
      priceScale: '1000000',
      bucketWidthTicks: null,
      bids: [{ price: '1', size: '1', total: '1', orderCount: 4 }],
      asks: [
        { price: '2', size: '1', total: '1', orderCount: 6 },
        { price: '3', size: '1', total: '1', orderCount: 4 },
      ],
      spread: null,
      spreadPercent: '-',
      source: 'orderbookExt',
      updatedAt: 1,
      entityHeight: 1,
      entityStateHash: null,
      hubUpdatedAt: 1,
    });
    expect(exact).toEqual({ bidOffers: 4, askOffers: 10 });
    expect(isExactMarketSnapshotOrderDepth(exact, 10)).toBe(false);
    expect(isExactMarketSnapshotOrderDepth(
      mergeMarketSnapshotOrderDepth(exact, { bidOffers: 10, askOffers: 9 }),
      10,
    )).toBe(true);
    expect(isExactMarketSnapshotOrderDepth({ bidOffers: 10, askOffers: 20 }, 10)).toBe(false);
  });

  test('preserves full-depth diagnostics from child health', () => {
    const health: MarketMakerHealthPayload = {
      entityId: '0xmm',
      marketMaker: {
        enabled: true,
        ok: false,
        entityId: '0xmm',
        expectedOffersPerHub: 60,
        expectedOffersPerPair: 3,
        hubs: [{
          hubEntityId: '0xhub1',
          offers: 59,
          ready: true,
          depthReady: false,
          blockers: [{ reason: 'pending-frame', height: 7 }],
          pairs: [{
            pairId: '1/2',
            offers: 2,
            ready: true,
            depthReady: false,
            expectedOffers: 3,
          }],
        }],
        cross: {
          applicable: true,
          ok: false,
          expectedRoutes: 1,
          expectedOffersPerRoute: 3,
          expectedOffersPerPair: 3,
          routeCount: 1,
          routes: [{
            sourceJurisdiction: 'Testnet',
            targetJurisdiction: 'Tron',
            sourceMmEntityId: '0xmm',
            targetMmEntityId: '0xmmtron',
            sourceHubEntityId: '0xhub1',
            targetHubEntityId: '0xhub2',
            offers: 2,
            ready: true,
            depthReady: false,
            blockers: [{ reason: 'depth-short', expectedOffers: 3, offers: 2 }],
            pairs: [{
              pairId: 'cross-1',
              bookOwnerEntityId: '0xhub1',
              offers: 2,
              ready: true,
              depthReady: false,
              expectedOffers: 3,
              sourceTokenIds: [1, 0, Number.NaN, 2],
              targetTokenIds: [3, -1, 4],
            }],
          }],
        },
      },
    };

    const aggregated = buildAggregatedMarketMakerHealth({
      mmEnabled: true,
      marketMakerActive: true,
      marketMakerHealth: health,
      hubEntityIds: ['0xhub1'],
      expectedHubCount: 1,
      entityId: '0xmm',
      startupPhase: 'offers-ready',
    });

    expect(aggregated.ok).toBe(false);
    expect(aggregated.failure).toMatchObject({
      category: 'TransientRace',
      code: 'MARKET_MAKER_CHILD_NOT_READY',
      retryable: true,
      fatal: false,
    });
    expect(aggregated.hubs[0]?.depthReady).toBe(false);
    expect(aggregated.hubs[0]?.blockers).toEqual([{ reason: 'pending-frame', height: 7 }]);
    expect(aggregated.hubs[0]?.pairs[0]?.expectedOffers).toBe(3);
    expect(aggregated.hubs[0]?.pairs[0]?.depthReady).toBe(false);
    expect(aggregated.cross.routes[0]?.depthReady).toBe(false);
    expect(aggregated.cross.routes[0]?.blockers).toEqual([{ reason: 'depth-short', expectedOffers: 3, offers: 2 }]);
    expect(aggregated.cross.routes[0]?.pairs?.[0]?.expectedOffers).toBe(3);
    expect(aggregated.cross.routes[0]?.pairs?.[0]?.depthReady).toBe(false);
    expect(aggregated.cross.routes[0]?.pairs?.[0]?.sourceTokenIds).toEqual([1, 2]);
    expect(aggregated.cross.routes[0]?.pairs?.[0]?.targetTokenIds).toEqual([3, 4]);
  });

  test('reports configured market maker as enabled even while child is not active', () => {
    const aggregated = buildAggregatedMarketMakerHealth({
      mmEnabled: true,
      marketMakerActive: false,
      marketMakerHealth: null,
      hubEntityIds: ['0xhub1'],
      expectedHubCount: 1,
      entityId: null,
      startupPhase: null,
    });

    expect(aggregated.enabled).toBe(true);
    expect(aggregated.ok).toBe(false);
    expect(aggregated.failure).toMatchObject({
      category: 'TransientRace',
      code: 'MARKET_MAKER_CHILD_INACTIVE',
      retryable: true,
      fatal: false,
    });
  });

  test('blocks readiness on startup phase before offer checks look healthy', () => {
    const health: MarketMakerHealthPayload = {
      marketMaker: {
        enabled: true,
        ok: true,
        entityId: '0xmm',
        expectedOffersPerHub: 1,
        hubs: [{
          hubEntityId: '0xhub1',
          offers: 1,
          ready: true,
          depthReady: true,
          pairs: [],
        }],
        cross: {
          applicable: true,
          ok: true,
          expectedRoutes: 1,
          expectedOffersPerRoute: 1,
          expectedOffersPerPair: 1,
          routeCount: 1,
          routes: [],
        },
      },
    };

    const aggregated = buildAggregatedMarketMakerHealth({
      mmEnabled: true,
      marketMakerActive: true,
      marketMakerHealth: health,
      hubEntityIds: ['0xhub1'],
      expectedHubCount: 1,
      entityId: '0xmm',
      startupPhase: 'bootstrap-cross',
    });

    expect(aggregated.ok).toBe(false);
    expect(aggregated.failure).toMatchObject({
      category: 'TransientRace',
      code: 'MARKET_MAKER_STARTUP_PHASE_NOT_READY',
      retryable: true,
      fatal: false,
    });
  });

  test('rejects split public depth even when child accounts report complete offers', async () => {
    const health: MarketMakerHealthPayload = {
      marketMaker: {
        enabled: true,
        ok: true,
        entityId: '0xmm',
        expectedOffersPerHub: 20,
        hubs: ['0xhub1', '0xhub2'].map(hubEntityId => ({
          hubEntityId,
          offers: 20,
          ready: true,
          depthReady: true,
          pairs: [{ pairId: '1/2', offers: 20, ready: true, depthReady: true, expectedOffers: 20 }],
        })),
        cross: {
          applicable: true,
          ok: true,
          expectedRoutes: 1,
          expectedOffersPerRoute: 10,
          expectedOffersPerPair: 10,
          routeCount: 1,
          routes: [{
            sourceJurisdiction: 'Testnet',
            targetJurisdiction: 'Tron',
            sourceHubEntityId: '0xhub1',
            targetHubEntityId: '0xhub2',
            offers: 10,
            ready: true,
            depthReady: true,
            pairs: [{
              pairId: 'cross:a:1/b:2',
              bookOwnerEntityId: '0xhub1',
              offers: 10,
              ready: true,
              depthReady: true,
              expectedOffers: 10,
              expectedBidOffers: 0,
              expectedAskOffers: 10,
            }],
          }],
        },
      },
    };
    const internal = buildAggregatedMarketMakerHealth({
      mmEnabled: true,
      marketMakerActive: true,
      marketMakerHealth: health,
      hubEntityIds: ['0xhub1', '0xhub2'],
      expectedHubCount: 2,
      entityId: '0xmm',
      startupPhase: 'offers-ready',
    });
    const publicHealth = await buildPublicMarketMakerHealth(internal, async (hubEntityId, pairIds) =>
      new Map(pairIds.map(pairId => [
        pairId,
        pairId === '1/2'
          ? { bidOffers: 10, askOffers: hubEntityId === '0xhub1' ? 10 : 0 }
          : { bidOffers: 0, askOffers: 10 },
      ])),
    );

    expect(publicHealth.ok).toBe(false);
    expect(publicHealth.hubs[1]?.pairs[0]).toMatchObject({
      bidOffers: 10,
      askOffers: 0,
      snapshotDepthExact: false,
      depthReady: false,
    });
    expect(publicHealth.failure).toMatchObject({ code: 'MARKET_MAKER_PUBLIC_DEPTH_NOT_READY' });
  });

  test('reads each Hub once and accepts cross depth only from its canonical book owner', async () => {
    const internal = buildAggregatedMarketMakerHealth({
      mmEnabled: true,
      marketMakerActive: true,
      marketMakerHealth: {
        marketMaker: {
          enabled: true,
          ok: true,
          entityId: '0xmm',
          expectedOffersPerHub: 20,
          hubs: ['0xhub1', '0xhub2'].map(hubEntityId => ({
            hubEntityId,
            offers: 20,
            ready: true,
            depthReady: true,
            pairs: [{ pairId: '1/2', offers: 20, ready: true, depthReady: true, expectedOffers: 20 }],
          })),
          cross: {
            applicable: true,
            ok: true,
            expectedRoutes: 1,
            expectedOffersPerRoute: 10,
            expectedOffersPerPair: 10,
            routes: [{
              sourceJurisdiction: 'Testnet',
              targetJurisdiction: 'Tron',
              sourceHubEntityId: '0xhub1',
              targetHubEntityId: '0xhub2',
              offers: 10,
              ready: true,
              depthReady: true,
              pairs: [{
                pairId: 'cross:a:1/b:2',
                bookOwnerEntityId: '0xhub1',
                offers: 10,
                ready: true,
                depthReady: true,
                expectedOffers: 10,
                expectedBidOffers: 0,
                expectedAskOffers: 10,
              }],
            }],
          },
        },
      },
      hubEntityIds: ['0xhub1', '0xhub2'],
      expectedHubCount: 2,
      entityId: '0xmm',
      startupPhase: 'offers-ready',
    });
    const requests = new Map<string, string[]>();
    const publicHealth = await buildPublicMarketMakerHealth(internal, async (hubEntityId, pairIds) => {
      requests.set(hubEntityId, pairIds);
      return new Map(pairIds.map(pairId => [pairId,
        pairId !== 'cross:a:1/b:2'
          ? { bidOffers: 10, askOffers: 10 }
          : hubEntityId === '0xhub1'
            ? { bidOffers: 0, askOffers: 10 }
          : { bidOffers: 0, askOffers: 0 },
      ]));
    });

    expect(publicHealth.ok).toBe(true);
    expect(publicHealth.hubs.every(hub => hub.depthReady)).toBe(true);
    expect(publicHealth.cross.ok).toBe(true);
    expect(requests).toEqual(new Map([
      ['0xhub1', ['1/2', 'cross:a:1/b:2']],
      ['0xhub2', ['1/2']],
    ]));

    const unexpectedBid = await buildPublicMarketMakerHealth(internal, async (_hubEntityId, pairIds) =>
      new Map(pairIds.map(pairId => [pairId,
        pairId === 'cross:a:1/b:2'
          ? { bidOffers: 1, askOffers: 10 }
          : { bidOffers: 10, askOffers: 10 },
      ])),
    );
    expect(unexpectedBid.cross.ok).toBe(false);
    expect(unexpectedBid.cross.routes[0]?.pairs?.[0]).toMatchObject({ snapshotDepthExact: false });

    const malformedDirectionCounts = {
      ...internal,
      cross: {
        ...internal.cross,
        routes: internal.cross.routes.map(route => ({
          ...route,
          pairs: route.pairs?.map(pair => ({ ...pair, expectedBidOffers: 0, expectedAskOffers: 9 })),
        })),
      },
    };
    const malformed = await buildPublicMarketMakerHealth(malformedDirectionCounts, async (_hubEntityId, pairIds) =>
      new Map(pairIds.map(pairId => [pairId, { bidOffers: 0, askOffers: 9 }])),
    );
    expect(malformed.cross.ok).toBe(false);

    const forwardRoute = internal.cross.routes[0]!;
    const reverseRoute = {
      ...forwardRoute,
      sourceJurisdiction: forwardRoute.targetJurisdiction,
      targetJurisdiction: forwardRoute.sourceJurisdiction,
      pairs: forwardRoute.pairs?.map(pair => ({
        ...pair,
        expectedBidOffers: 10,
        expectedAskOffers: 0,
      })),
    };
    const bidirectional = {
      ...internal,
      cross: {
        ...internal.cross,
        expectedRoutes: 2,
        routeCount: 2,
        routes: [forwardRoute, reverseRoute],
      },
    };
    const mergedDirections = await buildPublicMarketMakerHealth(bidirectional, async (_hubEntityId, pairIds) =>
      new Map(pairIds.map(pairId => [pairId, { bidOffers: 10, askOffers: 10 }])),
    );
    expect(mergedDirections.ok).toBe(true);
    expect(mergedDirections.cross.routes.every(route => route.depthReady)).toBe(true);
  });
});
