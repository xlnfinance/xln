import { describe, expect, test } from 'bun:test';
import {
  deriveSignerAddressSync,
  prewarmSignerLabels,
  signDigest,
} from '../account-crypto';

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
});
