import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  decodeHankoEnvelope,
  encodeHankoEnvelope,
  encodeSignedHanko,
  packHankoSignatures,
  recoverHankoSignatures,
  unpackHankoSignatures,
} from '../hanko/codec';
import { hashHankoBoardClaim } from '../hanko/claims';

const digest = ethers.keccak256(ethers.toUtf8Bytes('canonical Hanko codec'));

const signature = (index: number): Uint8Array => {
  const key = new ethers.SigningKey(ethers.toBeHex(index + 1, 32));
  const signed = key.sign(digest);
  return ethers.getBytes(ethers.concat([signed.r, signed.s, ethers.toBeHex(signed.v, 1)]));
};

describe('canonical Hanko wire codec', () => {
  test('matches the independently pinned v1 Board and envelope golden hashes', () => {
    const key = ethers.getBytes(ethers.toBeHex(1n, 32));
    const goldenDigest = ethers.keccak256(ethers.toUtf8Bytes('xln:hanko:v1:golden'));
    const member = ethers.zeroPadValue(new ethers.Wallet(ethers.hexlify(key)).address, 32).toLowerCase() as `0x${string}`;
    const delays = { boardChangeDelay: 11n, controlChangeDelay: 12n, dividendChangeDelay: 13n };
    const entityId = hashHankoBoardClaim({
      entityId: ethers.ZeroHash,
      members: [{ entityId: member, weight: 1n }],
      threshold: 1n,
      delays,
    });
    const hanko = encodeSignedHanko({
      digest: goldenDigest,
      privateKeys: [key],
      placeholders: [],
      claims: [{ entityId, entityIndexes: [0n], weights: [1n], threshold: 1n, ...delays }],
    });
    expect(entityId).toBe('0xe3d6aa2ac02777d0796e2996d73c3e203011357aff8b877ee86beab827a8e4f0');
    expect(ethers.keccak256(hanko)).toBe('0x560d730cce926ec199d5dc8386d2494414ff218ebb940c9d2a69d3b6a08964fb');
  });

  test('round-trips the canonical Solidity tuple including exact Board delays', () => {
    const encoded = encodeHankoEnvelope({
      placeholders: [ethers.zeroPadValue('0x1234', 32)],
      packedSignatures: packHankoSignatures([signature(0)]),
      claims: [{
        entityId: ethers.zeroPadValue('0x2a', 32),
        entityIndexes: [0n, 1n],
        weights: [3n, 5n],
        threshold: 5n,
        boardChangeDelay: 11n,
        controlChangeDelay: 12n,
        dividendChangeDelay: 13n,
      }],
    });

    const decoded = decodeHankoEnvelope(encoded);
    expect(encodeHankoEnvelope(decoded)).toBe(encoded);
    expect(decoded.claims[0]?.weights).toEqual([3n, 5n]);
    expect(decoded.claims[0]?.dividendChangeDelay).toBe(13n);
  });

  test('packs V bits canonically across the 8/9 signature boundary', () => {
    for (const count of [1, 8, 9]) {
      const signatures = Array.from({ length: count }, (_, index) => signature(index))
        .sort((left, right) => (
          ethers.recoverAddress(digest, ethers.hexlify(left)).toLowerCase()
            .localeCompare(ethers.recoverAddress(digest, ethers.hexlify(right)).toLowerCase())
        ));
      const packed = packHankoSignatures(signatures);
      expect(unpackHankoSignatures(packed).map(ethers.getBytes)).toEqual(signatures);
      expect(recoverHankoSignatures(digest, packed)).toHaveLength(count);
    }
  });

  test('rejects non-zero unused V bits and trailing ABI bytes', () => {
    const packed = ethers.getBytes(packHankoSignatures([signature(0)]));
    packed[packed.length - 1] = packed[packed.length - 1]! | 0x80;
    expect(() => unpackHankoSignatures(ethers.hexlify(packed)))
      .toThrow('HANKO_PACKED_SIGNATURE_PADDING_NONZERO');

    const encoded = encodeHankoEnvelope({
      placeholders: [],
      packedSignatures: packHankoSignatures([signature(0)]),
      claims: [[1n]].map(() => ({
        entityId: ethers.zeroPadValue('0x2a', 32),
        entityIndexes: [0n],
        weights: [1n],
        threshold: 1n,
        boardChangeDelay: 0n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      })),
    });
    expect(() => decodeHankoEnvelope(`${encoded}00`)).toThrow('HANKO_ABI_NON_CANONICAL');
  });
});
