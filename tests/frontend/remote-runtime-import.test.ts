import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  MAX_REMOTE_RUNTIME_IMPORTS,
  REMOTE_RUNTIME_IMPORT_STORAGE_KEY,
  assertRemoteRuntimeTokenFresh,
  describeRemoteRuntimeImportError,
  parseRemoteRuntimeImportText,
  persistRemoteRuntimeImports,
  readRemoteRuntimeTokenAccess,
  readRemoteRuntimeTokenAudience,
  readStoredRemoteRuntimeImports,
  removeStoredRemoteRuntimeImport,
  resolveStoredRemoteRuntimeAuthKey,
  remoteRuntimeIdForWsUrl,
  parseRemoteRuntimeImportSourcePayload,
  type StoredRemoteRuntimeImportEntry,
} from '../../frontend/src/lib/utils/remoteRuntimeImport';
import { selectPrimaryRemoteHubSummary } from '../../frontend/src/lib/utils/remoteRuntimeValidation';

const token = `xlnra1.read.${Date.now() + 60 * 60 * 1000}.aud.kid.jti.sig`;

const makeEntry = (index: number): string =>
  `H${index} | read | ws://127.0.0.1:${8000 + index}/rpc | ${token}-${index}`;

const makeStored = (
  label: string,
  port: number,
  importedAt: number,
  access: 'read' | 'admin' = 'read',
): StoredRemoteRuntimeImportEntry => {
  const wsUrl = `ws://127.0.0.1:${port}/rpc`;
  return {
    label,
    access,
    wsUrl,
    token: access === 'admin' ? `${token.replace('read', 'full')}-${port}` : `${token}-${port}`,
    runtimeId: remoteRuntimeIdForWsUrl(wsUrl),
    authLevel: access === 'admin' ? 'admin' : 'inspect',
    height: port,
    entityCount: 1,
    importedAt,
    hubEntityId: `0x${'aa'.repeat(32)}`,
    hubName: label,
    hubJurisdiction: {
      name: 'Testnet',
      chainId: 31337,
      depositoryAddress: `0x${'bb'.repeat(20)}`,
    },
    hubEntities: [{
      entityId: `0x${'aa'.repeat(32)}`,
      runtimeId: remoteRuntimeIdForWsUrl(wsUrl),
      label,
      height: port,
      jurisdiction: {
        name: 'Testnet',
        chainId: 31337,
        depositoryAddress: `0x${'bb'.repeat(20)}`,
      },
    }],
  };
};

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
};

const installMemoryWebStorage = (): void => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
};

