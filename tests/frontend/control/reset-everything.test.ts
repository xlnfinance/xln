import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearBrowserRuntimeData,
  createBrowserRuntimeReset,
  type ResetEverythingRequest,
} from '../../../frontend/packages/browser/src/browser-runtime-reset';
import {
  ACTIVE_TAB_CHANNEL_NAME,
  ACTIVE_TAB_HARD_RESET_KEY,
  publishBrowserHardResetRequest,
} from '../../../frontend/packages/browser/src/hard-reset-request';

const appLayoutSource = readFileSync(
  join(import.meta.dir, '../../../frontend/src/routes/app/+layout.svelte'),
  'utf8',
);

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
  const cleared: string[] = [];
  const restore = [
    replaceGlobal('localStorage', { clear: () => cleared.push('local') }),
    replaceGlobal('sessionStorage', { clear: () => cleared.push('session') }),
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
    expect(cleared).toEqual([]);
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('browser reset runs lifecycle hooks once and redirects only after durable data clears', async () => {
  const events: string[] = [];
  let releaseClear!: () => void;
  const clearBarrier = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const reset = createBrowserRuntimeReset({
    clearBrowserData: async () => {
      events.push('clear:start');
      await clearBarrier;
      events.push('clear:done');
    },
    waitForOtherTabs: () => {
      events.push('wait');
      return Promise.resolve();
    },
    replaceLocation: (pathname) => events.push(`replace:${pathname}`),
  });
  const request = { confirmed: true, reason: 'test' } as const;
  const first = reset(request, { beforeClear: () => events.push('notify') });
  const second = reset(request, { beforeClear: () => events.push('duplicate-notify') });
  await Promise.resolve();
  expect(events).toEqual(['notify', 'wait']);
  releaseClear();
  await Promise.all([first, second]);
  expect(events).toEqual(['notify', 'wait', 'clear:start', 'clear:done', 'replace:/app']);
});

test('browser reset rejects missing explicit confirmation before lifecycle work', async () => {
  const reset = createBrowserRuntimeReset({
    clearBrowserData: () => Promise.reject(new Error('CLEAR_SHOULD_NOT_RUN')),
    waitForOtherTabs: () => Promise.reject(new Error('WAIT_SHOULD_NOT_RUN')),
    replaceLocation: () => {
      throw new Error('REPLACE_SHOULD_NOT_RUN');
    },
  });
  const invalid = { confirmed: false, reason: '' } as unknown as ResetEverythingRequest;
  await expect(reset(invalid)).rejects.toThrow('RESET_CONFIRMATION_REQUIRED');
});

test('hard reset publishes the shared cross-tab protocol before storage is cleared', () => {
  const channelMessages: unknown[] = [];
  const localWrites: Array<[string, string]> = [];
  const sessionWrites: Array<[string, string]> = [];
  let openedChannel = '';
  let channelClosed = false;
  class TestBroadcastChannel {
    constructor(name: string) {
      openedChannel = name;
    }

    postMessage(message: unknown): void {
      channelMessages.push(message);
    }

    close(): void {
      channelClosed = true;
    }
  }
  const restore = [
    replaceGlobal('crypto', { randomUUID: () => 'tab-reset-test' }),
    replaceGlobal('localStorage', { setItem: (key: string, value: string) => localWrites.push([key, value]) }),
    replaceGlobal('sessionStorage', {
      setItem: (key: string, value: string) => sessionWrites.push([key, value]),
      removeItem: () => undefined,
    }),
    replaceGlobal('BroadcastChannel', TestBroadcastChannel),
  ];
  try {
    publishBrowserHardResetRequest();
    expect(openedChannel).toBe(ACTIVE_TAB_CHANNEL_NAME);
    expect(channelMessages).toEqual([{ type: 'hard-reset', tabId: 'tab-reset-test', timestamp: expect.any(Number) }]);
    expect(localWrites).toEqual([[
      ACTIVE_TAB_HARD_RESET_KEY,
      expect.stringContaining('"tabId":"tab-reset-test"'),
    ]]);
    expect(sessionWrites).toContainEqual(['xln-tab-id', 'tab-reset-test']);
    expect(channelClosed).toBe(true);
  } finally {
    restore.reverse().forEach((restoreGlobal) => restoreGlobal());
  }
});

test('hash reset never enters SvelteKit navigation during root mount', () => {
  expect(appLayoutSource).not.toContain("from '$app/navigation'");
  expect(appLayoutSource).not.toContain("replaceState('/app'");
  expect(appLayoutSource).toContain("await resetEverything({ confirmed: true, reason: 'hash-reset' })");
  expect(appLayoutSource).toContain("window.location.replace('/app')");
});
