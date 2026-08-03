import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeWalletEntryPath } from '../../frontend/apps/wallet/src/wallet-entry';
import { WALLET_STATIC_ASSETS } from '../../frontend/apps/wallet/build/wallet-build-plugin';
import { buildReactWalletCandidateManifest } from '../../frontend/packages/build-contracts/react-candidate';
import { createReactViteSurfaceContract } from '../../frontend/packages/build-contracts/vite-surfaces';
import { BROWSER_PERSISTENCE_CONTRACT } from '../../frontend/src/lib/contracts/browserPersistence';
import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';

const ROOT = resolve(import.meta.dir, '../..');

test('native root is owned by the wallet entry while browser root remains public', () => {
  expect(normalizeWalletEntryPath('/', 'capacitor')).toBe('/app');
  expect(normalizeWalletEntryPath('/', 'electron')).toBe('/app');
  expect(() => normalizeWalletEntryPath('/', 'browser')).toThrow('REACT_WALLET_ROUTE_UNKNOWN:/');
  expect(normalizeWalletEntryPath('/app', 'browser')).toBe('/app');
  expect(BROWSER_PERSISTENCE_CONTRACT.native.redirectPath).toBe('/app');
});

test('PWA and push entry assets remain wallet-owned with exact root scopes', () => {
  expect(WALLET_STATIC_ASSETS).toContain('site.webmanifest');
  expect(WALLET_STATIC_ASSETS).toContain('push-wake-sw.js');
  expect(BROWSER_PERSISTENCE_CONTRACT.pwa).toEqual({ path: '/site.webmanifest', startUrl: '/', scope: '/' });
  expect(BROWSER_PERSISTENCE_CONTRACT.pushWake.defaultOpenPath).toBe('/app');
});

test('wallet build stays activation-blocked and contains every wallet page entry', () => {
  const routes = FRONTEND_ROUTES.filter(route => route.surface === 'wallet' && route.kind === 'page');
  const manifest = buildReactWalletCandidateManifest(routes);
  const contract = createReactViteSurfaceContract(resolve(ROOT, 'frontend'), 'wallet');
  expect(manifest.activationBlocked).toBe(true);
  expect(manifest.surface).toBe('wallet');
  expect(contract.routes).toEqual(routes);
  for (const input of Object.values(contract.inputs)) expect(readFileSync(input, 'utf8')).toContain('src/main.tsx');
});

test('public React entries do not import wallet native initialization', () => {
  const siteMain = readFileSync(resolve(ROOT, 'frontend/apps/site/src/main.tsx'), 'utf8');
  const docsMain = readFileSync(resolve(ROOT, 'frontend/apps/docs/src/main.tsx'), 'utf8');
  const walletMain = readFileSync(resolve(ROOT, 'frontend/apps/wallet/src/wallet-controller.ts'), 'utf8');
  expect(siteMain).not.toContain('initializeNativeShell');
  expect(docsMain).not.toContain('initializeNativeShell');
  expect(walletMain).toContain('initializeNativeShell');
});
