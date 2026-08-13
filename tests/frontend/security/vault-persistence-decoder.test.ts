import { expect, test } from 'bun:test';
import {
  decodePersistedRuntime,
  decodePersistedVaultState,
} from '../../../frontend/src/lib/stores/vault/vault-persistence-decoder';

const persistedRuntime = {
  id: '0x0000000000000000000000000000000000000001',
  label: 'Alice',
  signers: [{ index: 0, address: '0x0000000000000000000000000000000000000001', name: 'Alice' }],
  activeSignerIndex: 0,
  loginType: 'manual',
  requiresOnboarding: true,
  createdAt: 1,
};

test('persisted vault runtime is rebuilt only from exact whitelisted metadata', () => {
  const decoded = decodePersistedRuntime(persistedRuntime, persistedRuntime.id);
  expect(decoded.id).toBe(persistedRuntime.id);
  expect(decoded.seed).toBe('');
  expect(decoded.signers).toHaveLength(1);
  expect(() => decodePersistedRuntime({ ...persistedRuntime, privateKey: 'secret' }, persistedRuntime.id))
    .toThrow('VAULT_STORAGE_RUNTIME_KEYS_INVALID');
  expect(() => decodePersistedRuntime({ ...persistedRuntime, signers: [{ ...persistedRuntime.signers[0], index: '0' }] }, persistedRuntime.id))
    .toThrow('VAULT_SIGNER_INDEX_INVALID');
  expect(() => decodePersistedRuntime({ ...persistedRuntime, id: undefined }, persistedRuntime.id))
    .toThrow('VAULT_STORAGE_RUNTIME_ID_INVALID');
  expect(() => decodePersistedRuntime({ ...persistedRuntime, id: '0x0000000000000000000000000000000000000002' }, persistedRuntime.id))
    .toThrow('VAULT_STORAGE_RUNTIME_ID_KEY_MISMATCH');
  expect(() => decodePersistedRuntime({ ...persistedRuntime, activeSignerIndex: 1 }, persistedRuntime.id))
    .toThrow('VAULT_STORAGE_ACTIVE_SIGNER_OUT_OF_RANGE');
});

test('persisted vault root requires one exact active runtime identity', () => {
  const state = decodePersistedVaultState({
    activeRuntimeId: persistedRuntime.id,
    runtimes: { [persistedRuntime.id]: persistedRuntime },
  });
  expect(state.activeRuntimeId).toBe(persistedRuntime.id);
  expect(Object.keys(state.runtimes)).toEqual([persistedRuntime.id]);

  expect(decodePersistedVaultState({ activeRuntimeId: null, runtimes: {} }))
    .toEqual({ activeRuntimeId: null, runtimes: {} });
  expect(() => decodePersistedVaultState({
    activeRuntimeId: '0x0000000000000000000000000000000000000002',
    runtimes: { [persistedRuntime.id]: persistedRuntime },
  })).toThrow('VAULT_STORAGE_ACTIVE_RUNTIME_INVALID');
  expect(() => decodePersistedVaultState({
    activeRuntimeId: persistedRuntime.id,
    runtimes: { [persistedRuntime.id.toUpperCase()]: persistedRuntime },
  })).toThrow('VAULT_STORAGE_RUNTIME_ID_KEY_MISMATCH');
  expect(() => decodePersistedVaultState({
    activeRuntimeId: persistedRuntime.id,
    runtimes: { [persistedRuntime.id]: persistedRuntime },
    seed: 'forbidden',
  })).toThrow('VAULT_STORAGE_ROOT_KEYS_INVALID');
});
