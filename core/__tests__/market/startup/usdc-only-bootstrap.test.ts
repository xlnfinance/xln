import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import { createUsdcFixture } from './usdc-session/fixture';

test('USDC-only MM opens Accounts and finalizes both Cross-J books without same-J markets', async () => {
  const fixture = await createUsdcFixture();
  try {
    const health = requireBoundaryRecord(await fixture.health(), 'TEST_HEALTH_MISSING');
    const maker = requireBoundaryRecord(health['marketMaker'], 'TEST_MAKER_MISSING');
    expect(maker['enabled']).toBeTrue();
    expect(maker['expectedOffersPerHub']).toBe(0);
    const cross = requireBoundaryRecord(maker['cross'], 'TEST_CROSS_MISSING');
    expect(cross['applicable']).toBeTrue();
    expect(cross['ok']).toBeTrue();
    expect(cross['expectedRoutes']).toBe(2);
    expect(Array.isArray(cross['routes'])).toBeTrue();
    if (!Array.isArray(cross['routes'])) throw new Error('TEST_ROUTES_MISSING');
    expect(cross['routes']).toHaveLength(2);
    for (const raw of cross['routes']) {
      const route = requireBoundaryRecord(raw, 'TEST_ROUTE_INVALID');
      expect(route['depthReady']).toBeTrue();
      expect(Number(route['offers'])).toBeGreaterThan(0);
      expect(route['blockers']).toEqual([]);
    }
    writeFileSync(join(fixture.root, 'health.json'), safeStringify(health, 2));
    console.log(`USDC_ONLY_BOOTSTRAP_EVIDENCE:${fixture.root}`);
  } finally {
    await fixture.close();
  }
}, 180_000);
