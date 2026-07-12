import { expect, test } from 'bun:test';

import {
  redactVaultRuntimeForPersistence,
  sameVaultProtectionLease,
  type ProtectedVaultSecrets,
} from '../../frontend/src/lib/security/vaultProtection';

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
