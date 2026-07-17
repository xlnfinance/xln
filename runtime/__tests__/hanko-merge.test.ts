import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { encodeSignedHanko } from '../hanko/codec';
import {
  hashHankoBoardClaim,
  resolveHankoBoardDelays,
  verifyCanonicalHanko,
} from '../hanko/claims';
import { mergeHankoFragments } from '../hanko/merge';

const KEYS = [1n, 2n].map((value) => ethers.getBytes(ethers.toBeHex(value, 32)));
const delays = resolveHankoBoardDelays();
const signerId = (key: Uint8Array) => ethers.zeroPadValue(
  new ethers.Wallet(ethers.hexlify(key)).address,
  32,
).toLowerCase() as `0x${string}`;
const boardId = (members: readonly { entityId: `0x${string}`; weight: bigint }[], threshold: bigint) =>
  hashHankoBoardClaim({ entityId: ethers.ZeroHash, members, threshold, delays });

describe('canonical Hanko merge', () => {
  test('rejects two board definitions for the same Entity claim', () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes('merge claim conflict'));
    const targetEntityId = ethers.zeroPadValue('0x2a', 32);
    const fragments = KEYS.map((key) => encodeSignedHanko({
      digest,
      placeholders: [],
      privateKeys: [key],
      claims: [{
        entityId: targetEntityId as `0x${string}`,
        entityIndexes: [0n],
        weights: [1n],
        threshold: 1n,
        boardChangeDelay: 0n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      }],
    }));

    expect(() => mergeHankoFragments({ digest, targetEntityId, fragments }))
      .toThrow('HANKO_MERGE_CLAIM_CONFLICT');
  });

  test('merges signer fragments commutatively and idempotently', () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes('merge two signer quorum'));
    const members = KEYS.map((key) => ({ entityId: signerId(key), weight: 1n }));
    const targetEntityId = boardId(members, 2n);
    const fragments = KEYS.map((key, signerIndex) => {
      const otherIndex = signerIndex === 0 ? 1 : 0;
      return encodeSignedHanko({
        digest,
        privateKeys: [key],
        placeholders: [members[otherIndex]!.entityId],
        claims: [{
          entityId: targetEntityId,
          entityIndexes: signerIndex === 0 ? [1n, 0n] : [0n, 1n],
          weights: [1n, 1n],
          threshold: 2n,
          ...delays,
        }],
      });
    });
    const first = mergeHankoFragments({ digest, targetEntityId, fragments });
    const reversed = mergeHankoFragments({ digest, targetEntityId, fragments: [...fragments].reverse() });
    const repeated = mergeHankoFragments({ digest, targetEntityId, fragments: [...fragments, fragments[0]!] });
    expect(first.complete && first.hanko).toBe(reversed.complete && reversed.hanko);
    expect(first.complete && first.hanko).toBe(repeated.complete && repeated.hanko);
    expect(first.complete).toBe(true);
    if (first.complete) expect(verifyCanonicalHanko({ digest, hanko: first.hanko }).targetEntityId).toBe(targetEntityId);
  });

  test('finalizes child-before-parent with configured parent weight', () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes('merge recursive quorum'));
    const bob = signerId(KEYS[0]!);
    const carol = signerId(KEYS[1]!);
    const alice = ethers.zeroPadValue('0x1234567890123456789012345678901234567890', 32).toLowerCase() as `0x${string}`;
    const childId = boardId([{ entityId: bob, weight: 1n }, { entityId: carol, weight: 1n }], 2n);
    const parentId = boardId([{ entityId: alice, weight: 40n }, { entityId: childId, weight: 60n }], 60n);
    const fragments = KEYS.map((key, signerIndex) => {
      const other = signerIndex === 0 ? carol : bob;
      return encodeSignedHanko({
        digest,
        privateKeys: [key],
        placeholders: [alice, other],
        claims: [
          {
            entityId: childId,
            entityIndexes: signerIndex === 0 ? [2n, 1n] : [1n, 2n],
            weights: [1n, 1n],
            threshold: 2n,
            ...delays,
          },
          {
            entityId: parentId,
            entityIndexes: [0n, 3n],
            weights: [40n, 60n],
            threshold: 60n,
            ...delays,
          },
        ],
      });
    });
    const merged = mergeHankoFragments({ digest, targetEntityId: parentId, fragments });
    expect(merged.complete).toBe(true);
    if (!merged.complete) return;
    const verified = verifyCanonicalHanko({ digest, hanko: merged.hanko });
    expect(verified.claims.map((claim) => claim.entityId)).toEqual([childId, parentId]);
    expect(verified.claims[1]?.votingPower).toBe(60n);
  });
});
