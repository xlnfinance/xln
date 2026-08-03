import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  BROWSER_PERSISTENCE_CONTRACT,
  NATIVE_WEB_ENTRY,
  PUSH_WAKE_SERVICE_WORKER,
  RUNTIME_COMMAND_JOURNAL_DATABASE,
  VAULT_KEY_DATABASE,
  VAULT_STORAGE_KEY,
  WEB_APP_MANIFEST,
} from '../../frontend/src/lib/contracts/browserPersistence';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('same-origin browser persistence contract', () => {
  test('locks vault and command-journal identifiers', () => {
    expect(VAULT_STORAGE_KEY).toBe('xln-vaults');
    expect(VAULT_KEY_DATABASE).toEqual({ name: 'xln-vault-keys-v1', version: 1, stores: ['keys'] });
    expect(RUNTIME_COMMAND_JOURNAL_DATABASE).toEqual({
      name: 'xln-runtime-command-journal-v1',
      version: 2,
      stores: ['intents'],
      retiredStores: ['meta'],
    });
    expect(BROWSER_PERSISTENCE_CONTRACT.originPolicy).toBe('same-origin-required');
  });

  test('keeps the PWA and push worker root-scoped with /app as wake target', () => {
    const manifest = JSON.parse(read('frontend/static/site.webmanifest')) as Record<string, unknown>;
    const worker = read('frontend/static/push-wake-sw.js');
    const registration = read('frontend/src/lib/utils/pushWakeRegistration.ts');

    expect(WEB_APP_MANIFEST).toEqual({ path: '/site.webmanifest', startUrl: '/', scope: '/' });
    expect(manifest['start_url']).toBe(WEB_APP_MANIFEST.startUrl);
    expect(manifest['scope']).toBe(WEB_APP_MANIFEST.scope);
    expect(worker).toContain(`: '${PUSH_WAKE_SERVICE_WORKER.defaultOpenPath}'`);
    expect(registration).toContain('navigator.serviceWorker.register(PUSH_WAKE_SERVICE_WORKER.path');
    expect(registration).toContain('scope: PUSH_WAKE_SERVICE_WORKER.scope');
  });

  test('preserves the native root redirect and build directory', () => {
    const appTemplate = read('frontend/src/app.html');
    const capacitorConfig = read('frontend/capacitor.config.ts');

    expect(NATIVE_WEB_ENTRY).toEqual({ rootPath: '/', redirectPath: '/app', webDir: 'build' });
    expect(appTemplate).toContain("window.location.pathname === '/'");
    expect(appTemplate).toContain("window.history.replaceState(null, '', '/app')");
    expect(capacitorConfig).toContain("|| 'build'");
    expect(capacitorConfig).toContain("webDir !== 'build' && webDir !== '.native-wallet-build'");
  });
});
