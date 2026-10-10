import {
  requireBigInt,
  requireBoolean,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../boundary/boundary-primitives';
import {
  UINT256_MAX,
  INT256_MIN,
  INT256_MAX,
  INT512_MIN,
  INT512_MAX,
  INT768_MIN,
  INT768_MAX,
} from '../boundary/integer-ranges';

export type SignedAmount = Readonly<{ negative: boolean; magnitude: bigint }>;
export type Int512 = Readonly<{ high: bigint; low: bigint }>;
export type Int768 = Readonly<{ high: bigint; middle: bigint; low: bigint }>;

export const SIGNED_AMOUNT_ABI_COMPONENTS = [
  { name: 'negative', type: 'bool' },
  { name: 'magnitude', type: 'uint256' },
] as const;
export const INT512_ABI_COMPONENTS = [
  { name: 'high', type: 'int256' },
  { name: 'low', type: 'uint256' },
] as const;

const WORD_BITS = 256n;

const requireRange = (value: unknown, minimum: bigint, maximum: bigint, label: string): bigint => {
  const integer = requireBigInt(value, `ABI_MONEY_INTEGER:${label}`);
  if (integer < minimum || integer > maximum) {
    throw new Error(`ABI_MONEY_WIDTH:${label}`);
  }
  return integer;
};

export const assertUint256 = (value: bigint, label: string): bigint => requireRange(value, 0n, UINT256_MAX, label);
export const assertSignedAmount = (value: bigint, label: string): bigint =>
  requireRange(value, -UINT256_MAX, UINT256_MAX, label);
export const assertInt512 = (value: bigint, label: string): bigint =>
  requireRange(value, INT512_MIN, INT512_MAX, label);

// ethers Results are positional arrays; direct ABI callers use named tuples.
// Both must contain exactly these limbs. A scalar from the retired ABI is not
// a money tuple, and extra keys cannot silently change the signed meaning.
const tupleValues = (value: unknown, names: readonly string[], label: string): unknown[] => {
  if (Array.isArray(value)) {
    if (value.length !== names.length) throw new Error(`ABI_MONEY_TUPLE_LENGTH:${label}`);
    if (Object.keys(value).some((key, index) => key !== String(index))) {
      throw new Error(`ABI_MONEY_TUPLE_FIELDS:${label}`);
    }
    return value;
  }
  const tuple = requireBoundaryRecord(value, `ABI_MONEY_TUPLE:${label}`);
  requireExactBoundaryKeys(tuple, names, [], `ABI_MONEY_TUPLE_FIELDS:${label}`);
  return names.map(name => tuple[name]);
};

export const encodeSignedAmount = (value: bigint): SignedAmount => {
  const integer = assertSignedAmount(value, 'SignedAmount');
  const magnitude = integer < 0n ? -integer : integer;
  return { negative: integer < 0n, magnitude };
};

export const decodeSignedAmount = (value: unknown): bigint => {
  const [sign, word] = tupleValues(value, ['negative', 'magnitude'], 'SignedAmount');
  const negative = requireBoolean(sign, 'ABI_MONEY_SIGN:SignedAmount');
  const magnitude = requireRange(word, 0n, UINT256_MAX, 'SignedAmount.magnitude');
  if (negative && magnitude === 0n) throw new Error('ABI_MONEY_NEGATIVE_ZERO');
  return negative ? -magnitude : magnitude;
};

export const encodeInt512 = (value: bigint): Int512 => {
  const integer = assertInt512(value, 'Int512');
  return { high: integer >> WORD_BITS, low: integer & UINT256_MAX };
};

export const decodeInt512 = (value: unknown): bigint => {
  const [high, low] = tupleValues(value, ['high', 'low'], 'Int512');
  return (
    (requireRange(high, INT256_MIN, INT256_MAX, 'Int512.high') << WORD_BITS) +
    requireRange(low, 0n, UINT256_MAX, 'Int512.low')
  );
};

export const encodeInt768 = (value: bigint): Int768 => {
  const integer = requireRange(value, INT768_MIN, INT768_MAX, 'Int768');
  return { high: integer >> 512n, middle: (integer >> WORD_BITS) & UINT256_MAX, low: integer & UINT256_MAX };
};

export const decodeInt768 = (value: unknown): bigint => {
  const [high, middle, low] = tupleValues(value, ['high', 'middle', 'low'], 'Int768');
  return (
    (requireRange(high, INT256_MIN, INT256_MAX, 'Int768.high') << 512n) +
    (requireRange(middle, 0n, UINT256_MAX, 'Int768.middle') << WORD_BITS) +
    requireRange(low, 0n, UINT256_MAX, 'Int768.low')
  );
};

export const decodeUint512 = (value: unknown): bigint => {
  const [high, low] = tupleValues(value, ['high', 'low'], 'Uint512');
  return (
    (requireRange(high, 0n, UINT256_MAX, 'Uint512.high') << WORD_BITS) +
    requireRange(low, 0n, UINT256_MAX, 'Uint512.low')
  );
};

export const decodeUint768 = (value: unknown): bigint => {
  const [high, middle, low] = tupleValues(value, ['high', 'middle', 'low'], 'Uint768');
  return (
    (requireRange(high, 0n, UINT256_MAX, 'Uint768.high') << 512n) +
    (requireRange(middle, 0n, UINT256_MAX, 'Uint768.middle') << WORD_BITS) +
    requireRange(low, 0n, UINT256_MAX, 'Uint768.low')
  );
};
