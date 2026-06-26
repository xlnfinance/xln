import { beforeEach, describe, expect, test } from 'bun:test';

import {
  MAX_REMOTE_RUNTIME_IMPORTS,
  assertRemoteRuntimeTokenFresh,
  describeRemoteRuntimeImportError,
  parseRemoteRuntimeImportText,
  persistRemoteRuntimeImports,
  readStoredRemoteRuntimeImports,
  remoteRuntimeIdForWsUrl,
  parseRemoteRuntimeImportSourcePayload,
  type StoredRemoteRuntimeImportEntry,
} from '../../frontend/src/lib/utils/remoteRuntimeImport';

const token = `xlnra1.read.${Date.now() + 60 * 60 * 1000}.aud.kid.jti.sig`;

const makeEntry = (index: number): string =>
  `H${index} | read | ws://127.0.0.1:${8000 + index}/rpc | ${token}-${index}`;

const makeStored = (label: string, port: number, importedAt: number): StoredRemoteRuntimeImportEntry => {
  const wsUrl = `ws://127.0.0.1:${port}/rpc`;
  return {
    label,
    access: 'read',
    wsUrl,
    token: `${token}-${port}`,
    runtimeId: remoteRuntimeIdForWsUrl(wsUrl),
    authLevel: 'inspect',
    height: port,
    entityCount: 1,
    importedAt,
  };
};

const installMemorySessionStorage = (): void => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Partial<Storage>,
  });
};

describe('remote runtime import manager utilities', () => {
  beforeEach(() => installMemorySessionStorage());

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
});
