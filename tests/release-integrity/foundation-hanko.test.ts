import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  buildReleaseHanko,
  computeReleaseEnvelopeHash,
  createFoundationReleaseBoard,
  signReleaseEnvelope,
  verifyReleaseAttestation,
  type ReleaseEnvelope,
} from '../../frontend/src/lib/releases/release-signature.ts';

const PRIVATE_KEYS = [
  `0x${'01'.padStart(64, '0')}`,
  `0x${'02'.padStart(64, '0')}`,
  `0x${'03'.padStart(64, '0')}`,
];
const ADDRESSES = PRIVATE_KEYS.map((key) => ethers.computeAddress(new ethers.SigningKey(key).publicKey));
const ENVELOPE: ReleaseEnvelope = {
  version: '0.1.7',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  codeSnapshotRoot: `0x${'11'.repeat(32)}`,
  frozenCoreRoot: `0x${'22'.repeat(32)}`,
  generatedAt: '2026-07-11T00:00:00.000Z',
};

describe('Foundation release Hanko', () => {
  test('produces an EntityProvider-compatible 2-of-3 lazy entity proof', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const attestation = signReleaseEnvelope(ENVELOPE, board, PRIVATE_KEYS);
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
      attestation.hanko,
    );

    expect(board.entityId).toBe(board.boardHash);
    expect(attestation.signerCount).toBe(2);
    expect(decoded[0][0]).toHaveLength(1);
    expect(verifyReleaseAttestation(attestation)).toBe(true);
  });

  test('rejects envelope and Hanko tampering', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const attestation = signReleaseEnvelope(ENVELOPE, board, PRIVATE_KEYS);
    expect(verifyReleaseAttestation({ ...attestation, envelope: { ...ENVELOPE, version: '0.1.8' } })).toBe(false);
    expect(verifyReleaseAttestation({ ...attestation, hanko: `${attestation.hanko.slice(0, -2)}00` })).toBe(false);
  });

  test('hash and packed Hanko are deterministic for fixed inputs', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const hash = computeReleaseEnvelopeHash(ENVELOPE);
    expect(buildReleaseHanko(hash, board, PRIVATE_KEYS)).toEqual(buildReleaseHanko(hash, board, PRIVATE_KEYS));
  });
});
