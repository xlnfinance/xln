import { expect, test } from 'bun:test';
import { reconcileRetiredDeployVersion } from '../../../ui/src/runtime/deploy-version';

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
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

const publicTestnet = { development: false, hostname: 'xln.finance' };

test('a retired testnet deploy drops React chain state and keeps vault keys and passwords', async () => {
  const runtime = `level-js-db-0x${'1'.repeat(40)}-storage-current`;
  const retired = ['xln-runtime-command-journal-v1', runtime, 'level-js-db-default-wal'];
  const local = storage({
    'xln-vaults': 'vault',
    'xln-ui-vaults': 'react-vault',
    'xln-password-vault:alice': 'secret',
    'xln-settings': 'prefs',
    'xln-ui-theme': 'dark',
    'xln-deploy-version': 'old',
    'xln-jmachines': 'old chain',
    'xln-ui-recovery': 'old tower',
    'other-app': 'keep',
  });
  const deleted: string[] = [];
  const restore = [
    replaceGlobal('localStorage', local),
    replaceGlobal('sessionStorage', storage({ 'xln-runtime-adapter-key': 'secret' })),
    replaceGlobal('indexedDB', {
      databases: async () => ['xln-vault-keys-v1', ...retired, 'other-app'].map(name => ({ name })),
      deleteDatabase: (name: string) => {
        const request: Record<string, unknown> = {};
        deleted.push(name);
        queueMicrotask(() => (request['onsuccess'] as () => void)());
        return request;
      },
    }),
  ];
  try {
    await reconcileRetiredDeployVersion({ deployVersion: 'new', ephemeralTestnet: true }, publicTestnet);
    expect(deleted).toEqual(retired);
    expect(local.values.get('xln-deploy-version')).toBe('new');
    expect([...local.values.keys()]).toEqual([
      'xln-vaults',
      'xln-ui-vaults',
      'xln-password-vault:alice',
      'xln-settings',
      'xln-ui-theme',
      'other-app',
      'xln-deploy-version',
    ]);
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('a matching or first-seen deploy version does not delete wallet data', async () => {
  const local = storage({
    'xln-ui-vaults': 'react-vault',
    'xln-password-vault:alice': 'secret',
    'xln-deploy-version': 'same',
  });
  const deleted: string[] = [];
  const restore = [
    replaceGlobal('localStorage', local),
    replaceGlobal('sessionStorage', storage({})),
    replaceGlobal('indexedDB', {
      databases: async () => [{ name: 'level-js-db-default-wal' }],
      deleteDatabase: (name: string) => {
        deleted.push(name);
        return {};
      },
    }),
  ];
  try {
    await reconcileRetiredDeployVersion({ deployVersion: 'same', ephemeralTestnet: true }, publicTestnet);
    expect(deleted).toEqual([]);
    expect(local.values.get('xln-deploy-version')).toBe('same');
    local.values.delete('xln-deploy-version');
    await reconcileRetiredDeployVersion({ deployVersion: 'first', ephemeralTestnet: true }, publicTestnet);
    expect(deleted).toEqual([]);
    expect(local.values.get('xln-ui-vaults')).toBe('react-vault');
    expect(local.values.get('xln-password-vault:alice')).toBe('secret');
    expect(local.values.get('xln-deploy-version')).toBe('first');
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('local development treats a version change as a disposable testnet', async () => {
  const local = storage({ 'xln-ui-vaults': 'react-vault', 'xln-deploy-version': 'old' });
  const deleted: string[] = [];
  const restore = [
    replaceGlobal('localStorage', local),
    replaceGlobal('sessionStorage', storage({})),
    replaceGlobal('indexedDB', {
      databases: async () => [{ name: 'level-js-db-default-wal' }],
      deleteDatabase: (name: string) => {
        const request: Record<string, unknown> = {};
        deleted.push(name);
        queueMicrotask(() => (request['onsuccess'] as () => void)());
        return request;
      },
    }),
  ];
  try {
    await reconcileRetiredDeployVersion(
      { deployVersion: 'new', ephemeralTestnet: false },
      { development: true, hostname: 'localhost' },
    );
    expect(deleted).toEqual(['level-js-db-default-wal']);
    expect(local.values.get('xln-ui-vaults')).toBe('react-vault');
    expect(local.values.get('xln-deploy-version')).toBe('new');
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});

test('a real-funds deploy mismatch keeps the old chain and asks for recovery', async () => {
  const local = storage({
    'xln-ui-vaults': 'react-vault',
    'xln-password-vault:alice': 'secret',
    'xln-deploy-version': 'old',
  });
  const deleted: string[] = [];
  const restore = [
    replaceGlobal('localStorage', local),
    replaceGlobal('sessionStorage', storage({})),
    replaceGlobal('indexedDB', {
      databases: async () => [{ name: 'level-js-db-default-wal' }],
      deleteDatabase: (name: string) => {
        deleted.push(name);
        return {};
      },
    }),
  ];
  try {
    await expect(
      reconcileRetiredDeployVersion({ deployVersion: 'new', ephemeralTestnet: false }, publicTestnet),
    ).rejects.toThrow('Deploy version changed from old to new');
    expect(deleted).toEqual([]);
    expect(local.values.get('xln-deploy-version')).toBe('old');
    expect(local.values.get('xln-ui-vaults')).toBe('react-vault');
    expect(local.values.get('xln-password-vault:alice')).toBe('secret');
  } finally {
    restore.reverse().forEach(restoreGlobal => restoreGlobal());
  }
});
