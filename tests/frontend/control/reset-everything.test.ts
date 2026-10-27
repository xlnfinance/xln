import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearBrowserRuntimeData,
  RESET_CONFIRMATION,
  RESET_WARNING,
} from '../../../frontend/src/lib/utils/control/resetBrowserData';
import { resetEverything } from '../../../frontend/src/lib/utils/control/resetEverything';

const appLayoutSource = readFileSync(join(import.meta.dir, '../../../frontend/src/routes/app/+layout.svelte'), 'utf8');

const replaceGlobal = (key: string, value: unknown): (() => void) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => (previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
};

const storage = (entries: Record<string, string>) => {
  const values = new Map(Object.entries(entries));
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
  };
};

test('reset deletes only named XLN stores and preserves other applications, caches and workers', async () => {
  const runtime = `level-js-db-0x${'1'.repeat(40)}-storage-current`;
  const owned = ['xln-vault-keys-v1', 'xln-runtime-command-journal-v1', runtime, 'level-js-db-default-wal'];
  const unrelated = ['vault', 'runtime', 'other-app', 'xln-unrecognized', 'level-js-db-other-app-wal'];
  const local = storage({
    'xln-vaults': 'vault',
    'xln-password-vault:alice': 'secret',
    'xln-ui-vaults': 'vault',
    'xln-deploy-version': 'old',
    'xln-remote-runtime-imports': 'secret',
    'other-app': 'keep',
    'xln-unrecognized': 'keep',
  });
  const session = storage({ 'xln-runtime-adapter-key': 'secret', 'other-session': 'keep' });
  const deleted: string[] = [];
  const untouched: string[] = [];
  const restore = [
    replaceGlobal('localStorage', local),
    replaceGlobal('sessionStorage', session),
    replaceGlobal('indexedDB', {
      databases: async () => [...owned, ...unrelated].map(name => ({ name })),
      deleteDatabase: (name: string) => {
        const request: Record<string, unknown> = {};
        deleted.push(name);
        queueMicrotask(() => (request['onsuccess'] as () => void)());
        return request;
      },
    }),
    replaceGlobal('caches', {
      keys: async () => {
        untouched.push('cache');
        return [];
      },
    }),
    replaceGlobal('navigator', {
      serviceWorker: {
        getRegistrations: async () => {
          untouched.push('workers');
          return [];
        },
      },
    }),
  ];
  try {
    await clearBrowserRuntimeData(RESET_CONFIRMATION);
    expect(deleted).toEqual(owned);
    expect([...local.values]).toEqual([
      ['other-app', 'keep'],
      ['xln-unrecognized', 'keep'],
    ]);
    expect([...session.values]).toEqual([['other-session', 'keep']]);
    expect(untouched).toEqual([]);
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('browser reset fails loudly when an owned database deletion is blocked', async () => {
  const local = storage({ 'xln-vaults': 'keep on failure' });
  const restore = [
    replaceGlobal('localStorage', local),
    replaceGlobal('sessionStorage', storage({})),
    replaceGlobal('indexedDB', {
      databases: async () => [{ name: 'xln-vault-keys-v1' }],
      deleteDatabase: () => {
        const request: Record<string, unknown> = {};
        queueMicrotask(() => (request['onblocked'] as () => void)());
        return request;
      },
    }),
  ];
  try {
    await expect(clearBrowserRuntimeData(RESET_CONFIRMATION)).rejects.toThrow(
      'RESET_INDEXED_DB_DELETE_BLOCKED:xln-vault-keys-v1',
    );
    expect(local.values.get('xln-vaults')).toBe('keep on failure');
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('cancelled, absent or incorrect typed confirmation never touches data or starts shutdown', async () => {
  expect(RESET_WARNING).toContain('encrypted vaults');
  for (const confirmation of [null, '', 'yes', 'delete xln data', 'DELETE XLN DATA ']) {
    const restore = replaceGlobal('window', {
      prompt: (warning: string) => {
        expect(warning).toBe(RESET_WARNING);
        return confirmation;
      },
    });
    try {
      await resetEverything({ reason: 'test' });
      await expect(clearBrowserRuntimeData(confirmation ?? '')).rejects.toThrow('RESET_CONFIRMATION_REQUIRED');
    } finally {
      restore();
    }
  }
});

test('hashes and deploy-version changes cannot trigger a reset', () => {
  expect(appLayoutSource).not.toContain('maybeHandleResetHash');
  expect(appLayoutSource).not.toContain('isResetHashActive');
  expect(appLayoutSource).not.toContain("reason: 'hash-reset'");
  expect(appLayoutSource).not.toContain("reason: 'deploy-version-change-testnet'");
  for (const source of [
    appLayoutSource,
    readFileSync(join(import.meta.dir, '../../../frontend/src/routes/testnet/+page.svelte'), 'utf8'),
    readFileSync(
      join(import.meta.dir, '../../../frontend/src/lib/components/Entity/workspace/shell/ContextSwitcher.svelte'),
      'utf8',
    ),
  ])
    expect(source).not.toContain('confirmed: true');
});