describe('remote runtime import manager utilities', () => {
  beforeEach(() => installMemoryWebStorage());

  test('accepts exactly 100 remote runtime capability lines', () => {
    const lines = Array.from({ length: MAX_REMOTE_RUNTIME_IMPORTS }, (_, index) => makeEntry(index + 1));
    const entries = parseRemoteRuntimeImportText(lines.join('\n'));
    expect(entries.length).toBe(MAX_REMOTE_RUNTIME_IMPORTS);
    expect(entries[0]?.wsUrl).toBe('ws://127.0.0.1:8001/rpc');
  });

  test('preserves explicit IPv4 loopback for browser WebSocket connects', () => {
    const [entry] = parseRemoteRuntimeImportText(`H1 | read | ws://127.0.0.1:8092/rpc | ${token}`);
    expect(entry?.wsUrl).toBe('ws://127.0.0.1:8092/rpc');
    expect(entry?.wsUrl).not.toContain('localhost');
  });

  test('rewrites localhost loopback to IPv4 for browser WebSocket connects', () => {
    const [entry] = parseRemoteRuntimeImportText(`H1 | read | ws://localhost:8092/rpc | ${token}`);
    expect(entry?.wsUrl).toBe('ws://127.0.0.1:8092/rpc');
    expect(remoteRuntimeIdForWsUrl('ws://localhost:8092/rpc')).toBe('radapter:ws://127.0.0.1:8092/rpc');
  });

  test('rejects expired capability tokens before opening WebSocket', () => {
    const expired = `xlnra1.read.${Date.now() - 1}.aud.kid.jti.sig`;
    expect(() => parseRemoteRuntimeImportText(`H1 | read | ws://localhost:8092/rpc | ${expired}`))
      .toThrow('REMOTE_RUNTIME_TOKEN_EXPIRED:H1');
    expect(() => assertRemoteRuntimeTokenFresh({ label: 'H1', token: expired }))
      .toThrow('REMOTE_RUNTIME_TOKEN_EXPIRED:H1');
  });

  test('reads runtime identity from capability token audience', () => {
    const runtimeId = '0x' + 'ab'.repeat(20);
    const audience = Buffer.from(runtimeId, 'utf8').toString('base64url');
    const audienceToken = `xlnra1.full.${Date.now() + 60_000}.${audience}.kid.jti.sig`;

    expect(readRemoteRuntimeTokenAudience(audienceToken)).toBe(runtimeId);
    expect(readRemoteRuntimeTokenAudience('bad-token')).toBe('');
  });

  test('reads capability token access without trusting UI storage flags', () => {
    expect(readRemoteRuntimeTokenAccess(`xlnra1.full.${Date.now() + 60_000}.aud.kid.jti.sig`)).toBe('admin');
    expect(readRemoteRuntimeTokenAccess(`xlnra1.read.${Date.now() + 60_000}.aud.kid.jti.sig`)).toBe('read');
    expect(readRemoteRuntimeTokenAccess('bad-token')).toBe('');
  });

  test('parses live import source payloads from orchestrator', () => {
    const entries = parseRemoteRuntimeImportSourcePayload({
      manifest: {
        entries: [
          { label: 'H1', access: 'read', wsUrl: 'ws://localhost:8092/rpc', token },
        ],
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.wsUrl).toBe('ws://127.0.0.1:8092/rpc');
  });

  test('rejects more than 100 remote runtime capability lines', () => {
    const lines = Array.from({ length: MAX_REMOTE_RUNTIME_IMPORTS + 1 }, (_, index) => makeEntry(index + 1));
    expect(() => parseRemoteRuntimeImportText(lines.join('\n'))).toThrow('REMOTE_RUNTIME_IMPORT_LIMIT_EXCEEDED:101:100');
  });

  test('explains browser-side remote connection failures in operator language', () => {
    const [entry] = parseRemoteRuntimeImportText(`H1 | admin | ws://localhost:8092/rpc | ${token}`);
    const message = describeRemoteRuntimeImportError(
      new Error(`REMOTE_RUNTIME_CONNECT_FAILED:${entry!.wsUrl}:error`),
      entry,
    );
    expect(message).toContain('H1: connection failed');
    expect(message).toContain('mesh is running');
    expect(message).toContain('ws://127.0.0.1:8092/rpc');
  });

  test('merge import upserts by normalized runtime endpoint', () => {
    const first = makeStored('old H1', 8080, 1);
    const second = makeStored('H2', 8081, 2);
    const replacement = makeStored('new H1', 8080, 3);

    persistRemoteRuntimeImports([first, second]);
    const persisted = persistRemoteRuntimeImports([replacement], { merge: true });

    expect(persisted.length).toBe(2);
    expect(readStoredRemoteRuntimeImports().map(entry => entry.label)).toEqual(['H2', 'new H1']);
    expect(readStoredRemoteRuntimeImports().find(entry => entry.wsUrl === first.wsUrl)?.height).toBe(8080);
  });

  test('merge import never downgrades a stored admin capability to read', () => {
    const admin = makeStored('H1 admin', 8092, 1, 'admin');
    const read = makeStored('H1 read', 8092, 2, 'read');

    persistRemoteRuntimeImports([admin]);
    const persisted = persistRemoteRuntimeImports([read], { merge: true });
    const [entry] = persisted;

    expect(persisted.length).toBe(1);
    expect(entry?.access).toBe('admin');
    expect(entry?.authLevel).toBe('admin');
    expect(entry?.token).toBe(admin.token);
    expect(readStoredRemoteRuntimeImports()[0]?.access).toBe('admin');
  });

  test('persists remote runtime capabilities in local storage across reloads', () => {
    const admin = makeStored('H1 admin', 8092, 1, 'admin');
    persistRemoteRuntimeImports([admin]);

    expect(localStorage.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY)).toContain(admin.token);
    expect(sessionStorage.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY)).toBeNull();
    expect(resolveStoredRemoteRuntimeAuthKey('ws://localhost:8092/rpc', { requiredAccess: 'admin' }))
      .toBe(admin.token);
  });

  test('migrates old session-scoped remote runtime capabilities into local storage', () => {
    const admin = makeStored('H1 admin', 8092, 1, 'admin');
    sessionStorage.setItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY, JSON.stringify([admin]));

    expect(readStoredRemoteRuntimeImports()[0]?.token).toBe(admin.token);
    expect(localStorage.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY)).toContain(admin.token);
    expect(sessionStorage.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY)).toBeNull();
  });

  test('persists websocket-derived hub metadata across reloads', () => {
    const h1 = makeStored('H1 admin', 8092, 1, 'admin');
    persistRemoteRuntimeImports([h1]);

    const [restored] = readStoredRemoteRuntimeImports();
    expect(restored?.hubEntityId).toBe(h1.hubEntityId);
    expect(restored?.hubName).toBe('H1 admin');
    expect(restored?.hubJurisdiction?.depositoryAddress).toBe(`0x${'bb'.repeat(20)}`);
    expect(restored?.hubEntities?.[0]?.entityId).toBe(h1.hubEntityId);
    expect(restored?.hubEntities?.[0]?.runtimeId).toBe(h1.runtimeId);
  });

  test('remote validation selects the hub matching the imported runtime label', () => {
    const h3 = {
      entityId: `0x${'33'.repeat(32)}`,
      label: 'H3',
      height: 30,
    };
    const h1 = {
      entityId: `0x${'11'.repeat(32)}`,
      label: 'H1 remote runtime',
      height: 10,
    };

    expect(selectPrimaryRemoteHubSummary([h3, h1], 'H1')?.entityId).toBe(h1.entityId);
    expect(selectPrimaryRemoteHubSummary([h3, h1], 'missing')?.entityId).toBe(h3.entityId);
  });

  test('remote validation prefers the hub owned by the connected runtime over first visible gossip hub', () => {
    const h1 = {
      entityId: `0x${'11'.repeat(32)}`,
      runtimeId: `0x${'01'.repeat(20)}`,
      label: 'H1',
      height: 10,
    };
    const h2 = {
      entityId: `0x${'22'.repeat(32)}`,
      runtimeId: `0x${'02'.repeat(20)}`,
      label: 'H2',
      height: 20,
    };

    expect(selectPrimaryRemoteHubSummary([h1, h2], 'H2', h2.runtimeId)?.entityId).toBe(h2.entityId);
    expect(selectPrimaryRemoteHubSummary([h1, h2], 'missing', h2.runtimeId)?.entityId).toBe(h2.entityId);
  });

  test('restores the active admin token by normalized endpoint after reload', () => {
    const admin = makeStored('H1 admin', 8092, 1, 'admin');
    persistRemoteRuntimeImports([admin]);

    expect(resolveStoredRemoteRuntimeAuthKey('ws://localhost:8092/rpc', { requiredAccess: 'admin' }))
      .toBe(admin.token);
  });

  test('does not silently downgrade an active admin remote when the admin token is missing', () => {
    const read = makeStored('H1 read', 8092, 1, 'read');
    persistRemoteRuntimeImports([read]);

    expect(() => resolveStoredRemoteRuntimeAuthKey('ws://127.0.0.1:8092/rpc', { requiredAccess: 'admin' }))
      .toThrow('REMOTE_RUNTIME_ACTIVE_ADMIN_TOKEN_MISSING:ws://127.0.0.1:8092/rpc');
  });

  test('removes saved remote runtime by real runtime id or endpoint alias', () => {
    const h1 = { ...makeStored('H1 admin', 8092, 1, 'admin'), runtimeId: '0x' + '11'.repeat(32) };
    const h2 = { ...makeStored('H2 admin', 8093, 2, 'admin'), runtimeId: '0x' + '22'.repeat(32) };
    persistRemoteRuntimeImports([h1, h2]);

    expect(removeStoredRemoteRuntimeImport(h1.runtimeId).map(entry => entry.runtimeId)).toEqual([h2.runtimeId]);
    expect(removeStoredRemoteRuntimeImport(h2.wsUrl)).toEqual([]);
  });

  test('app boot hydrates remote runtime handles from the import source through validation', () => {
    const xlnStore = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
    const runtimeCreation = readFileSync('frontend/src/lib/components/Views/RuntimeCreation.svelte', 'utf8');
    const runtimeStore = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
    const vaultStore = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
    const appLayout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');
    const importFlow = readFileSync('frontend/src/lib/utils/remoteRuntimeImportFlow.ts', 'utf8');

    expect(xlnStore).toContain('runtimeOperations.hydrateRemoteRuntimeImports()');
    expect(xlnStore).toContain("new URL('/api/runtime-import', resolveConfiguredApiBase(window.location.origin))");
    expect(xlnStore).toContain('runtimeOperations.hydrateRemoteRuntimeImportSource(importSource.toString())');
    expect(runtimeCreation).toContain('runtimeOperations.hydrateRemoteRuntimeImportSource(url.toString())');
    expect(vaultStore).toContain('runtimeOperations.hydrateRemoteRuntimeImports();');
    expect(runtimeStore).toContain('validateRemoteRuntimeEntry(entry, { index, importedAt })');
    expect(appLayout).toContain('async function importRemoteRuntimesIntoApp');
    expect(appLayout).toContain('fetchRemoteRuntimeImportSource(source)');
    expect(appLayout).toContain('parseRemoteRuntimeImportPayload(payload)');
    expect(appLayout).toContain('persistActiveRemoteRuntimeImport(first)');
    expect(appLayout).not.toContain('redirectRemoteRuntimeImportToManager');
    expect(importFlow).toContain('export const importRemoteRuntimeEntries = async');
    expect(importFlow).toContain('runtimeOperations.upsertRemoteRuntimeImports(validated)');
    expect(runtimeStore).not.toContain('/api/hubs');
  });
});
