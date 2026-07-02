import { describe, expect, test } from 'bun:test';
import { normalizeMarketMakerHealthPayload } from '../orchestrator/market-maker-health-payload';
import type { MarketMakerHealthPayload } from '../orchestrator/orchestrator-types';

describe('market maker health payload normalization', () => {
  test('wraps raw /api/health/full market maker health for parent aggregation', () => {
    const normalized = normalizeMarketMakerHealthPayload({
      ok: false,
      entityId: '0xmm',
      runtimeId: '0xruntime',
      enabled: true,
      expectedOffersPerHub: 60,
      expectedOffersPerPair: 3,
      hubs: [{
        hubEntityId: '0xhub',
        offers: 60,
        ready: true,
        depthReady: true,
        blockers: [],
        pairs: [{ pairId: '1/2', offers: 3, ready: true, depthReady: true, expectedOffers: 3 }],
      }],
      cross: {
        applicable: true,
        ok: false,
        expectedRoutes: 6,
        expectedOffersPerRoute: 45,
        expectedOffersPerPair: 3,
        routeCount: 6,
        routes: [{
          sourceJurisdiction: 'Testnet',
          targetJurisdiction: 'Tron',
          sourceHubEntityId: '0xsource',
          targetHubEntityId: '0xtarget',
          offers: 30,
          ready: true,
          depthReady: false,
          blockers: [],
          pairs: [{ pairId: 'cross', offers: 2, ready: true, depthReady: false, expectedOffers: 3 }],
        }],
      },
    });

    expect(normalized?.marketMaker?.hubs).toHaveLength(1);
    expect(normalized?.marketMaker?.expectedOffersPerHub).toBe(60);
    expect(normalized?.marketMaker?.cross?.expectedRoutes).toBe(6);
    expect(normalized?.marketMaker?.cross?.routes).toHaveLength(1);
    expect(normalized?.marketMaker?.cross?.routes[0]?.depthReady).toBe(false);
  });

  test('keeps wrapped /api/health payload shape intact', () => {
    const wrapped: MarketMakerHealthPayload = {
      ok: true,
      entityId: '0xmm',
      marketMaker: {
        enabled: true,
        ok: true,
        entityId: '0xmm',
        expectedOffersPerHub: 60,
        expectedOffersPerPair: 3,
        hubs: [],
        cross: {
          applicable: false,
          ok: true,
          expectedRoutes: 0,
          expectedOffersPerRoute: 0,
          expectedOffersPerPair: 0,
          routes: [],
        },
      },
    };

    expect(normalizeMarketMakerHealthPayload(wrapped)).toBe(wrapped);
  });
});
