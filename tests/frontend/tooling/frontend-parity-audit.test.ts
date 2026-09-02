import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CAPABILITIES } from '../../../frontend/config/capabilities';
import {
  CAPABILITY_PARITY,
  CUTOVER_CHECKLIST,
  PARITY_GAP_IDS,
  PARITY_GAPS,
  RETAINED_ROUTE_PARITY,
} from '../../../frontend/config/parity-audit';
import { resolveRouteOwner } from '../../../frontend/config/surfaces';
import { buildParityAuditReport } from '../../../frontend/scripts/parity-audit';

const listSveltePages = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? listSveltePages(join(directory, entry.name))
    : entry.name === '+page.svelte' ? [join(directory, entry.name)] : [])
  .toSorted();

describe('WP9 retained-route and capability parity audit', () => {
  test('accounts for every retained Svelte page exactly once', () => {
    const actual = listSveltePages('frontend/src/routes');
    const audited = RETAINED_ROUTE_PARITY.map(({ sveltePage }) => sveltePage).toSorted();
    expect(audited).toEqual(actual);
    expect(new Set(audited).size).toBe(20);
  });

  test('binds implemented routes to their intended owner, sources, and evidence', () => {
    for (const route of RETAINED_ROUTE_PARITY) {
      expect(existsSync(route.sveltePage)).toBe(true);
      if (route.implementation === 'missing') {
        expect(route.reactSource).toBeNull();
        expect(route.focusedTests).toEqual([]);
      } else {
        expect(route.reactSource && existsSync(route.reactSource)).toBe(true);
        for (const path of route.focusedTests) expect(existsSync(path)).toBe(true);
      }
      for (const path of route.browserTests) expect(existsSync(path)).toBe(true);
      expect(resolveRouteOwner(route.representativePath)).toBe(route.intendedOwner);
    }
  });

  test('keeps browser claims and gap references exact', () => {
    const gapIds = new Set(PARITY_GAPS.map(({ id }) => id));
    expect(PARITY_GAPS.map(({ id }) => id)).toEqual(PARITY_GAP_IDS);
    for (const route of RETAINED_ROUTE_PARITY) {
      expect(route.browserEvidence === 'missing' ? route.browserTests.length === 0 : route.browserTests.length > 0).toBe(true);
      for (const gapId of route.gapIds) expect(gapIds.has(gapId)).toBe(true);
    }
    for (const gap of PARITY_GAPS) {
      expect(gap.nextSlice.length).toBeGreaterThan(30);
      for (const routeId of gap.routeIds) {
        expect(RETAINED_ROUTE_PARITY.some(({ id }) => id === routeId)).toBe(true);
      }
      for (const path of gap.evidenceSources) expect(existsSync(path)).toBe(true);
    }
  });

  test('accounts for every capability and preserves the owner gates', () => {
    expect(CAPABILITY_PARITY.map(({ capabilityId }) => capabilityId).toSorted())
      .toEqual(CAPABILITIES.map(({ id }) => id).toSorted());
    for (const capability of CAPABILITY_PARITY) {
      expect(capability.gapIds.length).toBeGreaterThan(0);
      for (const gapId of capability.gapIds) {
        expect(PARITY_GAP_IDS).toContain(gapId);
        expect(PARITY_GAPS.find(({ id }) => id === gapId)?.capabilityIds).toContain(capability.capabilityId);
      }
    }
    expect(CUTOVER_CHECKLIST.filter(({ status }) => status === 'verified').map(({ id }) => id))
      .toEqual(['immutable-candidate-release', 'whole-release-rollback']);
    expect(CUTOVER_CHECKLIST.filter(({ status }) => status === 'owner-authorized-wp10')).toHaveLength(3);
    for (const item of CUTOVER_CHECKLIST) expect(existsSync(item.evidence)).toBe(true);
  });

  test('publishes deterministic counts for the current candidate', () => {
    expect(buildParityAuditReport()).toMatchObject({
      schemaVersion: 1,
      routes: {
        total: 20,
        implementation: { complete: 16, partial: 2, missing: 2 },
        browserEvidence: { covered: 10, partial: 2, missing: 8 },
      },
      capabilities: { total: 12, accounted: 12 },
    });
  });
});
