import { describe, expect, test } from 'bun:test';

import {
  clearSignerKeys,
  deriveSignerAddressSync,
  getLocalSignerPrivateKey,
  getSignerPublicKey,
  registerSignerPublicKey,
  signAccountFrame,
  verifyAccountSignature,
} from '../account/crypto';

const digest = `0x${'ab'.repeat(32)}`;

describe('signer public-key binding', () => {
  test('an externally cached key cannot impersonate a different EOA signer id', () => {
    const attackerEnv = {
      runtimeSeed: 'signer-public-key-binding-attacker',
      quietRuntimeLogs: true,
    };
    const victimEnv = {
      runtimeSeed: 'signer-public-key-binding-victim',
      quietRuntimeLogs: true,
    };
    const victimId = deriveSignerAddressSync(victimEnv.runtimeSeed, '1');
    const attackerPublicKey = getSignerPublicKey(attackerEnv, '1');
    if (!attackerPublicKey) throw new Error('TEST_ATTACKER_PUBLIC_KEY_MISSING');
    const victimPublicKey = getSignerPublicKey(victimEnv, '1');
    if (!victimPublicKey) throw new Error('TEST_VICTIM_PUBLIC_KEY_MISSING');

    try {
      expect(() => registerSignerPublicKey(victimEnv, victimId, attackerPublicKey)).toThrow(
        'SIGNER_PUBLIC_KEY_MISMATCH',
      );
      registerSignerPublicKey(victimEnv, victimId, victimPublicKey);
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

  test('external public-key registration rejects aliases without cryptographic identity', () => {
    const env = { runtimeSeed: 'signer-alias-rejection' };
    const publicKey = getSignerPublicKey(env, '1');
    if (!publicKey) throw new Error('TEST_PUBLIC_KEY_MISSING');
    try {
      expect(() => registerSignerPublicKey(env, 'alice', publicKey)).toThrow(
        'SIGNER_PUBLIC_KEY_ID_NOT_EOA',
      );
    } finally {
      clearSignerKeys(env);
    }
  });
});
