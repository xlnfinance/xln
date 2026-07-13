import { expect, test } from 'bun:test';

import {
  protectVaultSecrets,
  redactVaultRuntimeForPersistence,
  sameVaultProtectionLease,
  unprotectVaultSecrets,
  type ProtectedVaultSecrets,
} from '../../frontend/src/lib/security/vaultProtection';

const installSuccessfulKeyDb = (operations: Array<{ method: string; key: IDBValidKey }>): IDBFactory => ({
  open: () => {
    const openRequest: Record<string, unknown> = {};
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        transaction: () => {
          const transaction: Record<string, unknown> = {
            objectStore: () => ({
              put: (_value: unknown, key: IDBValidKey) => completeRequest('put', key),
              delete: (key: IDBValidKey) => completeRequest('delete', key),
            }),
          };
          const completeRequest = (method: string, key: IDBValidKey): Record<string, unknown> => {
            const request: Record<string, unknown> = {};
            operations.push({ method, key });
            setTimeout(() => {
              request['result'] = undefined;
              (request['onsuccess'] as (() => void) | undefined)?.();
              (transaction['oncomplete'] as (() => void) | undefined)?.();
            }, 0);
            return request;
          };
          return transaction;
        },
        close: () => {},
      };
      openRequest['result'] = db;
      (openRequest['onsuccess'] as (() => void) | undefined)?.();
    }, 0);
    return openRequest;
  },
}) as unknown as IDBFactory;

test('vault key write resolves only after IndexedDB transaction commit', async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const openRequest: Record<string, unknown> = {};
  const keyRequest: Record<string, unknown> = {};
  const transaction: Record<string, unknown> = {
    error: new Error('simulated transaction abort'),
    objectStore: () => ({
      put: () => {
        setTimeout(() => {
          keyRequest['result'] = 'stored';
          (keyRequest['onsuccess'] as (() => void) | undefined)?.();
          (transaction['onabort'] as (() => void) | undefined)?.();
        }, 0);
        return keyRequest;
      },
    }),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => transaction,
    close: () => {},
  };
  globalThis.indexedDB = {
    open: () => {
      setTimeout(() => {
        openRequest['result'] = db;
        (openRequest['onsuccess'] as (() => void) | undefined)?.();
      }, 0);
      return openRequest;
    },
  } as unknown as IDBFactory;

  try {
    await expect(protectVaultSecrets('runtime-id', { seed: 'secret' }, null))
      .rejects.toThrow('simulated transaction abort');
  } finally {
    globalThis.indexedDB = previousIndexedDb;
  }
});

test('vault persistence excludes every raw signing and recovery secret', () => {
  const persisted = redactVaultRuntimeForPersistence({
    id: '0x1234',
    label: 'Wallet',
    seed: 'raw 24 word mnemonic',
    mnemonic12: 'raw 12 word mnemonic',
    devicePassphrase: 'raw brainvault passphrase',
    env: { runtimeSeed: 'raw runtime seed' },
    protectedSecrets: { version: 1, iv: 'iv', ciphertext: 'ciphertext', unlockUntil: null },
  });
  const serialized = JSON.stringify(persisted);

  expect(serialized).not.toContain('raw 24 word mnemonic');
  expect(serialized).not.toContain('raw 12 word mnemonic');
  expect(serialized).not.toContain('raw brainvault passphrase');
  expect(serialized).not.toContain('raw runtime seed');
  expect(persisted.protectedSecrets.ciphertext).toBe('ciphertext');
});

test('vault protection lease identity prevents stale tabs from locking a refreshed key', () => {
  const oldLease: ProtectedVaultSecrets = {
    version: 2,
    keyId: 'old-key',
    iv: 'old-iv',
    ciphertext: 'old-ciphertext',
    unlockUntil: 100,
  };
  const refreshedLease: ProtectedVaultSecrets = {
    version: 2,
    keyId: 'new-key',
    iv: 'new-iv',
    ciphertext: 'new-ciphertext',
    unlockUntil: 1_000,
  };

  expect(sameVaultProtectionLease(oldLease, oldLease)).toBe(true);
  expect(sameVaultProtectionLease(oldLease, refreshedLease)).toBe(false);
  expect(sameVaultProtectionLease(oldLease, undefined)).toBe(false);
});

test('legacy vault protection leases compare their encrypted record exactly', () => {
  const legacy: ProtectedVaultSecrets = {
    version: 1,
    iv: 'iv',
    ciphertext: 'ciphertext',
    unlockUntil: null,
  };
  expect(sameVaultProtectionLease(legacy, { ...legacy, unlockUntil: 10 })).toBe(true);
  expect(sameVaultProtectionLease(legacy, { ...legacy, ciphertext: 'other' })).toBe(false);
});

test('expired V2 lease deletes only its exact IndexedDB key before returning locked', async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const operations: Array<{ method: string; key: IDBValidKey }> = [];
  globalThis.indexedDB = installSuccessfulKeyDb(operations);
  try {
    const result = await unprotectVaultSecrets('Runtime-A', {
      version: 2,
      keyId: 'expired-key',
      iv: 'unused',
      ciphertext: 'unused',
      unlockUntil: 0,
    });

    expect(result).toBeNull();
    expect(operations).toEqual([{ method: 'delete', key: 'runtime-a:expired-key' }]);
  } finally {
    globalThis.indexedDB = previousIndexedDb;
  }
});

test('vault unlock leases encode ten minutes, one day, and forever exactly', async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousNow = Date.now;
  const operations: Array<{ method: string; key: IDBValidKey }> = [];
  globalThis.indexedDB = installSuccessfulKeyDb(operations);
  Date.now = () => 1_000_000;
  try {
    const tenMinutes = await protectVaultSecrets('runtime-a', { seed: 'ten-minute-secret' }, 600_000);
    const oneDay = await protectVaultSecrets('runtime-a', { seed: 'one-day-secret' }, 86_400_000);
    const forever = await protectVaultSecrets('runtime-a', { seed: 'forever-secret' }, null);

    expect(tenMinutes.unlockUntil).toBe(1_600_000);
    expect(oneDay.unlockUntil).toBe(87_400_000);
    expect(forever.unlockUntil).toBeNull();
    expect(operations.filter(operation => operation.method === 'put')).toHaveLength(3);
  } finally {
    Date.now = previousNow;
    globalThis.indexedDB = previousIndexedDb;
  }
});
