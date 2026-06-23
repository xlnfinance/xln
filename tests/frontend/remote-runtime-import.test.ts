import { beforeEach, describe, expect, test } from 'bun:test';

import {
  MAX_REMOTE_RUNTIME_IMPORTS,
  parseRemoteRuntimeImportText,
  persistRemoteRuntimeImports,
  readStoredRemoteRuntimeImports,
  remoteRuntimeIdForWsUrl,
  type StoredRemoteRuntimeImportEntry,
} from '../../frontend/src/lib/utils/remoteRuntimeImport';

const token = 'xlnra1.test-token';

const makeEntry = (index: number): string =>
  `H${index} | read | ws://127.0.0.1:${8000 + index}/rpc | ${token}-${index}`;

const makeStored = (label: string, port: number, importedAt: number): StoredRemoteRuntimeImportEntry => {
  const wsUrl = `ws://localhost:${port}/rpc`;
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
    expect(entries[0]?.wsUrl).toBe('ws://localhost:8001/rpc');
  });

  test('rejects more than 100 remote runtime capability lines', () => {
    const lines = Array.from({ length: MAX_REMOTE_RUNTIME_IMPORTS + 1 }, (_, index) => makeEntry(index + 1));
    expect(() => parseRemoteRuntimeImportText(lines.join('\n'))).toThrow('REMOTE_RUNTIME_IMPORT_LIMIT_EXCEEDED:101:100');
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
