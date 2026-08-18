import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { abiSchemaFromFragment, abiSchemaFromType, encodeAbi, encodeAbiParams } from '../../protocol/crypto/abi-encode';
import { BATCH_ABI, PROOF_BODY_ABI } from '../../protocol/dispute/proof-body';

const CODER = ethers.AbiCoder.defaultAbiCoder();
const PROOF_BODY_PARAM = ethers.ParamType.from(PROOF_BODY_ABI);
const BATCH_PARAM = ethers.ParamType.from(BATCH_ABI);
const proofBodySchema = abiSchemaFromFragment(PROOF_BODY_ABI);
const batchSchema = abiSchemaFromFragment(BATCH_ABI);

let seed = 0x2545f491;
const rand = (): number => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
};
const randInt = (max: number): number => Math.floor(rand() * (max + 1));
const randHex = (bytes: number): string => {
  let out = '0x';
  for (let index = 0; index < bytes; index += 1) out += randInt(255).toString(16).padStart(2, '0');
  return out;
};
const randUint = (bits: number): bigint => {
  const value = BigInt(randHex(Math.ceil(bits / 8))) & ((1n << BigInt(bits)) - 1n);
  return rand() < 0.2 ? 0n : value;
};
const randInt256 = (): bigint => {
  const magnitude = randUint(rand() < 0.5 ? 64 : 255);
  return rand() < 0.5 ? -magnitude : magnitude;
};
const randAddress = (): string => {
  const raw = randHex(20);
  const roll = rand();
  if (roll < 0.4) return raw;
  if (roll < 0.7) return ethers.getAddress(raw);
  return raw.toUpperCase().replace('0X', '0x');
};

const randBatch = () => ({
  payment: Array.from({ length: randInt(3) }, () => ({
    deltaIndex: BigInt(randInt(10)),
    amount: randInt256(),
    revealedUntilTimestamp: randUint(64),
    hash: randHex(32),
  })),
  swap: Array.from({ length: randInt(3) }, () => ({
    ownerIsLeft: rand() < 0.5,
    addDeltaIndex: BigInt(randInt(10)),
    addAmount: randUint(128),
    subDeltaIndex: BigInt(randInt(10)),
    subAmount: randUint(128),
  })),
  pull: Array.from({ length: randInt(2) }, () => ({
    deltaIndex: BigInt(randInt(10)),
    amount: randInt256(),
    claimedRatio: randUint(16),
    fullHash: randHex(32),
    partialRoot: randHex(32),
    targetRole: rand() < 0.5,
  })),
});

const randProofBody = () => {
  const tokens = randInt(4);
  return {
    watchSeed: randHex(32),
    leftResponseSeconds: randUint(32),
    rightResponseSeconds: randUint(32),
    offdeltas: Array.from({ length: tokens }, randInt256),
    tokenIds: Array.from({ length: tokens }, () => randUint(32)),
    transformers: Array.from({ length: randInt(3) }, () => ({
      transformerAddress: randAddress(),
      encodedBatch: rand() < 0.3 ? randHex(randInt(70)) : CODER.encode([BATCH_PARAM], [randBatch()]),
      allowances: Array.from({ length: randInt(3) }, () => ({
        deltaIndex: BigInt(randInt(10)),
        rightAllowance: randUint(128),
        leftAllowance: randUint(128),
      })),
    })),
  };
};

describe('direct ABI encoder', () => {
  test('encodes DeltaTransformer.Batch byte-identically to AbiCoder', () => {
    for (let round = 0; round < 1500; round += 1) {
      const batch = randBatch();
      expect(encodeAbi(batchSchema, batch)).toBe(CODER.encode([BATCH_PARAM], [batch]));
    }
  });

  test('encodes ProofBody byte-identically to AbiCoder', () => {
    for (let round = 0; round < 1500; round += 1) {
      const body = randProofBody();
      expect(encodeAbi(proofBodySchema, body)).toBe(CODER.encode([PROOF_BODY_PARAM], [body]));
    }
  });

  test('encodes parameter lists (strings, arrays, ints, bools) byte-identically to AbiCoder', () => {
    const alphabet = ['', 'a', 'xln:route', 'ünïcödé', '🙂🙂', 'x'.repeat(31), 'y'.repeat(32), 'z'.repeat(70)];
    const types = ['string', 'uint256', 'bool', 'int256', 'uint32', 'bytes32', 'uint64[]', 'bytes32[]', 'string', 'address', 'bytes'];
    const schemas = types.map(abiSchemaFromType);
    for (let round = 0; round < 1500; round += 1) {
      const values: unknown[] = [
        alphabet[randInt(alphabet.length - 1)],
        rand() < 0.5 ? randUint(256) : randInt(1000),
        rand() < 0.5,
        randInt256(),
        randUint(32),
        randHex(32),
        Array.from({ length: randInt(4) }, () => randUint(64)),
        Array.from({ length: randInt(3) }, () => randHex(32)),
        alphabet[randInt(alphabet.length - 1)],
        randAddress(),
        randHex(randInt(80)),
      ];
      expect(encodeAbiParams(schemas, values)).toBe(CODER.encode(types, values));
    }
    expect(() => encodeAbiParams(schemas.slice(0, 1), ['\ud800'])).toThrow('ABI_ENCODE_INVALID_VALUE');
    expect(() => CODER.encode(['string'], ['\ud800'])).toThrow();
  });

  test('rejects what AbiCoder rejects', () => {
    const body = randProofBody();
    const cases: Array<Record<string, unknown>> = [
      { ...body, watchSeed: randHex(31) },
      { ...body, leftResponseSeconds: 1n << 32n },
      { ...body, offdeltas: [1n << 255n] },
      { ...body, tokenIds: [-1n] },
      { ...body, transformers: [{ transformerAddress: '0xAbcdEF0000000000000000000000000000000001', encodedBatch: '0x', allowances: [] }] },
      { ...body, transformers: [{ transformerAddress: randHex(19), encodedBatch: '0x', allowances: [] }] },
      { ...body, transformers: [{ transformerAddress: randHex(20), encodedBatch: '0x1', allowances: [] }] },
    ];
    for (const invalid of cases) {
      expect(() => CODER.encode([PROOF_BODY_PARAM], [invalid])).toThrow();
      expect(() => encodeAbi(proofBodySchema, invalid)).toThrow('ABI_ENCODE_INVALID_VALUE');
    }
  });
});
