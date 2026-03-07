import { test, expect } from '@playwright/test';
import { resetProdServer } from './utils/e2e-baseline';

const LONG_E2E = process.env.E2E_LONG === '1';

test.describe('E2E Baseline Bootstrap', () => {
  test('cold reset provisions 3-hub mesh and market maker liquidity', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 120_000);

    const health = await resetProdServer(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: true,
      minHubCount: 3,
    });

    const hubIds = health.hubMesh?.hubIds ?? [];
    expect(hubIds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(hubIds.map((hubId) => hubId.toLowerCase())).size).toBeGreaterThanOrEqual(3);

    expect(health.marketMaker?.ok).toBe(true);
    expect(health.marketMaker?.entityId).toBeTruthy();
    expect((health.marketMaker?.hubs ?? []).length).toBeGreaterThanOrEqual(3);
    expect((health.marketMaker?.hubs ?? []).every((hub) => hub.ready)).toBe(true);
  });
});
