import { describe, expect, test } from 'bun:test';

import { CAPABILITIES } from '../../../frontend/config/capabilities';
import { SURFACE_IDS, resolveRouteOwner } from '../../../frontend/config/surfaces';

describe('frontend capability inventory', () => {
  test('uses stable unique capability identifiers', () => {
    const ids = CAPABILITIES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toBe(true);
  });

  test('gives every application at least one capability', () => {
    for (const surfaceId of SURFACE_IDS) {
      expect(CAPABILITIES.some(({ owner }) => owner === surfaceId)).toBe(true);
    }
  });

  test('keeps representative routes with their capability owner', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.routes.length).toBeGreaterThan(0);
      for (const route of capability.routes) {
        expect(resolveRouteOwner(route)).toBe(capability.owner);
      }
    }
  });

  test('records source, behavior, and valid migration status for every capability', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.currentSources.length).toBeGreaterThan(0);
      expect(capability.behavior.length).toBeGreaterThan(0);
      expect(['unstarted', 'in_progress', 'implemented', 'verified', 'blocked']).toContain(
        capability.status,
      );
    }
  });

  test('records the implemented site capability without claiming production cutover', () => {
    const site = CAPABILITIES.find(({ id }) => id === 'site-public-information');
    expect(site?.status).toBe('implemented');
    expect(site?.currentSources).toContain('frontend/apps/site/src/landing-page.tsx');
    expect(site?.currentSources).toContain('frontend/apps/site/src/install-page.tsx');
    expect(site?.currentSources).toContain('frontend/apps/site/src/rcpan-page.tsx');
    expect(site?.currentSources).toContain('frontend/apps/site/src/unicast-page.tsx');
    expect(site?.currentSources).toContain('frontend/apps/site/src/releases-page.tsx');
    expect(site?.currentSources).toContain('frontend/apps/site/src/reviews-page.tsx');
    expect(site?.currentSources).toContain('frontend/apps/site/src/market-cap-page.tsx');
    expect(CAPABILITIES.filter(({ id }) => ![
      'site-public-information',
      'docs-reader',
      'wallet-shell-and-identity',
      'wallet-browser-lifecycle',
    ].includes(id)).every(
      ({ status }) => status === 'unstarted',
    )).toBe(true);
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.status).toBe('in_progress');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-browser-lifecycle')?.status).toBe('in_progress');
  });

  test('records the implemented docs reader and its generated-output boundary', () => {
    const docs = CAPABILITIES.find(({ id }) => id === 'docs-reader');
    expect(docs?.status).toBe('implemented');
    expect(docs?.routes).toEqual(['/docs']);
    expect(docs?.currentSources).toContain('frontend/apps/docs/src/docs-app.tsx');
    expect(docs?.behavior).toContain('catalog navigation and search');
    expect(docs?.behavior).toContain('deterministic docs and llms outputs');
  });
});
