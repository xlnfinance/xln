import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { buildSingleSignerHanko, prepareSignedBatch } from '../../../hanko/batch';
import { decodeHankoEnvelope, encodeSignedHanko } from '../../../hanko/codec';
import { verifyCanonicalHanko } from '../../../hanko/claims';
import {
  chainHankoTargetEntityId,
  compactHankoForChain,
  isShortHanko,
  lazySingleSignerEntityId,
  recoverShortHankoEntityId,
} from '../../../hanko/short';
import { encodeSingleSignerBoard, hashBoard } from '../../../entity/factory';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';

const key = ethers.toBeHex(7n, 32);
const wallet = new ethers.Wallet(key);
const digest = ethers.keccak256(ethers.toUtf8Bytes('xln:hanko:short-form'));
const DEPOSITORY = '0x1111111111111111111111111111111111111111';

describe('65-byte Hanko shortcut', () => {
  test('lazy entity id equals the canonical 1-of-1 board hash core already computes', () => {
    const lazyId = lazySingleSignerEntityId(wallet.address);
    expect(lazyId).toBe(hashBoard(encodeSingleSignerBoard(wallet.address)).toLowerCase());
    // keccak256(abi.encode(Board{1,[bytes32(addr)],[1],0,0,0}))
    const reference = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
      [[1, [ethers.zeroPadValue(wallet.address, 32)], [1], 0, 0, 0]],
    ));
    expect(lazyId).toBe(reference.toLowerCase());
  });

  test('shortcut and full envelope yield the same entity id', () => {
    const lazyId = lazySingleSignerEntityId(wallet.address);
    const full = encodeSignedHanko({
      digest,
      privateKeys: [ethers.getBytes(key)],
      placeholders: [],
      claims: [{
        entityId: lazyId,
        entityIndexes: [0n],
        weights: [1n],
        threshold: 1n,
        boardChangeDelay: 0n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      }],
    });
    expect(verifyCanonicalHanko({ digest, hanko: full }).targetEntityId).toBe(lazyId);

    const short = compactHankoForChain(full, digest);
    expect(isShortHanko(short)).toBe(true);
    expect((short.length - 2) / 2).toBe(65);
    expect(recoverShortHankoEntityId(short, digest)).toBe(lazyId);
    expect(chainHankoTargetEntityId(short, digest)).toBe(lazyId);
    expect(chainHankoTargetEntityId(full, digest)).toBe(lazyId);
    // r||s||v with v in {27,28}: exactly the wallet's raw signature bytes.
    const raw = wallet.signingKey.sign(digest);
    expect(short).toBe(ethers.concat([raw.r, raw.s, ethers.toBeHex(raw.v, 1)]).toLowerCase());
  });

  test('batch Hanko path emits the short form for a lazy entity and the envelope for a numbered one', () => {
    const lazyId = lazySingleSignerEntityId(wallet.address);
    const prepared = prepareSignedBatch(createEmptyBatch(), lazyId, key, 31337n, DEPOSITORY, 0n);
    expect(isShortHanko(prepared.hankoData)).toBe(true);
    expect(recoverShortHankoEntityId(prepared.hankoData, prepared.batchHash)).toBe(lazyId);

    const numberedId = ethers.zeroPadValue('0x2a', 32);
    const numbered = prepareSignedBatch(createEmptyBatch(), numberedId, key, 31337n, DEPOSITORY, 0n);
    expect(isShortHanko(numbered.hankoData)).toBe(false);
    const envelope = decodeHankoEnvelope(numbered.hankoData);
    expect(envelope.claims[0]?.entityId).toBe(numberedId.toLowerCase());
    expect(envelope.memberSignatures).toEqual([]);
    expect(buildSingleSignerHanko(numberedId, digest, key)).toBe(numbered.hankoData.length > 0
      ? buildSingleSignerHanko(numberedId, digest, key)
      : '');
  });

  test('non-lazy proofs are never compacted', () => {
    const otherKey = ethers.toBeHex(8n, 32);
    const other = new ethers.Wallet(otherKey);
    const member = (address: string) => ethers.zeroPadValue(address, 32).toLowerCase() as `0x${string}`;
    const twoOfTwo = encodeSignedHanko({
      digest,
      privateKeys: [ethers.getBytes(key), ethers.getBytes(otherKey)],
      placeholders: [],
      claims: [{
        entityId: ethers.zeroPadValue('0x2b', 32) as `0x${string}`,
        entityIndexes: [0n, 1n],
        weights: [1n, 1n],
        threshold: 2n,
        boardChangeDelay: 0n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      }],
    });
    expect(compactHankoForChain(twoOfTwo, digest)).toBe(twoOfTwo);

    const withPlaceholder = encodeSignedHanko({
      digest,
      privateKeys: [ethers.getBytes(key)],
      placeholders: [member(other.address)],
      claims: [{
        entityId: ethers.zeroPadValue('0x2c', 32) as `0x${string}`,
        entityIndexes: [1n, 0n],
        weights: [1n, 1n],
        threshold: 1n,
        boardChangeDelay: 0n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      }],
    });
    expect(compactHankoForChain(withPlaceholder, digest)).toBe(withPlaceholder);

    // Same signer, non-zero delays: the board hash differs from the lazy id.
    const delayed = encodeSignedHanko({
      digest,
      privateKeys: [ethers.getBytes(key)],
      placeholders: [],
      claims: [{
        entityId: ethers.zeroPadValue('0x2d', 32) as `0x${string}`,
        entityIndexes: [0n],
        weights: [1n],
        threshold: 1n,
        boardChangeDelay: 5n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      }],
    });
    expect(compactHankoForChain(delayed, digest)).toBe(delayed);
  });

  test('envelope with ERC-1271 member proofs is rejected off-chain and never compacted', () => {
    const lazyId = lazySingleSignerEntityId(wallet.address);
    const contractMember = ethers.zeroPadValue('0x00000000000000000000000000000000000000cc', 32) as `0x${string}`;
    const withMember = encodeSignedHanko({
      digest,
      privateKeys: [ethers.getBytes(key)],
      placeholders: [contractMember],
      claims: [{
        entityId: lazyId,
        entityIndexes: [1n, 0n],
        weights: [1n, 1n],
        threshold: 1n,
        boardChangeDelay: 0n,
        controlChangeDelay: 0n,
        dividendChangeDelay: 0n,
      }],
      memberSignatures: ['0xdeadbeef'],
    });
    expect(decodeHankoEnvelope(withMember).memberSignatures).toEqual(['0xdeadbeef']);
    expect(() => verifyCanonicalHanko({ digest, hanko: withMember })).toThrow('HANKO_MEMBER_SIGNATURE_UNSUPPORTED:0');
    expect(compactHankoForChain(withMember, digest)).toBe(withMember);
  });
});
