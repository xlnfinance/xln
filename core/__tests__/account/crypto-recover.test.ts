import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { hmacSha256 } from '../../protocol/crypto/fast/fast-sha256';
import { recoverDigestSignerAddress } from '../../account/crypto';

const ethersRecover = (digest: string, signature: string): string | null => {
  try {
    return ethers.recoverAddress(digest, signature).toLowerCase();
  } catch {
    return null;
  }
};

describe('recoverDigestSignerAddress', () => {
  test('matches ethers.recoverAddress for v=0/1 and v=27/28 signatures', () => {
    for (let round = 0; round < 200; round += 1) {
      const key = new ethers.SigningKey(ethers.hexlify(ethers.randomBytes(32)));
      const digest = ethers.hexlify(ethers.randomBytes(32));
      const signed = key.sign(digest);
      const compact = ethers.concat([signed.r, signed.s]);
      for (const v of [signed.v, signed.v - 27]) {
        const signature = ethers.concat([compact, ethers.toBeHex(v, 1)]);
        expect(recoverDigestSignerAddress(digest, signature)).toBe(ethersRecover(digest, signature));
        expect(recoverDigestSignerAddress(digest, signature)).toBe(key.publicKey && ethers.computeAddress(key.publicKey).toLowerCase());
        // Wrong recovery bit recovers a different address on both backends (or neither).
        const flipped = ethers.concat([compact, ethers.toBeHex(v ^ 1, 1)]);
        expect(recoverDigestSignerAddress(digest, flipped)).toBe(ethersRecover(digest, flipped));
      }
      // EIP-2098 compact form is accepted by ethers too.
      const compact2098 = ethers.Signature.from(signed).compactSerialized;
      expect(recoverDigestSignerAddress(digest, compact2098)).toBe(ethersRecover(digest, compact2098));
    }
  });

  test('rejects what ethers rejects', () => {
    const key = new ethers.SigningKey(ethers.hexlify(ethers.randomBytes(32)));
    const digest = ethers.hexlify(ethers.randomBytes(32));
    const signed = key.sign(digest);
    const bad = [
      ethers.concat([signed.r, signed.s, '0x02']),
      ethers.concat([signed.r, '0x' + 'ff'.repeat(32), '0x00']),
      '0x1234',
      ethers.concat(['0x' + '00'.repeat(32), signed.s, '0x00']),
      ethers.concat(['0x' + 'ff'.repeat(32), signed.s, '0x00']),
    ];
    for (const signature of bad) {
      expect(recoverDigestSignerAddress(digest, signature)).toBe(ethersRecover(digest, signature));
      expect(recoverDigestSignerAddress(digest, signature)).toBeNull();
    }
    expect(recoverDigestSignerAddress('0x12', ethers.concat([signed.r, signed.s, '0x00']))).toBeNull();
  });
});

// RFC 4231 case 1: backend selection must preserve the cryptographic primitive.
test('HMAC-SHA256 matches the independent known-answer vector', () => {
  expect(ethers.hexlify(hmacSha256(new Uint8Array(20).fill(0x0b), new TextEncoder().encode('Hi There'))))
    .toBe('0xb0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});
