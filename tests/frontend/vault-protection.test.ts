import { expect, test } from 'bun:test';

import { redactVaultRuntimeForPersistence } from '../../frontend/src/lib/security/vaultProtection';

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
