import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAPABILITIES } from '../../../frontend/config/capabilities';
import {
  createDemoWalletHref,
  TESTNET_CARDS,
} from '../../../frontend/apps/wallet/src/testnet-model';
import { resolveWalletPage } from '../../../frontend/apps/wallet/src/wallet-model';

const ROOT = resolve(import.meta.dir, '../../..');

describe('React wallet testnet pilot', () => {
  test('owns the exact testnet and app routes without claiming address flows', () => {
    expect(resolveWalletPage('/testnet')).toEqual({ kind: 'testnet' });
    expect(resolveWalletPage('/app')).toEqual({ kind: 'app' });
    expect(resolveWalletPage('/address')).toEqual({ kind: 'pending', pathname: '/address' });
  });

  test('preserves wallet, custody, health, and disposable identity destinations', () => {
    expect(TESTNET_CARDS.map(({ href }) => href)).toEqual([
      '/app',
      'https://custody.xln.finance',
      '/health',
    ]);
    const wallet = TESTNET_CARDS[0];
    expect(wallet?.description).toContain('connected Runtime');
    expect(wallet?.description).not.toContain('Full wallet');
    expect(wallet?.description).not.toContain('Create a wallet');
    expect(createDemoWalletHref('A')).toBe('/app?demo=A');
    expect(createDemoWalletHref(' Alice / QA ')).toBe('/app?demo=Alice%20%2F%20QA');
    expect(() => createDemoWalletHref('   ')).toThrow('TESTNET_DEMO_LABEL_REQUIRED');
  });

  test('shares disposable identities and the browser reset boundary with Svelte', () => {
    const reactSource = readFileSync(resolve(ROOT, 'frontend/apps/wallet/src/testnet-page.tsx'), 'utf8');
    const svelteSource = readFileSync(resolve(ROOT, 'frontend/src/routes/testnet/+page.svelte'), 'utf8');
    const resetSource = readFileSync(resolve(ROOT, 'frontend/src/lib/utils/control/resetEverything.ts'), 'utf8');
    expect(reactSource).toContain("from '$lib/config/demo-accounts'");
    expect(reactSource).toContain('resetBrowserRuntimeData');
    expect(reactSource).toContain('publishBrowserHardResetRequest');
    expect(reactSource).toContain('They create no wallet');
    expect(reactSource).not.toContain('Open disposable wallet');
    expect(svelteSource).toContain('DEMO_ACCOUNTS');
    expect(svelteSource).toContain("reason: 'testnet-tools'");
    expect(resetSource).toContain('packages/browser/src/browser-runtime-reset');
    expect(resetSource).toContain('publishBrowserHardResetRequest');
  });

  test('tracks the first wallet capability as in progress', () => {
    const capability = CAPABILITIES.find(({ id }) => id === 'wallet-shell-and-identity');
    expect(capability?.status).toBe('in_progress');
    expect(capability?.routes).toContain('/testnet');
    expect(capability?.currentSources).toContain('frontend/apps/wallet/src/testnet-page.tsx');
  });
});
