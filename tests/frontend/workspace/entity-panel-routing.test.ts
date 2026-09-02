import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  ENTITY_WORKSPACE_SECTIONS,
  buildEntityPanelHashRouteFromState,
  canonicalizeEntityPanelRoute,
  resolveEntityPanelDeepLink,
  resolveEntityPanelDeepLinkFromLocation,
} from '../../../frontend/packages/runtime-client/src/entity-workspace-navigation';

describe('entity panel routing helpers', () => {
  test('accepts only canonical account workspace routes', () => {
    expect(canonicalizeEntityPanelRoute('pay/0xabc')).toBeNull();
    expect(canonicalizeEntityPanelRoute('borrow')).toBeNull();
    expect(canonicalizeEntityPanelRoute('constructor')).toBeNull();
    expect(canonicalizeEntityPanelRoute('toString')).toBeNull();
    expect(canonicalizeEntityPanelRoute('/settings/recovery/')).toBe('settings/recovery');
    expect(canonicalizeEntityPanelRoute('/settings/consensus/')).toBe('settings/consensus');
    expect(canonicalizeEntityPanelRoute('/settings/stack-manager/')).toBe('settings/stack-manager');
  });

  test('preserves every canonical alias in the declarative route registry', () => {
    const routes = [
      ['assets', 'assets'], ['assets/move', 'assets'], ['assets/history', 'assets/history'],
      ['accounts', 'accounts/open'], ['accounts/open', 'accounts/open'],
      ['accounts/send', 'accounts/send'], ['accounts/receive', 'accounts/receive'],
      ['accounts/swap', 'accounts/swap'], ['accounts/move', 'accounts/move'],
      ['accounts/lending', 'accounts/lending'], ['accounts/history', 'accounts/history'],
      ['accounts/configure', 'accounts/configure'], ['accounts/activity', 'accounts/activity'],
      ['accounts/appearance', 'accounts/appearance'], ['ownership', 'ownership'],
      ['settings', 'settings'], ['settings/wallet', 'settings'],
      ['settings/recovery', 'settings/recovery'], ['settings/consensus', 'settings/consensus'],
      ['settings/display', 'settings/display'], ['settings/stack-manager', 'settings/stack-manager'],
      ['settings/network', 'settings/network'], ['settings/data', 'settings/data'],
      ['settings/log', 'settings/log'], ['settings/entity', 'settings/entity'],
    ] as const;
    for (const [route, expected] of routes) {
      expect(canonicalizeEntityPanelRoute(route)).toBe(expected);
    }
  });

  test('resolves hash routes into tab state updates', () => {
    expect(resolveEntityPanelDeepLink({ hashRoute: 'pay/0xabc' })).toEqual({
      activeTab: 'accounts',
      accountWorkspaceTab: 'send',
    });
    expect(resolveEntityPanelDeepLink({ hashRoute: 'assets/history' })).toEqual({
      activeTab: 'assets',
      assetWorkspaceTab: 'history',
    });
    expect(resolveEntityPanelDeepLink({ hashRoute: 'accounts/move' })).toEqual({
      activeTab: 'accounts',
      accountWorkspaceTab: 'move',
    });
    expect(resolveEntityPanelDeepLink({ hashRoute: 'accounts/lending' })).toEqual({
      activeTab: 'accounts',
      accountWorkspaceTab: 'lending',
    });
  });

  test('preserves a canonical invoice payload while selecting the send workspace', () => {
    expect(resolveEntityPanelDeepLinkFromLocation({
      hash: '#pay/0xabc%3Ftoken%3D1',
      search: '',
    })).toEqual({
      activeTab: 'accounts',
      accountWorkspaceTab: 'send',
    });
  });

  test('matches jurisdiction names case-insensitively and keeps unknown values', () => {
    expect(resolveEntityPanelDeepLink({
      jurisdiction: 'arrakis',
      availableJurisdictionNames: ['Arrakis', 'Bespin'],
    })).toEqual({ selectedJurisdictionName: 'Arrakis' });
    expect(resolveEntityPanelDeepLink({
      jurisdiction: 'custom-testnet',
      availableJurisdictionNames: ['Arrakis'],
    })).toEqual({ selectedJurisdictionName: 'custom-testnet' });
  });

  test('builds stable routes from state', () => {
    expect(buildEntityPanelHashRouteFromState({
      activeTab: 'accounts',
      assetWorkspaceTab: 'move',
      settingsSubview: 'wallet',
      accountWorkspaceTab: 'open',
    })).toBe('accounts');
    expect(buildEntityPanelHashRouteFromState({
      activeTab: 'settings',
      assetWorkspaceTab: 'move',
      settingsSubview: 'network',
      accountWorkspaceTab: 'open',
    })).toBe('settings/network');
    expect(buildEntityPanelHashRouteFromState({
      activeTab: 'settings',
      assetWorkspaceTab: 'move',
      settingsSubview: 'consensus',
      accountWorkspaceTab: 'open',
    })).toBe('settings/consensus');
  });

  test('publishes canonical top-level sections for both workspace frameworks', () => {
    expect(ENTITY_WORKSPACE_SECTIONS).toEqual([
      { id: 'assets', label: 'Assets' },
      { id: 'accounts', label: 'Accounts' },
      { id: 'ownership', label: 'Ownership' },
      { id: 'settings', label: 'Settings' },
    ]);

    const shared = readFileSync('frontend/packages/runtime-client/src/entity-workspace-navigation.ts', 'utf8');
    const facade = readFileSync('frontend/src/lib/components/Entity/workspace/entity-panel-routing.ts', 'utf8');
    const tabs = readFileSync('frontend/src/lib/components/Entity/workspace/shell/EntityPanelTabs.svelte', 'utf8');
    expect(shared).not.toContain('frontend/src');
    expect(shared).not.toContain('$lib');
    expect(facade.trim()).toBe("export * from '../../../../../packages/runtime-client/src/entity-workspace-navigation';");
    expect(tabs).toContain('ENTITY_WORKSPACE_SECTIONS.map((section) => ({');
  });
});
