import { describe, expect, test } from 'bun:test';

import {
  buildEntityPanelHashRouteFromState,
  canonicalizeEntityPanelRoute,
  resolveEntityPanelDeepLink,
} from '../../frontend/src/lib/components/Entity/entity-panel-routing';

describe('entity panel routing helpers', () => {
  test('canonicalizes account workspace aliases', () => {
    expect(canonicalizeEntityPanelRoute('pay/0xabc')).toBe('accounts/send');
    expect(canonicalizeEntityPanelRoute('borrow')).toBe('accounts/lending');
    expect(canonicalizeEntityPanelRoute('/settings/recovery/')).toBe('settings/recovery');
    expect(canonicalizeEntityPanelRoute('/settings/consensus/')).toBe('settings/consensus');
  });

  test('resolves hash routes into tab state updates', () => {
    expect(resolveEntityPanelDeepLink({ hashRoute: 'assets/history' })).toEqual({
      activeTab: 'assets',
      assetWorkspaceTab: 'history',
    });
    expect(resolveEntityPanelDeepLink({ hashRoute: 'accounts/move' })).toEqual({
      activeTab: 'accounts',
      accountWorkspaceTab: 'move',
    });
    expect(resolveEntityPanelDeepLink({ hashRoute: 'borrow' })).toEqual({
      activeTab: 'accounts',
      accountWorkspaceTab: 'lending',
    });
  });

  test('preserves legacy view/subview query behavior', () => {
    expect(resolveEntityPanelDeepLink({ view: 'settings', subview: 'recovery' })).toEqual({
      activeTab: 'settings',
      settingsSubview: 'recovery',
    });
    expect(resolveEntityPanelDeepLink({ view: 'configure', subview: 'credit' })).toEqual({
      configureWorkspaceTab: 'extend-credit',
    });
    expect(resolveEntityPanelDeepLink({ view: 'settings', subview: 'consensus' })).toEqual({
      activeTab: 'settings',
      settingsSubview: 'consensus',
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
});
