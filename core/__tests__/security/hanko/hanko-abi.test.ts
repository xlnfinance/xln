import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { decodeHankoAbi, encodeHankoAbi, type HankoAbiEnvelope } from '../../../hanko/abi';

const HANKO_TYPE = ethers.ParamType.from(
  'tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[])',
);
const CODER = ethers.AbiCoder.defaultAbiCoder();

// Deterministic PRNG so failures reproduce.
let seed = 0x9e3779b9;
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
  const bytes = Math.ceil(bits / 8);
  const value = BigInt(randHex(bytes)) & ((1n << BigInt(bits)) - 1n);
  return rand() < 0.2 ? 0n : value;
};
const randEnvelope = (): HankoAbiEnvelope => {
  const placeholders = Array.from({ length: randInt(4) }, () => randHex(32));
  const packed = randHex(rand() < 0.2 ? 0 : randInt(3) * 64 + randInt(1) + (rand() < 0.5 ? 1 : 0));
  const claims = Array.from({ length: randInt(4) }, () => {
    const members = randInt(5);
    return [
      randHex(32),
      Array.from({ length: members }, () => randUint(256)),
      Array.from({ length: rand() < 0.8 ? members : randInt(5) }, () => randUint(256)),
      randUint(256),
      randUint(32),
      randUint(32),
      randUint(32),
    ] as const;
  });
  return [placeholders, packed, claims];
};

const toAbiValue = (envelope: HankoAbiEnvelope): unknown[] => [[
  envelope[0], envelope[1], envelope[2].map(claim => [...claim]),
]];

const normalize = (decoded: ethers.Result): HankoAbiEnvelope => {
  const tuple = decoded[0] as ethers.Result;
  return [
    Array.from(tuple[0] as ethers.Result) as string[],
    tuple[1] as string,
    Array.from(tuple[2] as ethers.Result).map((claim) => {
      const values = Array.from(claim as ethers.Result);
      return [
        values[0] as string,
        Array.from(values[1] as ethers.Result) as bigint[],
        Array.from(values[2] as ethers.Result) as bigint[],
        values[3] as bigint,
        values[4] as bigint,
        values[5] as bigint,
        values[6] as bigint,
      ] as const;
    }),
  ];
};

describe('direct Hanko ABI codec', () => {
  test('encodes byte-identically to AbiCoder and decodes what AbiCoder decodes', () => {
    for (let round = 0; round < 3000; round += 1) {
      const envelope = randEnvelope();
      const reference = CODER.encode([HANKO_TYPE], toAbiValue(envelope));
      expect(encodeHankoAbi(envelope)).toBe(reference);
      expect(decodeHankoAbi(reference)).toEqual(normalize(CODER.decode([HANKO_TYPE], reference)));
      expect(encodeHankoAbi(decodeHankoAbi(reference))).toBe(reference);
    }
  });

  test('empty envelope matches AbiCoder', () => {
    const empty: HankoAbiEnvelope = [[], '0x', []];
    const reference = CODER.encode([HANKO_TYPE], toAbiValue(empty));
    expect(encodeHankoAbi(empty)).toBe(reference);
    expect(decodeHankoAbi(reference)).toEqual(empty);
  });

  test('rejects truncated input and mirrors AbiCoder leniency elsewhere', () => {
    const encoded = encodeHankoAbi([[randHex(32)], randHex(65), [[randHex(32), [0n], [1n], 1n, 0n, 0n, 0n]]]);
    expect(() => decodeHankoAbi(encoded.slice(0, encoded.length - 64))).toThrow('HANKO_ABI_OUT_OF_BOUNDS');
    expect(() => decodeHankoAbi('0x')).toThrow('HANKO_ABI_OUT_OF_BOUNDS');
    // Trailing bytes and oversized uint32 words decode like AbiCoder (the
    // canonical re-encode in hanko/codec is what rejects them).
    expect(decodeHankoAbi(`${encoded}00`)).toEqual(normalize(CODER.decode([HANKO_TYPE], `${encoded}00`)));
    const wide = encodeHankoAbi([[], '0x', [[randHex(32), [0n], [1n], 1n, (1n << 32n) | 7n, 0n, 0n]]]);
    expect(decodeHankoAbi(wide)).toEqual(normalize(CODER.decode([HANKO_TYPE], wide)));
    expect(encodeHankoAbi(decodeHankoAbi(wide))).not.toBe(wide);
  });
});
