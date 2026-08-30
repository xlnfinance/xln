import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  resolveWalletAppView,
  resolveWalletRuntimeSummary,
  WALLET_APP_LINKS,
} from '../../../frontend/apps/wallet/src/app-shell-model';
import { walletPageMetadata } from '../../../frontend/apps/wallet/src/wallet-model';

describe('React wallet app shell', () => {
  test('exposes only working navigation destinations', () => {
    expect(WALLET_APP_LINKS).toEqual([
      { href: '/app', label: 'Overview', view: 'overview' },
      { href: '/app?portfolio=1', label: 'Assets', view: 'portfolio' },
      { href: '/app?health=1', label: 'Health', view: 'health' },
      { href: '/app?payments=1', label: 'Payments', view: 'payments' },
      { href: '/app?markets=1', label: 'Markets', view: 'markets' },
      { href: '/app?setup=1', label: 'Identity', view: 'identity' },
      { href: '/app?settings=1', label: 'Settings', view: 'settings' },
      { href: '/app?diagnostics=1', label: 'Status', view: 'diagnostics' },
      { href: '/testnet', label: 'Testnet', view: null },
      { href: '/health', label: 'Network', view: null },
      { href: '/docs', label: 'Docs', view: null },
    ]);
  });

  test('describes local Runtime boot and committed readiness without inventing authority', () => {
    expect(resolveWalletRuntimeSummary({
      mode: 'embedded', wsUrl: null, access: null, sessionKey: null,
    }, true)).toEqual({
      modeLabel: 'Local Runtime starting',
      endpointLabel: 'Starting…',
      authorityLabel: 'Runtime booting',
      browserLabel: 'Online',
      state: 'local-loading',
      message: 'Local Runtime has not started.',
    });
    expect(resolveWalletRuntimeSummary({
      mode: 'embedded', wsUrl: null, access: null, sessionKey: null,
    }, true, {
      status: 'ready', runtimeId: 'runtime-abcdef', height: 12, message: '',
    })).toEqual({
      modeLabel: 'Local Runtime',
      endpointLabel: 'runtime-abcd · H12',
      authorityLabel: 'Local owner',
      browserLabel: 'Online',
      state: 'local-ready',
      message: '',
    });
  });

  test('keeps inactive tabs and local boot errors explicit', () => {
    const config = { mode: 'embedded', wsUrl: null, access: null, sessionKey: null };
    expect(resolveWalletRuntimeSummary(config, true, {
      status: 'standby', runtimeId: '', height: 0,
      message: 'Use the active tab, or reload this page to request Runtime ownership.',
    })).toMatchObject({ state: 'local-standby', authorityLabel: 'Inactive tab' });
    expect(resolveWalletRuntimeSummary(config, true, {
      status: 'error', runtimeId: '', height: 0, message: 'BOOT_FAILED',
    })).toMatchObject({ state: 'local-error', message: 'BOOT_FAILED' });
  });

  test('resolves the payments query and canonical invoice deep link', () => {
    expect(resolveWalletAppView('?payments=1')).toBe('payments');
    expect(resolveWalletAppView('', '#pay/invoice')).toBe('payments');
  });

  test('resolves the markets query', () => {
    expect(resolveWalletAppView('?markets=1')).toBe('markets');
  });

  test('requires complete tab-confined authority for a remote Runtime', () => {
    expect(resolveWalletRuntimeSummary({
      mode: 'remote', wsUrl: 'wss://runtime.example/rpc', access: 'admin', sessionKey: null,
    }, false)).toMatchObject({
      endpointLabel: 'wss://runtime.example/rpc',
      authorityLabel: 'Authority required',
      browserLabel: 'Offline',
      state: 'remote-blocked',
    });
    expect(resolveWalletRuntimeSummary({
      mode: 'remote', wsUrl: 'wss://runtime.example/rpc', access: 'admin', sessionKey: 'secret',
    }, true)).toMatchObject({
      authorityLabel: 'Admin session',
      state: 'remote-ready',
    });
  });

  test('publishes route-specific document metadata', () => {
    expect(walletPageMetadata({ kind: 'app' })).toEqual({
      title: 'xln Wallet',
      description: 'Inspect your xln Runtime and wallet authority.',
    });
  });

  test('reads canonical session storage and cleans global listeners', () => {
    const source = readFileSync('frontend/apps/wallet/src/app-shell.tsx', 'utf8');
    expect(source).toContain('readRuntimeAdapterStorageSnapshot');
    expect(source).toContain('useSyncExternalStore');
    expect(source).toContain('startWalletEmbeddedRuntime');
    expect(source).toContain("runtime.state === 'local-standby' || runtime.state === 'local-error'");
    expect(source).toContain('<WalletRuntimeBoundary runtime={runtime} />');
    expect(source).toContain('window.addEventListener');
    expect(source).toContain('window.removeEventListener');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('sessionKey}');
  });
});
