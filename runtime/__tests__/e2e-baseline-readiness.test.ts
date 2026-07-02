import { describe, expect, test } from 'bun:test';

const loadBaselineHelpers = async () => {
  process.env['E2E_BASE_URL'] = process.env['E2E_BASE_URL'] || 'https://localhost:1';
  process.env['E2E_API_BASE_URL'] = process.env['E2E_API_BASE_URL'] || 'https://localhost:1';
  return await import('../../tests/utils/e2e-baseline');
};

const readyOptions = {
  apiBaseUrl: 'https://localhost:1',
  timeoutMs: 240_000,
  pollMs: 500,
  requireHubMesh: true,
  requireMarketMaker: true,
  requireCustody: true,
  minHubCount: 3,
  autoResetGraceMs: 5_000,
  forceReset: false,
  allowAutoReset: false,
};

const readyHealth = {
  timestamp: Date.now(),
  systemOk: true,
  degraded: [],
  reset: { inProgress: false },
  hubMesh: { ok: true, hubIds: ['h1', 'h2', 'h3'], pairs: [] },
  marketMaker: {
    enabled: true,
    ok: true,
    startupPhase: 'offers-ready',
    entityId: '0xmm',
    hubs: [],
    cross: { ok: true, applicable: true, expectedRoutes: 1, routes: [] },
  },
  custody: { enabled: true, ok: true, entityId: '0xcustody' },
  bootstrapReserves: { ok: true, requiredTokenCount: 1, entityCount: 4, entities: [] },
};

describe('e2e baseline readiness', () => {
  test('market-maker e2e waits for explicit orchestrator usable-network verdict', async () => {
    const { isBaselineReady } = await loadBaselineHelpers();

    expect(isBaselineReady(readyHealth, readyOptions)).toBe(true);
    expect(isBaselineReady({ ...readyHealth, systemOk: false, degraded: ['marketMaker'] }, readyOptions)).toBe(false);
    expect(isBaselineReady({
      ...readyHealth,
      marketMaker: { ...readyHealth.marketMaker, startupPhase: 'bootstrap-cross' },
    }, readyOptions)).toBe(false);
  });

  test('public prod health readiness uses summary counters when private ids are redacted', async () => {
    const { isBaselineReady } = await loadBaselineHelpers();

    expect(isBaselineReady({
      timestamp: 1,
      systemOk: true,
      degraded: [],
      reset: { inProgress: false },
      hubMesh: { ok: true, hubCount: 3, pairCount: 3, hubIds: [], pairs: [] },
      marketMaker: {
        enabled: true,
        ok: true,
        startupPhase: 'offers-ready',
        hubCount: 3,
        hubs: [],
        cross: { ok: true, applicable: true, expectedRoutes: 6, routeCount: 6, routes: [] },
      },
      custody: { enabled: true, ok: true },
      bootstrapReserves: { ok: true, targetMet: true, requiredTokenCount: 3, entityCount: 6, entities: [] },
      hubs: [
        { name: 'H1', online: true },
        { name: 'H2', online: true },
        { name: 'H3', online: true },
      ],
    }, readyOptions)).toBe(true);
  });

  test('no-reset prod e2e waits the full timeout before failing readiness', async () => {
    const { resolveE2EBaselineInitialWaitMs } = await loadBaselineHelpers();

    expect(resolveE2EBaselineInitialWaitMs(readyOptions)).toBe(240_000);
    expect(resolveE2EBaselineInitialWaitMs({ ...readyOptions, allowAutoReset: true })).toBe(5_000);
  });

  test('default baseline accepts ready market maker and reset body does not disable it', async () => {
    const { buildE2EResetBody, isBaselineReady } = await loadBaselineHelpers();

    const defaultOptions = { ...readyOptions, requireMarketMaker: false, requireCustody: false };
    expect(isBaselineReady(readyHealth, defaultOptions)).toBe(true);
    expect(buildE2EResetBody(defaultOptions)).toEqual({ confirm: 'RESET_MESH_STATE' });
    expect(buildE2EResetBody({ ...defaultOptions, requireMarketMaker: true })).toEqual({
      confirm: 'RESET_MESH_STATE',
      requireMarketMaker: true,
      enableMarketMaker: true,
    });
  });
});
