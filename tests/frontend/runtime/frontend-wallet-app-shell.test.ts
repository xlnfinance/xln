import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
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
      { href: '/app?setup=1', label: 'Identity', view: 'identity' },
      { href: '/app?settings=1', label: 'Settings', view: 'settings' },
      { href: '/app?diagnostics=1', label: 'Status', view: 'diagnostics' },
      { href: '/testnet', label: 'Testnet', view: null },
      { href: '/health', label: 'Network', view: null },
      { href: '/docs', label: 'Docs', view: null },
    ]);
  });

  test('describes local Runtime state without inventing a connection', () => {
    expect(resolveWalletRuntimeSummary({
      mode: 'embedded', wsUrl: null, access: null, sessionKey: null,
    }, true)).toEqual({
      modeLabel: 'Local Runtime',
      endpointLabel: 'This browser',
      authorityLabel: 'Local control',
      browserLabel: 'Online',
      state: 'local',
    });
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
    expect(source).toContain('window.addEventListener');
    expect(source).toContain('window.removeEventListener');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('sessionKey}');
  });
});
