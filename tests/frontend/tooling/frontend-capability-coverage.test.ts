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
      'wallet-runtime-discovery',
      'wallet-native-and-offline',
    ].includes(id)).every(
      ({ status }) => status === 'unstarted',
    )).toBe(true);
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.status).toBe('in_progress');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-boot-lifecycle.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-deploy-version.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-identity-entry.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-recovery-choice.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-recovery-discovery.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-recovery-rehearsal.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-runtime-bootstrap.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-runtime-consent.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-runtime-opening.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/packages/browser/src/wallet-shell-state.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/src/lib/components/Views/RuntimeCreation.svelte');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.currentSources)
      .toContain('frontend/src/routes/app/+layout.svelte');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('generation-safe local and remote boot sequencing');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('validated deploy-version persistence, reset, and recovery decisions');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('canonical identity-mode selection, sensitive-field clearing, and keyboard navigation');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('deterministic recovery candidate selection, merge ordering, and continuation');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('generation-safe recovery discovery coordination');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('verified mnemonic recovery-rehearsal transitions and reset policy');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('ordered local-pairing, remote-import, and consent bootstrap');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('validated remote consent and embedded cancellation ordering');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('deterministic local unlock and Runtime creation planning');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity')?.behavior)
      .toContain('framework-neutral wallet shell phase precedence');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-browser-lifecycle')?.status).toBe('in_progress');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-browser-lifecycle')?.currentSources)
      .toContain('frontend/packages/browser/src/active-tab-lock.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-browser-lifecycle')?.behavior)
      .toContain('exclusive cross-tab Runtime ownership and quiesced takeover');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.status).toBe('in_progress');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/browser/src/runtime-adapter-session.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-adapter-activation.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-handle.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-query-client.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-query-observer.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-selection.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-catchup.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-loader.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-model.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-projections.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-publication.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-refresh.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-selection.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral RuntimeView snapshot and height transitions');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.currentSources)
      .toContain('frontend/packages/runtime-client/src/runtime-view-state.ts');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('tab-confined Runtime authority and rollback-safe adapter selection');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral Runtime handle identity, permissions, and readiness');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral adapter activation ordering and rollback');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral cached Runtime projection reads and path validation');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral latest-read Runtime query subscriptions and snapshots');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('one-writer latest-intent Runtime selection');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral committed-height RuntimeView catch-up');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral injected RuntimeView loading and outcomes');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral RuntimeView query, pagination, and height model');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral selection-scoped detached RuntimeView projection reads');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral latest-wins RuntimeView publication coordination');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral RuntimeView refresh leases and invalidation');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-runtime-discovery')?.behavior)
      .toContain('framework-neutral RuntimeView selection snapshots and revisions');
    expect(CAPABILITIES.find(({ id }) => id === 'wallet-native-and-offline')?.status).toBe('in_progress');
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
