import { afterAll, expect, test } from 'bun:test';
import { VAULT_KEY_DATABASE, VAULT_STORAGE_KEY } from '../../frontend/src/lib/contracts/browserPersistence';
import {
  lockVaultRuntime,
  protectVaultRuntime,
  unlockVaultRuntime,
  vaultLockDelayMs,
} from '../../frontend/packages/runtime-client/vault-lifecycle';
import { serializeVaultState } from '../../frontend/src/lib/stores/vault-recovery';
import {
  runtimesStateExternalStore,
  vaultOperations,
  vaultStorageLoadedExternalStore,
  type Runtime,
} from '../../frontend/src/lib/stores/vaultStore';

const originalLocalStorage = globalThis.localStorage;
const values = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: key => values.get(key) ?? null,
  key: index => Array.from(values.keys())[index] ?? null,
  removeItem: key => { values.delete(key); },
  setItem: (key, value) => { values.set(key, String(value)); },
};

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage });

afterAll(() => {
  if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
  else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
});

test('vault persistence contract and serialized value retain their exact origin-bound format', () => {
  expect(VAULT_STORAGE_KEY).toBe('xln-vaults');
  expect(VAULT_KEY_DATABASE).toEqual({ name: 'xln-vault-keys-v1', version: 1, stores: ['keys'] });

  const id = '0x1111111111111111111111111111111111111111';
  const runtime: Runtime = {
    id,
    label: 'Wallet',
    seed: 'fixture secret seed',
    mnemonic12: 'fixture mnemonic twelve',
    devicePassphrase: 'fixture device passphrase',
    signers: [],
    activeSignerIndex: 0,
    createdAt: 7,
    protectedSecrets: {
      version: 1,
      keyId: 'key-1',
      iv: 'iv-1',
      ciphertext: 'ciphertext-1',
      unlockUntil: null,
    },
  };
  const serialized = serializeVaultState({ activeRuntimeId: id, runtimes: { [id]: runtime } });

  expect(serialized).toBe(JSON.stringify({
    activeRuntimeId: id,
    runtimes: {
      [id]: {
        id,
        label: 'Wallet',
        signers: [],
        activeSignerIndex: 0,
        createdAt: 7,
        protectedSecrets: runtime.protectedSecrets,
      },
    },
  }));
  expect(serialized).not.toContain('fixture secret');
  expect(serialized).not.toContain('fixture mnemonic');
  expect(serialized).not.toContain('fixture device');
});

test('vault load accepts the existing schema and rejects corrupt JSON by clearing it loudly', () => {
  const id = '0x2222222222222222222222222222222222222222';
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify({
    activeRuntimeId: id.toUpperCase(),
    runtimes: {
      [id]: { id, label: 'Locked', signers: [], activeSignerIndex: 0, createdAt: 9 },
    },
  }));
  vaultOperations.loadFromStorage();
  expect(runtimesStateExternalStore.getSnapshot()).toMatchObject({
    activeRuntimeId: id,
    runtimes: { [id]: { id, label: 'Locked', seed: '' } },
  });
  expect(vaultStorageLoadedExternalStore.getSnapshot()).toBe(true);

  localStorage.setItem(VAULT_STORAGE_KEY, '{broken');
  vaultOperations.loadFromStorage();
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBeNull();
  expect(runtimesStateExternalStore.getSnapshot()).toEqual({ runtimes: {}, activeRuntimeId: null });
});

test('vault lifecycle reducers replay lock and unlock without mutation or ambient time', () => {
  const locked = Object.freeze({ id: 'runtime-a', seed: '', protectedSecrets: { keyId: 'key-a' } });
  const unlocked = unlockVaultRuntime(locked, { seed: 'secret-a', mnemonic12: 'mnemonic-a' });
  const protectedRuntime = protectVaultRuntime(unlocked, { keyId: 'key-b' });
  const relocked = lockVaultRuntime(protectedRuntime);

  expect(locked).toEqual({ id: 'runtime-a', seed: '', protectedSecrets: { keyId: 'key-a' } });
  expect(unlocked).toMatchObject({ seed: 'secret-a', mnemonic12: 'mnemonic-a' });
  expect(protectedRuntime).toMatchObject({ protectedSecrets: { keyId: 'key-b' } });
  expect(relocked).toEqual({ id: 'runtime-a', seed: '', protectedSecrets: { keyId: 'key-b' } });
  expect(vaultLockDelayMs(1_000, 250)).toBe(750);
  expect(vaultLockDelayMs(1_000, 1_500)).toBe(0);
});
