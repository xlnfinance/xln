import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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
      failures: [{ category: 'TransientRace', code: 'HUBS_NOT_READY', retryable: true, fatal: false }],
    }, readyOptions)).toBe(true);
    expect(isBaselineReady({
      ...readyHealth,
      failures: [{ category: 'Contradiction', code: 'STORAGE_CORRUPT', retryable: false, fatal: true }],
    }, readyOptions)).toBe(false);
    expect(isBaselineReady({
      ...readyHealth,
      marketMaker: { ...readyHealth.marketMaker, startupPhase: 'bootstrap-cross' },
    }, readyOptions)).toBe(false);
    expect(isBaselineReady({
      ...readyHealth,
      marketMaker: {
        ...readyHealth.marketMaker,
        failure: { category: 'Contradiction', code: 'MARKET_MAKER_CONFIG_INVALID', retryable: false, fatal: true },
      },
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

  test('non-market-maker baseline ignores an enabled but unready market maker', async () => {
    const { buildE2EResetBody, isBaselineReady } = await loadBaselineHelpers();

    const defaultOptions = { ...readyOptions, requireMarketMaker: false, requireCustody: false };
    expect(isBaselineReady({
      ...readyHealth,
      systemOk: false,
      degraded: ['marketMaker'],
      marketMaker: {
        ...readyHealth.marketMaker,
        ok: false,
        startupPhase: 'bootstrap-cross',
      },
    }, defaultOptions)).toBe(true);
    expect(buildE2EResetBody(defaultOptions)).toEqual({
      confirm: 'RESET_MESH_STATE',
      enableMarketMaker: false,
      enableCustody: false,
    });
    expect(buildE2EResetBody({ ...defaultOptions, requireMarketMaker: true })).toEqual({
      confirm: 'RESET_MESH_STATE',
      enableCustody: false,
      requireMarketMaker: true,
      enableMarketMaker: true,
    });
    expect(buildE2EResetBody({ ...defaultOptions, requireCustody: true })).toEqual({
      confirm: 'RESET_MESH_STATE',
      enableMarketMaker: false,
      enableCustody: true,
      requireCustody: true,
    });
  });

  test('playwright owns the first reset so its exact baseline options win', () => {
    const config = readFileSync('playwright.config.ts', 'utf8');
    expect(config).toContain('XLN_MESH_DEFER_INITIAL_RESET=1 SKIP_TYPECHECK=1 bun run dev');
  });

  test('orchestrator health exposes pending reset capabilities while imports require successful activation', () => {
    const orchestrator = readFileSync('runtime/orchestrator/orchestrator.ts', 'utf8');
    expect(orchestrator).toContain('const healthResetOptions = resolveHealthResetOptions(');
    expect(orchestrator).toContain('resolveResetCapabilityHealth(healthResetOptions');
    expect(orchestrator).toContain('mmEnabled: capabilityHealth.marketMakerEnabled');
    expect(orchestrator).toContain('enabled: capabilityHealth.custodyEnabled');
    expect(orchestrator).toContain('activeResetOptions = resolveActiveResetOptions(configuredResetOptions, options)');
    expect(orchestrator).toContain('if (activeResetOptions.enableMarketMaker && marketMakerRuntimeId)');
    expect(orchestrator).toContain('if (activeResetOptions.enableCustody && custodySupport?.daemonAuthSeed');
  });
});
