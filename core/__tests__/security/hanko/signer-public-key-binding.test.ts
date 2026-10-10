import { describe, expect, test } from 'bun:test';

import {
  clearSignerKeys,
  deriveSignerAddressSync,
  getLocalSignerPrivateKey,
  getSignerPublicKey,
  signAccountFrame,
  verifyAccountSignature,
} from '../../../account/crypto';

const digest = `0x${'ab'.repeat(32)}`;

describe('signer public-key binding', () => {
  test('a signature from another runtime never verifies for a different EOA signer id', () => {
    const attackerEnv = {
      runtimeSeed: 'signer-public-key-binding-attacker',
      quietRuntimeLogs: true,
    };
    const victimEnv = {
      runtimeSeed: 'signer-public-key-binding-victim',
      quietRuntimeLogs: true,
    };
    const victimId = deriveSignerAddressSync(victimEnv.runtimeSeed, '1');
    getSignerPublicKey(victimEnv, '1');

    try {
      const attackerSignature = signAccountFrame(attackerEnv, '1', digest);

      expect(verifyAccountSignature(attackerEnv, victimId, digest, attackerSignature)).toBe(false);
    } finally {
      clearSignerKeys(attackerEnv);
      clearSignerKeys(victimEnv);
    }
  });

  test('private EOA ownership never crosses independent runtime seeds in one process', () => {
    const ownerEnv = { runtimeSeed: 'signer-owner-runtime', quietRuntimeLogs: true };
    const otherEnv = { runtimeSeed: 'signer-other-runtime', quietRuntimeLogs: true };
    const ownerId = deriveSignerAddressSync(ownerEnv.runtimeSeed, '1');
    getSignerPublicKey(ownerEnv, '1');
    try {
      expect(getLocalSignerPrivateKey(ownerEnv, ownerId)).not.toBeNull();
      expect(getLocalSignerPrivateKey(otherEnv, ownerId)).toBeNull();
      expect(() => signAccountFrame(otherEnv, ownerId, digest)).toThrow('MISSING_SIGNER_KEY');
    } finally {
      clearSignerKeys(ownerEnv);
      clearSignerKeys(otherEnv);
    }
  });

  test('EOA verification after restart uses recovery without any key cache', () => {
    const env = { runtimeSeed: 'signer-restart-recovery', quietRuntimeLogs: true };
    const signerId = deriveSignerAddressSync(env.runtimeSeed, '1');
    const signature = signAccountFrame(env, '1', digest);
    clearSignerKeys(env);
    const restartedEnv = { quietRuntimeLogs: true };

    expect(verifyAccountSignature(restartedEnv, signerId, digest, signature)).toBe(true);
    expect(verifyAccountSignature(restartedEnv, `0x${'11'.repeat(20)}`, digest, signature)).toBe(false);
  });
});
