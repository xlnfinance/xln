import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  RUNTIME_ADAPTER_ACCESS_KEY,
  RUNTIME_ADAPTER_AUTH_KEY,
  RUNTIME_ADAPTER_MODE_KEY,
  RUNTIME_ADAPTER_WS_KEY,
  hasAcceptedRemoteRuntimeRequest,
  isRemoteRuntimeAdapterPreferred,
  markRemoteRuntimeRequestAccepted,
  readRemoteRuntimeAdapterAuth,
  readRuntimeAdapterStorageSnapshot,
  restoreRuntimeAdapterStorageSnapshot,
  writeEmbeddedRuntimeAdapterSession,
  writeRemoteRuntimeAdapterAuth,
  writeRemoteRuntimeAdapterSession,
} from '../../../frontend/packages/browser/src/runtime-adapter-session';

type MemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Readonly<{
  entries: () => Readonly<Record<string, string>>;
}>;

const createMemoryStorage = (initial: Readonly<Record<string, string>> = {}): MemoryStorage => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    entries: () => Object.fromEntries(values),
  };
};

const createStores = () => ({
  durable: createMemoryStorage(),
  session: createMemoryStorage(),
});

describe('browser Runtime adapter session', () => {
  test('persists remote configuration while confining authority to the tab', () => {
    const stores = createStores();
    stores.durable.setItem(RUNTIME_ADAPTER_AUTH_KEY, 'legacy-secret');
    writeRemoteRuntimeAdapterSession(stores, {
      wsUrl: ' wss://runtime.example/rpc ',
      access: 'admin',
      authKey: 'tab-capability',
    });

    expect(stores.durable.entries()).toEqual({
      [RUNTIME_ADAPTER_MODE_KEY]: 'remote',
      [RUNTIME_ADAPTER_WS_KEY]: 'wss://runtime.example/rpc',
      [RUNTIME_ADAPTER_ACCESS_KEY]: 'admin',
    });
    expect(stores.session.entries()).toEqual({
      [RUNTIME_ADAPTER_AUTH_KEY]: 'tab-capability',
    });
  });

  test('validates the complete remote session before mutating storage', () => {
    const stores = createStores();
    stores.durable.setItem('preserved', 'durable');
    stores.session.setItem('preserved', 'session');
    const before = {
      durable: stores.durable.entries(),
      session: stores.session.entries(),
    };

    expect(() => writeRemoteRuntimeAdapterSession(stores, {
      wsUrl: '',
      access: 'admin',
    })).toThrow('REMOTE_RUNTIME_SESSION_WS_REQUIRED');
    expect(() => writeRemoteRuntimeAdapterSession(stores, {
      wsUrl: 'wss://runtime.example/rpc',
      access: 'read',
    })).toThrow('REMOTE_RUNTIME_SESSION_ADMIN_REQUIRED');
    expect({
      durable: stores.durable.entries(),
      session: stores.session.entries(),
    }).toEqual(before);
  });

  test('clears stale tab authority when a remote entry has no capability', () => {
    const stores = createStores();
    stores.session.setItem(RUNTIME_ADAPTER_AUTH_KEY, 'stale-capability');
    writeRemoteRuntimeAdapterSession(stores, {
      wsUrl: 'wss://runtime.example/rpc',
      access: 'admin',
    });
    expect(stores.session.getItem(RUNTIME_ADAPTER_AUTH_KEY)).toBeNull();
  });

  test('reads and restores authority only through tab storage', () => {
    const stores = createStores();
    stores.durable.setItem(RUNTIME_ADAPTER_AUTH_KEY, 'legacy-secret');
    writeRemoteRuntimeAdapterAuth(stores, ' restored-capability ');

    expect(stores.durable.getItem(RUNTIME_ADAPTER_AUTH_KEY)).toBeNull();
    expect(readRemoteRuntimeAdapterAuth(stores)).toBe('restored-capability');
    expect(stores.session.getItem(RUNTIME_ADAPTER_AUTH_KEY)).toBe('restored-capability');
  });

  test('switches to embedded mode by clearing every remote field', () => {
    const stores = createStores();
    writeRemoteRuntimeAdapterSession(stores, {
      wsUrl: 'wss://runtime.example/rpc',
      access: 'admin',
      authKey: 'tab-capability',
    });
    writeEmbeddedRuntimeAdapterSession(stores);

    expect(stores.durable.entries()).toEqual({ [RUNTIME_ADAPTER_MODE_KEY]: 'embedded' });
    expect(stores.session.entries()).toEqual({});
    expect(isRemoteRuntimeAdapterPreferred(stores.durable)).toBe(false);
  });

  test('round-trips rollback snapshots without restoring durable authority', () => {
    const stores = createStores();
    writeRemoteRuntimeAdapterSession(stores, {
      wsUrl: 'wss://runtime.example/rpc',
      access: 'admin',
      authKey: 'tab-capability',
    });
    const snapshot = readRuntimeAdapterStorageSnapshot(stores);
    writeEmbeddedRuntimeAdapterSession(stores);
    stores.durable.setItem(RUNTIME_ADAPTER_AUTH_KEY, 'legacy-secret');
    restoreRuntimeAdapterStorageSnapshot(stores, snapshot);

    expect(readRuntimeAdapterStorageSnapshot(stores)).toEqual(snapshot);
    expect(stores.durable.getItem(RUNTIME_ADAPTER_AUTH_KEY)).toBeNull();
    expect(isRemoteRuntimeAdapterPreferred(stores.durable)).toBe(true);
  });

  test('records acceptance in the tab and fails closed on storage errors', () => {
    const stores = createStores();
    const request = {
      wsUrl: 'wss://runtime.example/rpc',
      authKey: 'tab-capability',
      hostLabel: 'runtime',
      keyLabel: 'full capability',
      acceptKey: 'xln-remote-runtime-accepted:runtime',
    };
    markRemoteRuntimeRequestAccepted(stores.session, request);
    expect(hasAcceptedRemoteRuntimeRequest(stores, request)).toBe(true);

    const throwing = {
      getItem: () => {
        throw new Error('STORAGE_READ_FAILED');
      },
      setItem: () => {
        throw new Error('STORAGE_WRITE_FAILED');
      },
      removeItem: () => {
        throw new Error('STORAGE_REMOVE_FAILED');
      },
    };
    expect(hasAcceptedRemoteRuntimeRequest({ durable: throwing, session: throwing }, request))
      .toBe(false);
  });

  test('keeps canonical Svelte paths on one browser-session writer', () => {
    const connection = readFileSync('frontend/src/lib/utils/runtime/runtimeConnection.ts', 'utf8');
    const importFlow = readFileSync('frontend/src/lib/utils/onboarding/remoteRuntimeImportFlow.ts', 'utf8');
    const runtimeStore = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
    const xlnStore = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
    const appLayout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');

    for (const source of [connection, importFlow, runtimeStore]) {
      expect(source).toContain('writeRemoteRuntimeAdapterSession');
      expect(source).not.toContain("localStorage.setItem('xln-runtime-adapter-mode', 'remote')");
    }
    expect(runtimeStore).toContain('writeEmbeddedRuntimeAdapterSession');
    expect(runtimeStore).toContain('readBrowserRuntimeAdapterStorageSnapshot');
    expect(runtimeStore).toContain('restoreBrowserRuntimeAdapterStorageSnapshot');
    expect(appLayout).toContain('writeEmbeddedRuntimeAdapterSession');
    expect(appLayout).toContain('isRemoteRuntimeAdapterPreferred');
    expect(appLayout).not.toContain("localStorage.setItem('xln-runtime-adapter-mode', 'embedded')");
    expect(xlnStore).toContain('readRemoteRuntimeAdapterAuth');
    expect(xlnStore).toContain('writeRemoteRuntimeAdapterAuth');
    expect(xlnStore).not.toContain("sessionStorage.setItem('xln-runtime-adapter-key'");
  });
});
