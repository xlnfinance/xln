import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import type { HankoWireClaim } from '../types/hanko';
import { encodeSignedHanko } from '../hanko/codec';
import { hashHankoBoardClaim, resolveHankoBoardDelays, verifyCanonicalHanko } from '../hanko/claims';
import { verifyHankoForHash } from '../hanko/signing';

const KEYS = [1n, 2n, 3n].map((value) => ethers.getBytes(ethers.toBeHex(value, 32)));
const signerId = (index: number) => ethers.zeroPadValue(
  new ethers.Wallet(ethers.hexlify(KEYS[index]!)).address,
  32,
).toLowerCase() as `0x${string}`;
const delays = resolveHankoBoardDelays();
const digest = (label: string): `0x${string}` => ethers.keccak256(ethers.toUtf8Bytes(label));

const claimId = (
  members: readonly { entityId: `0x${string}`; weight: bigint }[],
  threshold: bigint,
): `0x${string}` => hashHankoBoardClaim({
  entityId: ethers.ZeroHash,
  members,
  threshold,
  delays,
});

const wireClaim = (
  entityId: `0x${string}`,
  entityIndexes: readonly bigint[],
  weights: readonly bigint[],
  threshold: bigint,
): HankoWireClaim => ({ entityId, entityIndexes, weights, threshold, ...delays });

const encode = (
  hash: string,
  privateKeys: readonly Uint8Array[],
  placeholders: readonly `0x${string}`[],
  claims: readonly HankoWireClaim[],
) => encodeSignedHanko({ digest: hash, privateKeys, placeholders, claims });

describe('recursive Hanko claims', () => {
  test('preserves an exact bytes32 child ID in an EOA-anchored parent Board hash', () => {
    const child = claimId([{ entityId: signerId(0), weight: 1n }], 1n);
    const parent = claimId([
      { entityId: signerId(1), weight: 40n },
      { entityId: child, weight: 60n },
    ], 60n);
    expect(parent).toBe(hashHankoBoardClaim({
      entityId: ethers.ZeroHash,
      members: [
        { entityId: signerId(1), weight: 40n },
        { entityId: child, weight: 60n },
      ],
      threshold: 60n,
      delays,
    }));
  });

  test('gives configured parent weight to an independently verified child quorum', async () => {
    const hash = digest('recursive-child-parent');
    const child = claimId([{ entityId: signerId(0), weight: 1n }], 1n);
    const parent = claimId([
      { entityId: signerId(1), weight: 40n },
      { entityId: child, weight: 60n },
    ], 60n);
    const hanko = encode(hash, [KEYS[0]!], [signerId(1)], [
      wireClaim(child, [1n], [1n], 1n),
      wireClaim(parent, [0n, 2n], [40n, 60n], 60n),
    ]);
    expect((await verifyHankoForHash(hanko, hash, parent)).valid).toBe(true);
  });

  test('binds a registered child to explicit board authority', () => {
    const hash = digest('registered-child-parent');
    const child = ethers.zeroPadValue('0x2a', 32).toLowerCase() as `0x${string}`;
    const childBoard = claimId([{ entityId: signerId(0), weight: 1n }], 1n);
    const parent = claimId([
      { entityId: signerId(1), weight: 1n },
      { entityId: child, weight: 1n },
    ], 1n);
    const hanko = encode(hash, [KEYS[0]!], [signerId(1)], [
      wireClaim(child, [1n], [1n], 1n),
      wireClaim(parent, [0n, 2n], [1n, 1n], 1n),
    ]);
    expect(() => verifyCanonicalHanko({ digest: hash, hanko })).toThrow('HANKO_BOARD_AUTHORITY_INVALID');
    expect(verifyCanonicalHanko({
      digest: hash,
      hanko,
      validateBoardAuthority: (entityId, boardHash) => entityId === child && boardHash === childBoard,
    }).targetEntityId).toBe(parent);
  });

  test('rejects self/future references and an Entity at proposer index zero', () => {
    const hash = digest('recursive-cycle');
    const child = claimId([{ entityId: signerId(0), weight: 1n }], 1n);
    const parent = claimId([
      { entityId: signerId(1), weight: 1n },
      { entityId: child, weight: 1n },
    ], 1n);
    const future = encode(hash, [KEYS[0]!], [signerId(1)], [
      wireClaim(parent, [0n, 3n], [1n, 1n], 1n),
      wireClaim(child, [1n], [1n], 1n),
    ]);
    expect(() => verifyCanonicalHanko({ digest: hash, hanko: future }))
      .toThrow('HANKO_CLAIM_ORDER_INVALID');

    const entityFirst = encode(hash, [KEYS[0]!], [], [
      wireClaim(child, [0n], [1n], 1n),
      wireClaim(parent, [1n], [1n], 1n),
    ]);
    expect(() => verifyCanonicalHanko({ digest: hash, hanko: entityFirst }))
      .toThrow('HANKO_FIRST_MEMBER_EOA_REQUIRED');
  });

  test('allows a future/back-edge Entity only as a zero-power placeholder', () => {
    const hash = digest('recursive-placeholder-back-edge');
    const future = ethers.keccak256(ethers.toUtf8Bytes('future entity')) as `0x${string}`;
    const entity = claimId([
      { entityId: signerId(0), weight: 1n },
      { entityId: future, weight: 1n },
    ], 1n);
    const hanko = encode(hash, [KEYS[0]!], [future], [
      wireClaim(entity, [1n, 0n], [1n, 1n], 1n),
    ]);
    expect(verifyCanonicalHanko({ digest: hash, hanko }).targetEntityId).toBe(entity);
  });

  test('requires the expected target last and rejects duplicate claim/index material', async () => {
    const hash = digest('recursive-target-and-duplicates');
    const first = claimId([{ entityId: signerId(0), weight: 1n }], 1n);
    const second = claimId([{ entityId: signerId(1), weight: 1n }], 1n);
    const sibling = encode(hash, [KEYS[0]!, KEYS[1]!], [], [
      wireClaim(first, [0n], [1n], 1n),
      wireClaim(second, [1n], [1n], 1n),
    ]);
    expect((await verifyHankoForHash(sibling, hash, first)).valid).toBe(false);

    const duplicateClaim = encode(hash, [KEYS[0]!], [], [
      wireClaim(first, [0n], [1n], 1n),
      wireClaim(first, [0n], [1n], 1n),
    ]);
    expect(() => verifyCanonicalHanko({ digest: hash, hanko: duplicateClaim }))
      .toThrow('HANKO_DUPLICATE_CLAIM_ENTITY');

    const duplicateIndex = encode(hash, [KEYS[0]!], [], [
      wireClaim(first, [0n, 0n], [1n, 1n], 1n),
    ]);
    expect(() => verifyCanonicalHanko({ digest: hash, hanko: duplicateIndex }))
      .toThrow('HANKO_DUPLICATE_ENTITY_INDEX');
  });
});
