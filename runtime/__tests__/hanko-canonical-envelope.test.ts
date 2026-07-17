import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { encodeSignedHanko } from '../hanko/codec';
import { verifyCanonicalHanko } from '../hanko/claims';
import { verifyHankoForHash } from '../hanko/signing';

const KEYS = [1n, 2n].map((value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));
const THIRD_KEY = Buffer.from((3n).toString(16).padStart(64, '0'), 'hex');
const CANONICAL_KEYS = [KEYS[1]!, KEYS[0]!];
const BOARD_ABI = ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'];

const memberId = (key: Buffer): string =>
  ethers.zeroPadValue(new ethers.Wallet(ethers.hexlify(key)).address, 32).toLowerCase();

const boardId = (members: string[], weights: number[], threshold: number): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    BOARD_ABI,
    [[threshold, members, weights, 0, 0, 0]],
  )).toLowerCase();

const wireClaim = (entityId: string, entityIndexes: bigint[], weights: bigint[], threshold: bigint) => ({
  entityId: entityId as `0x${string}`,
  entityIndexes,
  weights,
  threshold,
  boardChangeDelay: 0n,
  controlChangeDelay: 0n,
  dividendChangeDelay: 0n,
});

const digest = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));

describe('minimal Hanko envelope', () => {
  test('accepts reordered recovered signer slots when indexes reconstruct the exact board', () => {
    const hash = digest('descending recovered signer slots');
    const members = KEYS.map(memberId);
    expect(members[0]! > members[1]!).toBe(true);
    const target = boardId(members, [60, 40], 100);
    const hanko = encodeSignedHanko({
      digest: hash,
      placeholders: [],
      privateKeys: KEYS,
      claims: [wireClaim(target, [0n, 1n], [60n, 40n], 100n)],
    });

    expect(verifyCanonicalHanko({ digest: hash, hanko, expectedTargetEntityId: target }).targetEntityId)
      .toBe(target);
  });

  test('accepts reordered placeholder slots when indexes reconstruct the exact board', () => {
    const hash = digest('descending placeholder slots');
    const signer = memberId(KEYS[1]!);
    const placeholders = [memberId(KEYS[0]!), memberId(THIRD_KEY)];
    expect(placeholders[0]! > placeholders[1]!).toBe(true);
    const target = boardId([signer, ...placeholders], [1, 1, 1], 1);
    const hanko = encodeSignedHanko({
      digest: hash,
      placeholders: placeholders as `0x${string}`[],
      privateKeys: [KEYS[1]!],
      claims: [wireClaim(target, [2n, 0n, 1n], [1n, 1n, 1n], 1n)],
    });

    expect(verifyCanonicalHanko({ digest: hash, hanko, expectedTargetEntityId: target }).targetEntityId)
      .toBe(target);
  });

  test('rejects an otherwise valid envelope with an unused signature slot', async () => {
    const hash = digest('unused signature slot');
    const target = boardId([memberId(KEYS[0]!)], [1], 1);
    const hanko = encodeSignedHanko({
      digest: hash,
      placeholders: [],
      privateKeys: CANONICAL_KEYS,
      claims: [wireClaim(target, [1n], [1n], 1n)],
    });

    expect((await verifyHankoForHash(hanko, hash, target)).valid).toBe(false);
  });

  test('rejects an otherwise valid envelope with an unused placeholder slot', async () => {
    const hash = digest('unused placeholder slot');
    const target = boardId([memberId(KEYS[0]!)], [1], 1);
    const hanko = encodeSignedHanko({
      digest: hash,
      placeholders: [memberId(KEYS[1]!) as `0x${string}`],
      privateKeys: [KEYS[0]!],
      claims: [wireClaim(target, [1n], [1n], 1n)],
    });

    expect((await verifyHankoForHash(hanko, hash, target)).valid).toBe(false);
  });

  test('rejects a valid but unreachable sibling claim', async () => {
    const hash = digest('unreachable sibling claim');
    const child = boardId([memberId(KEYS[0]!)], [1], 1);
    const target = boardId([memberId(KEYS[1]!)], [1], 1);
    const hanko = encodeSignedHanko({
      digest: hash,
      placeholders: [],
      privateKeys: CANONICAL_KEYS,
      claims: [
        wireClaim(child, [1n], [1n], 1n),
        wireClaim(target, [0n], [1n], 1n),
      ],
    });

    expect((await verifyHankoForHash(hanko, hash, target)).valid).toBe(false);
  });
});
