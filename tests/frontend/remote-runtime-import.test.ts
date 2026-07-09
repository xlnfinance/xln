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
import {
  buildRemoteRuntimeRecoveryPeerSources,
  buildRuntimeWsRecoveryPeerSource,
  buildRuntimeWsRecoveryPeerSources,
  selectPrimaryRemoteEntitySummary,
  selectPrimaryRemoteHubSummary,
} from '../../frontend/src/lib/utils/remoteRuntimeValidation';

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

  test('parses full dev runtime import manifest for same UX runtime list', () => {
    const runtimeSpecs = [
      ['H1', 8092],
      ['H2', 8093],
      ['H3', 8094],
      ['MM', 8095],
      ['Custody', 8088],
    ] as const;
    const entries = parseRemoteRuntimeImportSourcePayload({
      ok: true,
      ready: true,
      manifest: {
        entries: runtimeSpecs.map(([label, port], index) => ({
          label,
          access: 'read',
          wsUrl: `ws://localhost:${port}/rpc`,
          token: `${token}-${label.toLowerCase()}`,
          runtimeId: `0x${String(index + 1).padStart(40, '0')}`,
          authLevel: 'inspect',
          height: 42 + index,
          entityCount: 1,
        })),
      },
    });

    expect(entries.map(entry => entry.label)).toEqual(['H1', 'H2', 'H3', 'MM', 'Custody']);
    expect(entries.map(entry => entry.access)).toEqual(['read', 'read', 'read', 'read', 'read']);
    expect(entries.map(entry => entry.wsUrl)).toEqual([
      'ws://127.0.0.1:8092/rpc',
      'ws://127.0.0.1:8093/rpc',
      'ws://127.0.0.1:8094/rpc',
      'ws://127.0.0.1:8095/rpc',
      'ws://127.0.0.1:8088/rpc',
    ]);
  });

  test('parses partial local runtime import payloads while the mesh baseline is still converging', () => {
    const entries = parseRemoteRuntimeImportSourcePayload({
      ok: true,
      ready: false,
      partial: true,
      reason: 'system-not-ok',
      manifest: {
        entries: [
          { label: 'H1', access: 'read', wsUrl: 'ws://localhost:8092/rpc', token },
          { label: 'H2', access: 'read', wsUrl: 'ws://localhost:8093/rpc', token },
        ],
      },
    });
    expect(entries.map(entry => entry.label)).toEqual(['H1', 'H2']);
    expect(entries.map(entry => entry.wsUrl)).toEqual([
      'ws://127.0.0.1:8092/rpc',
      'ws://127.0.0.1:8093/rpc',
    ]);
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

  test('fresh import merge prunes expired stored runtimes without accepting expired active tokens', () => {
    const expired = {
      ...makeStored('Custody', 8088, 1),
      token: `xlnra1.read.${Date.now() - 1}.aud.kid.jti.sig`,
    };
    localStorage.setItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY, JSON.stringify([expired]));

    expect(() => readStoredRemoteRuntimeImports()).toThrow('REMOTE_RUNTIME_TOKEN_EXPIRED:Custody');

    const fresh = makeStored('H1', 8092, 2);
    const merged = persistRemoteRuntimeImports([fresh], { merge: true });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe('H1');
    expect(readStoredRemoteRuntimeImports().map(entry => entry.label)).toEqual(['H1']);
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

  test('remote validation uses non-hub runtime entity before visible gossip hub fallback', () => {
    const mmRuntimeId = `0x${'95'.repeat(20)}`;
    const visibleHub = {
      entityId: `0x${'33'.repeat(32)}`,
      runtimeId: mmRuntimeId,
      label: 'H3',
      height: 30,
    };
    const marketMaker = {
      entityId: `0x${'55'.repeat(32)}`,
      runtimeId: mmRuntimeId,
      label: 'MM',
      height: 40,
    };

    expect(selectPrimaryRemoteEntitySummary([visibleHub, marketMaker], 'MM', mmRuntimeId)?.entityId)
      .toBe(marketMaker.entityId);
    expect(selectPrimaryRemoteEntitySummary([visibleHub, marketMaker], 'missing', mmRuntimeId))
      .toBeNull();
    expect(selectPrimaryRemoteHubSummary([visibleHub], 'MM', mmRuntimeId)?.entityId)
      .toBe(visibleHub.entityId);
  });

  test('saved remote runtime imports become recovery peer sources for matching runtime ids', async () => {
    const runtimeId = `0x${'12'.repeat(20)}`;
    const matching = { ...makeStored('H1', 8092, 1), runtimeId };
    const other = { ...makeStored('H2', 8093, 2), runtimeId: `0x${'34'.repeat(20)}` };
    const reads: Array<{ path: string; query?: unknown }> = [];
    let connectedConfig: unknown = null;
    let disconnected = false;

    const sources = buildRemoteRuntimeRecoveryPeerSources({
      entries: [matching, other],
      runtimeId,
      createAdapter: () => ({
        mode: 'remote',
        runtimeId,
        status: 'disconnected',
        currentHeight: 12,
        authLevel: null,
        async connect(config: unknown) {
          connectedConfig = config;
          this.status = 'connected';
          this.authLevel = 'inspect';
        },
        disconnect() {
          disconnected = true;
          this.status = 'disconnected';
        },
        async read(path: string, query?: unknown) {
          reads.push({ path, query });
          return { ok: true, runtimeId, lookupKey: 'lookup/key', bundle: { version: 1 }, bundles: [] };
        },
        async send() {
          throw new Error('send should not be used for recovery peer reads');
        },
        onChange() {
          return () => undefined;
        },
        onStatus() {
          return () => undefined;
        },
      }) as never,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe(runtimeId);
    expect(sources[0]?.label).toBe('H1');

    const payload = await sources[0]!.fetchBundles({ runtimeId, lookupKey: 'lookup/key' });
    expect(payload).toMatchObject({ ok: true, runtimeId, lookupKey: 'lookup/key' });
    expect(connectedConfig).toMatchObject({
      mode: 'remote',
      runtimeId,
      wsUrl: matching.wsUrl,
      authKey: matching.token,
      requestTimeoutMs: 5_000,
    });
    expect(reads).toEqual([{ path: 'recovery/bundles/lookup%2Fkey', query: undefined }]);
    expect(disconnected).toBe(true);
  });

  test('runtime websocket recovery peer source requests correlated bundles from live peer', async () => {
    const requesterRuntimeId = `0x${'56'.repeat(20)}`;
    const peerRuntimeId = `0x${'78'.repeat(20)}`;
    const lookupKey = 'lookup/key';
    const clientOptions: unknown[] = [];
    const requests: Array<{ to: string; lookupKey: string; timeoutMs?: number }> = [];
    let closed = false;
    let opened = false;

    const source = buildRuntimeWsRecoveryPeerSource({
      requesterRuntimeId,
      requesterSeed: 'test test test test test test test test test test test junk',
      requesterSignerId: '7',
      requestTimeoutMs: 1234,
      endpoint: {
        id: 'peer-h1',
        label: 'Peer H1',
        peerRuntimeId,
        wsUrl: 'ws://127.0.0.1:8092/ws',
      },
      createClient: (options) => {
        clientOptions.push(options);
        return {
          async connect() {
            opened = true;
          },
          isOpen() {
            return opened;
          },
          async requestRecoveryBundles<T = unknown>(to: string, key: string, timeoutMs?: number): Promise<T> {
            requests.push({ to, lookupKey: key, timeoutMs });
            return { ok: true, bundles: [{ version: 1 }], lookupKey: key } as T;
          },
          close() {
            closed = true;
          },
        };
      },
    });

    const payload = await source.fetchBundles({ runtimeId: requesterRuntimeId, lookupKey });

    expect(source.id).toBe('peer-h1');
    expect(source.label).toBe('Peer H1');
    expect(payload).toMatchObject({ ok: true, lookupKey });
    expect(requests).toEqual([{ to: peerRuntimeId, lookupKey, timeoutMs: 1234 }]);
    expect(clientOptions[0]).toMatchObject({
      url: 'ws://127.0.0.1:8092/ws',
      runtimeId: requesterRuntimeId,
      signerId: '7',
      seed: 'test test test test test test test test test test test junk',
      useHelloAuth: true,
      maxReconnectAttempts: 1,
    });
    expect((clientOptions[0] as { encryptionKeyPair?: { publicKey?: Uint8Array; privateKey?: Uint8Array } })
      .encryptionKeyPair?.publicKey?.length).toBe(32);
    expect(closed).toBe(true);
  });

  test('runtime websocket recovery peer source rejects runtime mismatches before opening sockets', async () => {
    const requesterRuntimeId = `0x${'90'.repeat(20)}`;
    const peerRuntimeId = `0x${'91'.repeat(20)}`;
    let created = 0;

    const source = buildRuntimeWsRecoveryPeerSource({
      requesterRuntimeId,
      requesterSeed: 'test test test test test test test test test test test junk',
      endpoint: {
        label: 'Peer H2',
        peerRuntimeId,
        wsUrl: 'ws://127.0.0.1:8093/ws',
      },
      createClient: () => {
        created += 1;
        throw new Error('socket should not be created');
      },
    });

    await expect(source.fetchBundles({
      runtimeId: `0x${'92'.repeat(20)}`,
      lookupKey: 'lookup/key',
    })).rejects.toThrow('RUNTIME_WS_RECOVERY_RUNTIME_MISMATCH');
    expect(created).toBe(0);
  });

  test('runtime websocket recovery peer sources dedupe repeated endpoints', () => {
    const requesterRuntimeId = `0x${'93'.repeat(20)}`;
    const peerRuntimeId = `0x${'94'.repeat(20)}`;

    const sources = buildRuntimeWsRecoveryPeerSources({
      requesterRuntimeId,
      requesterSeed: 'test test test test test test test test test test test junk',
      endpoints: [
        { label: 'Peer H3', peerRuntimeId, wsUrl: 'ws://127.0.0.1:8094/ws' },
        { label: 'Peer H3 duplicate', peerRuntimeId, wsUrl: 'ws://127.0.0.1:8094/ws' },
      ],
      createClient: () => {
        throw new Error('socket should not be created while building sources');
      },
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe(peerRuntimeId);
    expect(sources[0]?.label).toBe('Peer H3');
  });

  test('runtime websocket recovery peer sources fail fast on invalid endpoints', () => {
    const requesterRuntimeId = `0x${'95'.repeat(20)}`;

    expect(() => buildRuntimeWsRecoveryPeerSources({
      requesterRuntimeId,
      requesterSeed: 'test test test test test test test test test test test junk',
      endpoints: [
        { label: 'Invalid runtime', peerRuntimeId: 'bad', wsUrl: 'ws://127.0.0.1:8095/ws' },
      ],
    })).toThrow('RUNTIME_WS_RECOVERY_PEER_RUNTIME_INVALID');

    expect(() => buildRuntimeWsRecoveryPeerSources({
      requesterRuntimeId,
      requesterSeed: 'test test test test test test test test test test test junk',
      endpoints: [
        { label: 'Invalid url', peerRuntimeId: `0x${'96'.repeat(20)}`, wsUrl: '' },
      ],
    })).toThrow('RUNTIME_WS_RECOVERY_PEER_WS_URL_MISSING');
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
    expect(xlnStore).toContain("importSource.searchParams.set('allowPartial', '1')");
    expect(xlnStore).toContain('runtimeOperations.hydrateRemoteRuntimeImportSource(importSource.toString())');
    expect(runtimeCreation).toContain("url.searchParams.set('allowPartial', '1')");
    expect(runtimeCreation).toContain('await runtimeOperations.hydrateRemoteRuntimeImportSource(url.toString(), { throwOnError: !silent })');
    expect(runtimeCreation.match(/runtimeOperations\.hydrateRemoteRuntimeImportSource\(url\.toString\(\), \{ throwOnError: !silent \}\)/g))
      .toHaveLength(1);
    expect(runtimeCreation).toContain('buildRemoteRuntimeRecoveryPeerSources({ runtimeId: recoveryRuntimeId })');
    expect(runtimeCreation).toContain('recoveryCheckedPeers = discovery.checkedPeers');
    expect(vaultStore).toContain('runtimeOperations.hydrateRemoteRuntimeImports();');
    expect(runtimeStore).toContain('validateRemoteRuntimeEntry(entry, { index, importedAt })');
    expect(appLayout).toContain('async function importRemoteRuntimesIntoApp');
    expect(appLayout).toContain('fetchRemoteRuntimeImportSource(source)');
    expect(appLayout).toContain('parseRemoteRuntimeImportPayload(payload)');
    expect(appLayout).toContain('persistActiveRemoteRuntimeImport(first)');
    expect(appLayout).toContain('const hasExplicitRemoteRuntimeBootstrap = Boolean(importPayload || importSource || remoteRequest);');
    expect(appLayout).toContain('if (!hasExplicitRemoteRuntimeBootstrap && await ensureCurrentDeployVersion()) return;');
    expect(appLayout.indexOf('const importPayload = readRemoteRuntimeImportPayloadFromUrl()')).toBeLessThan(
      appLayout.indexOf('if (!hasExplicitRemoteRuntimeBootstrap && await ensureCurrentDeployVersion()) return;'),
    );
    expect(appLayout).not.toContain('redirectRemoteRuntimeImportToManager');
    expect(importFlow).toContain('export const importRemoteRuntimeEntries = async');
    expect(importFlow).toContain('runtimeOperations.upsertRemoteRuntimeImports(validated)');
    expect(runtimeStore).toContain('throwOnError?: boolean');
    expect(runtimeStore).toContain('REMOTE_RUNTIME_IMPORT_SOURCE_VALIDATION_FAILED');
    expect(runtimeStore).toContain('const hydration = remoteImportSourceHydration');
    expect(runtimeStore).toContain('if (options.throwOnError === true) return hydration');
    expect(runtimeStore).not.toContain('/api/hubs');
  });

  test('remote projection refresh keeps imported non-hub runtime identity instead of first hub', () => {
    const xlnStore = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');

    expect(xlnStore).toContain('const entitySummaries = remoteEntitySummariesFromEntities(entities)');
    expect(xlnStore).toContain('const primarySummary = selectRemoteRuntimeProjectionPrimary(');
    expect(xlnStore).toContain('existing?.label || existing?.hubName ||');
    expect(xlnStore).toContain('?? (existing?.hubEntityId ? null : primaryHub)');
    expect(xlnStore).toContain('...(runtimeId ? { runtimeId } : {})');
    expect(xlnStore).not.toContain('const primaryHub = hubEntities[0] ?? null;\n  runtimes.update');
  });
});
