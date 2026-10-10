import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { Depository__factory } from '../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { makeAccount, putTestAccountDelta } from '../helpers/cross-j';
import { buildAccountProofBody } from '../../protocol/dispute/proof-builder';
import {
  encodeSignedAmount,
  decodeSignedAmount,
  encodeInt512,
  decodeInt512,
  encodeInt768,
  decodeInt768,
  decodeUint512,
  decodeUint768,
  SIGNED_AMOUNT_ABI_COMPONENTS,
  INT512_ABI_COMPONENTS,
} from '../../protocol/crypto/abi-money';

const coder = ethers.AbiCoder.defaultAbiCoder();
const wordMax = (1n << 256n) - 1n;
const limb = (name: string, type: string) => ({ name, type });
const uint512Limbs = (value: bigint) => ({ high: value >> 256n, low: value & wordMax });
const uint768Limbs = (value: bigint) => ({
  high: value >> 512n,
  middle: (value >> 256n) & wordMax,
  low: value & wordMax,
});

describe('canonical wide money ABI', () => {
  test('production Account proof before Hanko matches the contract Int512 ABI for negative offdelta', () => {
    const proofParam = Depository__factory.createInterface()
      .getFunction('watchtowerCounterDispute')
      ?.inputs[1]?.components?.find(field => field.name === 'finalProofbody');
    if (!proofParam) throw new Error('CONTRACT_PROOF_BODY_ABI_MISSING');
    const account = makeAccount(`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`);
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('CANONICAL_TEST_DELTA_MISSING');
    putTestAccountDelta(account, { ...delta, offdelta: -1n });
    const actual = buildAccountProofBody(account, `0x${'03'.repeat(20)}`);
    const contractBody = { ...actual.proofBodyStruct, offdeltas: [{ high: -1n, low: wordMax }] };
    const encoded = coder.encode([proofParam], [contractBody]);
    expect(actual.encodedProofBody).toBe(encoded);
    expect(actual.proofBodyHash).toBe(ethers.keccak256(encoded));
  });

  test('signed movement admits uint256 magnitude, rejects negative zero and retired scalar ABI', () => {
    expect(encodeSignedAmount(-wordMax)).toEqual({ negative: true, magnitude: wordMax });
    expect(encodeSignedAmount(0n)).toEqual({ negative: false, magnitude: 0n });
    const param = ethers.ParamType.from({ type: 'tuple', components: SIGNED_AMOUNT_ABI_COMPONENTS });
    for (const value of [-wordMax, -(1n << 255n), -1n, 0n, 1n, 1n << 255n, wordMax]) {
      const expected = coder.encode(['bool', 'uint256'], [value < 0n, value < 0n ? -value : value]);
      expect(coder.encode([param], [encodeSignedAmount(value)])).toBe(expected);
      expect(decodeSignedAmount(coder.decode([param], expected)[0])).toBe(value);
    }
    expect(() => decodeSignedAmount({ negative: true, magnitude: 0n })).toThrow('ABI_MONEY_NEGATIVE_ZERO');
    expect(() => decodeSignedAmount(1n)).toThrow('ABI_MONEY_TUPLE');
    expect(() => encodeSignedAmount(wordMax + 1n)).toThrow('ABI_MONEY_WIDTH');
    expect(() => encodeSignedAmount(-wordMax - 1n)).toThrow('ABI_MONEY_WIDTH');
  });

  test('Int512 independent fixed limbs include borrow, signed endpoints and full negative uint256', () => {
    const vectors = [
      [-(1n << 511n), -(1n << 255n), 0n],
      [-wordMax, -1n, 1n],
      [-1n, -1n, wordMax],
      [0n, 0n, 0n],
      [1n << 256n, 1n, 0n],
      [(1n << 511n) - 1n, (1n << 255n) - 1n, wordMax],
    ] as const;
    const param = ethers.ParamType.from({ type: 'tuple', components: INT512_ABI_COMPONENTS });
    for (const [value, high, low] of vectors) {
      expect(encodeInt512(value)).toEqual({ high, low });
      const bytes = coder.encode(['int256', 'uint256'], [high, low]);
      expect(coder.encode([param], [encodeInt512(value)])).toBe(bytes);
      expect(decodeInt512(coder.decode([param], bytes)[0])).toBe(value);
    }
    expect(() => encodeInt512(1n << 511n)).toThrow('ABI_MONEY_WIDTH');
    expect(() => encodeInt512(-(1n << 511n) - 1n)).toThrow('ABI_MONEY_WIDTH');
  });

  test('Int768 transformer and unsigned debt/aggregate decode exact Solidity limbs', () => {
    expect(encodeInt768(-1n)).toEqual({ high: -1n, middle: wordMax, low: wordMax });
    expect(decodeInt768({ high: -1n, middle: 0n, low: 0n })).toBe(-(1n << 512n));
    const vectors = [
      {
        encode: encodeInt768,
        decode: decodeInt768,
        components: [limb('high', 'int256'), limb('middle', 'uint256'), limb('low', 'uint256')],
        values: [-(1n << 767n), -1n, 0n, 1n << 512n, (1n << 767n) - 1n],
      },
      {
        encode: uint512Limbs,
        decode: decodeUint512,
        components: [limb('high', 'uint256'), limb('low', 'uint256')],
        values: [0n, wordMax, 1n << 256n, (1n << 512n) - 1n],
      },
      {
        encode: uint768Limbs,
        decode: decodeUint768,
        components: [limb('high', 'uint256'), limb('middle', 'uint256'), limb('low', 'uint256')],
        values: [0n, wordMax, 1n << 512n, (1n << 768n) - 1n],
      },
    ];
    for (const { encode, decode, components, values } of vectors) {
      const param = ethers.ParamType.from({ type: 'tuple', components });
      for (const value of values) {
        const bytes = coder.encode([param], [encode(value)]);
        expect(decode(coder.decode([param], bytes)[0])).toBe(value);
        expect(decode(encode(value))).toBe(value);
      }
    }
    expect(() => encodeInt768(1n << 767n)).toThrow('ABI_MONEY_WIDTH');
  });

  test('untrusted tuples reject missing, extra, wrong-width and non-integer limbs', () => {
    expect(() => decodeInt512({ high: 0n, low: 1n, extra: 0n })).toThrow('ABI_MONEY_TUPLE_FIELDS');
    expect(() => decodeInt512({ high: 0n })).toThrow('ABI_MONEY_TUPLE_FIELDS');
    expect(() => decodeInt512([0n])).toThrow('ABI_MONEY_TUPLE_LENGTH');
    expect(() => decodeInt512([0n, 1n, 2n])).toThrow('ABI_MONEY_TUPLE_LENGTH');
    expect(() => decodeInt512({ high: 1n << 255n, low: 0n })).toThrow('ABI_MONEY_WIDTH');
    expect(() => decodeInt512({ high: 0n, low: -1n })).toThrow('ABI_MONEY_WIDTH');
    expect(() => decodeInt512({ high: 0n, low: '1' })).toThrow('ABI_MONEY_INTEGER');
    expect(() => decodeSignedAmount({ negative: 1, magnitude: 1n })).toThrow('ABI_MONEY_SIGN');
    expect(() => decodeUint768({ high: -1n, middle: 0n, low: 0n })).toThrow('ABI_MONEY_WIDTH');
  });
});
