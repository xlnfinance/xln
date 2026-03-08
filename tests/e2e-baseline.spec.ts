/**
 * E2E baseline bootstrap for the shared test network.
 *
 * Flow and goals:
 * 1. Trigger the cold reset endpoint for the shared E2E stack.
 * 2. Wait until three separate hub runtimes are back online.
 * 3. Verify the mutual hub mesh is re-established.
 * 4. Verify bootstrap reserve funding exists for every required baseline entity.
 *
 * This test exists to prove that every other E2E spec starts from one honest baseline:
 * separate runtimes, connected over relay/P2P, with reserves and hub mesh ready.
 */
import { test, expect } from '@playwright/test';
import { resetProdServer } from './utils/e2e-baseline';

const LONG_E2E = process.env.E2E_LONG === '1';

test.describe('E2E Baseline Bootstrap', () => {
  // This test proves the shared cold-reset baseline is honest and minimal: three separate hubs
  // come back online, their mutual mesh credit is restored, and bootstrap reserves are ready.
  test('cold reset provisions the 3-hub mesh baseline and reserves', async ({ page }) => {
    test.setTimeout(LONG_E2E ? 240_000 : 120_000);

    const health = await resetProdServer(page, {
      timeoutMs: LONG_E2E ? 240_000 : 120_000,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });

    const hubIds = health.hubMesh?.hubIds ?? [];
    expect(hubIds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(hubIds.map((hubId) => hubId.toLowerCase())).size).toBeGreaterThanOrEqual(3);
    expect(health.bootstrapReserves?.ok).toBe(true);
    expect((health.bootstrapReserves?.entities ?? []).length).toBeGreaterThanOrEqual(3);
    expect((health.bootstrapReserves?.entities ?? []).every((entity) => entity.ready)).toBe(true);
  });
});
