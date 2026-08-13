import { expect, test } from 'bun:test';
import { decodePersistedRuntime } from '../../../frontend/src/lib/stores/vault/vault-persistence-decoder';

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
});
