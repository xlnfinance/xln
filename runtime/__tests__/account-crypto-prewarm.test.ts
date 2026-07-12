import { describe, expect, test } from 'bun:test';
import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  getSignerPrivateKey,
  prewarmSignerLabels,
  registerSignerKey,
  signDigest,
} from '../account/crypto';

describe('signer cache prewarm', () => {
  test('registers deterministic label-derived EOA signers for restored runtime signing', () => {
    const seed = 'signer-prewarm-restore-seed';
    const labels = ['hub-1', 'hub-1', 'hub-1:Tron (local anvil)'];
    const expected = [
      deriveSignerAddressSync(seed, labels[0]!).toLowerCase(),
      deriveSignerAddressSync(seed, labels[2]!).toLowerCase(),
    ];

    expect(prewarmSignerLabels(seed, labels)).toEqual(expected);

    const digest = `0x${'11'.repeat(32)}`;
    for (const signerId of expected) {
      expect(signDigest(seed, signerId, digest)).toMatch(/^0x[0-9a-f]+$/);
    }
  });

  test('keeps numeric signer derivation scoped to the runtime seed', () => {
    const signerId = '2';
    const firstSeed = 'numeric-cache-runtime-a';
    const secondSeed = 'numeric-cache-runtime-b';
    clearSignerKeys();
    try {
      registerSignerKey(signerId, deriveSignerKeySync(firstSeed, signerId));
      const secondPrivateKey = getSignerPrivateKey({ runtimeSeed: secondSeed }, signerId);
      expect(Buffer.from(secondPrivateKey).toString('hex')).toBe(
        Buffer.from(deriveSignerKeySync(secondSeed, signerId)).toString('hex'),
      );
      expect(Buffer.from(secondPrivateKey).toString('hex')).not.toBe(
        Buffer.from(deriveSignerKeySync(firstSeed, signerId)).toString('hex'),
      );
    } finally {
      clearSignerKeys();
    }
  });
});
