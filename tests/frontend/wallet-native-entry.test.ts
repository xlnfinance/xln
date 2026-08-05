import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeWalletEntryPath } from '../../frontend/apps/wallet/src/wallet-entry';
import { WALLET_STATIC_ASSETS } from '../../frontend/apps/wallet/build/wallet-build-plugin';
import { createReactViteSurfaceContract } from '../../frontend/packages/build-contracts/vite-surfaces';
import { BROWSER_PERSISTENCE_CONTRACT } from '../../frontend/src/lib/contracts/browserPersistence';
import { FRONTEND_ROUTES } from '../../frontend/src/lib/contracts/frontendSurfaces';
import { NATIVE_REQUIRED_ASSETS } from '../../scripts/deployment/frontend-release-package';
import { parseNativeBuildOptions } from '../../scripts/native/build-platforms';

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
  expect(BROWSER_PERSISTENCE_CONTRACT.pwa).toEqual({ path: '/site.webmanifest', startUrl: '/app', scope: '/' });
  expect(BROWSER_PERSISTENCE_CONTRACT.pushWake.defaultOpenPath).toBe('/app');
});

test('wallet build contains every wallet page entry', () => {
  const routes = FRONTEND_ROUTES.filter(route => route.surface === 'wallet' && route.kind === 'page');
  const contract = createReactViteSurfaceContract(resolve(ROOT, 'frontend'), 'wallet');
  expect(contract.routes).toEqual(routes);
  for (const input of Object.values(contract.inputs)) expect(readFileSync(input, 'utf8')).toContain('src/main.tsx');
});

test('native packaging consumes only the manifest-bound wallet surface', () => {
  const options = parseNativeBuildOptions(['mobile', '--no-build']);
  expect(options.targets).toEqual(['ios', 'android']);
  expect(options.flags.has('--no-build')).toBe(true);
  expect(() => parseNativeBuildOptions(['mobile', '--unknown-build-mode'])).toThrow('Unknown native flag');
  expect(NATIVE_REQUIRED_ASSETS).toContain('build-identity.json');
  const pipeline = readFileSync(resolve(ROOT, 'scripts/native/build-platforms.ts'), 'utf8');
  expect(pipeline).toContain('copyManifestBoundWallet(releaseRoot, manifest)');
  expect(pipeline).toContain('assertNativeWalletCopy(NATIVE_WEB_DIR, bundle');
  expect(pipeline).toContain('const BUN_EXECUTABLE = process.execPath');
  expect(pipeline).toContain("runBun(['scripts/build-surfaces.ts'], FRONTEND)");
  expect(pipeline).not.toContain("run('bun'");
  expect(pipeline).not.toContain("run('bunx'");
});

test('public React entries do not import wallet native initialization', () => {
  const siteMain = readFileSync(resolve(ROOT, 'frontend/apps/site/src/main.tsx'), 'utf8');
  const docsMain = readFileSync(resolve(ROOT, 'frontend/apps/docs/src/main.tsx'), 'utf8');
  const walletMain = readFileSync(resolve(ROOT, 'frontend/apps/wallet/src/wallet-controller.ts'), 'utf8');
  expect(siteMain).not.toContain('initializeNativeShell');
  expect(docsMain).not.toContain('initializeNativeShell');
  expect(walletMain).toContain('initializeNativeShell');
});
