import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLATFORM_INVENTORY,
  type PlatformInterface,
} from '../../../frontend/config/platform-inventory';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const REQUIRED_INTERFACES: readonly PlatformInterface[] = [
  'asset',
  'broadcast-channel',
  'cache-storage',
  'capacitor',
  'dedicated-worker',
  'desktop-shell',
  'extension-shell',
  'indexed-db',
  'local-storage',
  'registry',
  'release-artifact',
  'route',
  'service-worker',
  'session-storage',
  'verification-command',
  'web-locks',
];

describe('frontend platform baseline inventory', () => {
  test('captures every required platform interface with a stable owner', () => {
    const ids = PLATFORM_INVENTORY.map(({ id }) => id);
    const interfaces = new Set(PLATFORM_INVENTORY.flatMap((entry) => entry.interfaces));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toBe(true);
    for (const platformInterface of REQUIRED_INTERFACES) expect(interfaces.has(platformInterface)).toBe(true);
  });

  test('points every source, consumer, and evidence record at a live path', () => {
    for (const entry of PLATFORM_INVENTORY) {
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.consumers.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const pathname of [...entry.sources, ...entry.consumers, ...entry.evidence]) {
        if (!existsSync(join(REPOSITORY_ROOT, pathname))) {
          throw new Error(`PLATFORM_INVENTORY_PATH_MISSING:${entry.id}:${pathname}`);
        }
      }
    }
  });

  test('assigns every deferred concern to its later executable work package', () => {
    const deferred = PLATFORM_INVENTORY.filter(({ status }) => status === 'owned-for-later-wp');

    expect(deferred.map(({ id }) => id)).toEqual([
      'wallet-durable-custody-storage',
      'push-wake-service-worker',
      'native-and-packaged-consumers',
      'ops-workspace-registries',
      'candidate-release-consumers',
    ]);
    expect(deferred.every(({ workPackage }) => ['WP7', 'WP8', 'WP9'].includes(workPackage))).toBe(true);
  });

  test('records WP0, WP2, and WP5 concerns as implemented', () => {
    const currentWork = PLATFORM_INVENTORY.filter(({ workPackage }) =>
      ['WP0', 'WP2', 'WP5'].includes(workPackage));

    expect(currentWork.length).toBeGreaterThan(0);
    expect(currentWork.every(({ status }) => status === 'implemented')).toBe(true);
  });

  test('records the embedded Runtime browser boundary and both framework consumers', () => {
    const entry = PLATFORM_INVENTORY.find(({ id }) => id === 'embedded-runtime-browser-session');

    expect(entry?.workPackage).toBe('WP5');
    expect(entry?.status).toBe('implemented');
    expect(entry?.sources).toContain('frontend/packages/browser/src/runtime-module-loader.ts');
    expect(entry?.sources).toContain('frontend/apps/wallet/src/wallet-embedded-runtime-adapter.ts');
    expect(entry?.consumers).toContain('frontend/apps/wallet/src/app-shell.tsx');
    expect(entry?.consumers).toContain('frontend/src/lib/stores/bootstrap/xlnRuntimeLoader.ts');
    expect(entry?.consumers).toContain('frontend/src/lib/stores/vault/vaultStore.ts');
  });
});
