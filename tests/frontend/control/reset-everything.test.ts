import { expect, test } from 'bun:test';
import { clearBrowserRuntimeData } from '../../../frontend/src/lib/utils/control/resetEverything';

const replaceGlobal = (key: string, value: unknown): (() => void) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => previous
    ? Object.defineProperty(globalThis, key, previous)
    : Reflect.deleteProperty(globalThis, key);
};

test('browser reset deletes every enumerated durable store and unregisters workers', async () => {
  const cleared: string[] = [];
  const deletedDatabases: string[] = [];
  const restore = [
    replaceGlobal('localStorage', { clear: () => cleared.push('local') }),
    replaceGlobal('sessionStorage', { clear: () => cleared.push('session') }),
    replaceGlobal('indexedDB', {
      databases: async () => [{ name: 'vault' }, { name: 'runtime' }],
      deleteDatabase: (name: string) => {
        const request: Record<string, unknown> = {};
        deletedDatabases.push(name);
        queueMicrotask(() => (request['onsuccess'] as (() => void) | undefined)?.());
        return request;
      },
    }),
    replaceGlobal('caches', { keys: async () => ['assets'], delete: async () => true }),
    replaceGlobal('navigator', { serviceWorker: { getRegistrations: async () => [{ unregister: async () => true }] } }),
  ];
  try {
    await clearBrowserRuntimeData();
    expect(cleared).toEqual(['local', 'session']);
    expect(deletedDatabases).toEqual(['vault', 'runtime']);
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('browser reset fails loudly when a database deletion is blocked', async () => {
  const restore = [
    replaceGlobal('localStorage', { clear: () => {} }),
    replaceGlobal('sessionStorage', { clear: () => {} }),
    replaceGlobal('indexedDB', {
      databases: async () => [{ name: 'runtime' }],
      deleteDatabase: () => {
        const request: Record<string, unknown> = {};
        queueMicrotask(() => (request['onblocked'] as (() => void) | undefined)?.());
        return request;
      },
    }),
    replaceGlobal('caches', undefined),
    replaceGlobal('navigator', {}),
  ];
  try {
    await expect(clearBrowserRuntimeData()).rejects.toThrow('RESET_INDEXED_DB_DELETE_BLOCKED:runtime');
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});
