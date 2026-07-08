import { describe, expect, test } from 'bun:test';
import { buildAggregatedMarketMakerHealth } from '../orchestrator/market-maker-aggregated-health';
import type { MarketMakerHealthPayload } from '../orchestrator/orchestrator-types';

describe('aggregated market maker health', () => {
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
});
