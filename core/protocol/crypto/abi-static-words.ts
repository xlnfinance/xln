/**
 * ABI encoding of an all-static parameter list (bytes32 / uintN / bool).
 *
 * The ABI encoding of static-only parameters is the plain concatenation of
 * their 32-byte words, so this is byte-identical to
 * `AbiCoder.encode(['bytes32','uint8',...], values)` while skipping the
 * generic coder (type parsing, Typed wrapping, per-value BytesLike
 * normalisation) that dominates hot consensus hashing.
 */

const WORD_HEX = 64;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const uintWord = (value: bigint | number, index: number): string => {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`ABI_STATIC_WORD_INVALID:${index}`);
  if (big < 0n || big >= (1n << 256n)) throw new Error(`ABI_STATIC_WORD_RANGE:${index}`);
  return big.toString(16).padStart(WORD_HEX, '0');
};

/**
 * `0x`-prefixed hex of the concatenated words. Strings must be canonical
 * bytes32 hex; numbers/bigints are unsigned integers; booleans encode 0/1.
 */
export const encodeAbiStaticWords = (
  values: ReadonlyArray<string | bigint | number | boolean>,
): string => {
  let hex = '0x';
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (typeof value === 'string') {
      if (!BYTES32_RE.test(value)) throw new Error(`ABI_STATIC_WORD_BYTES32_INVALID:${index}`);
      hex += value.slice(2).toLowerCase();
    } else if (typeof value === 'boolean') {
      hex += value ? '1'.padStart(WORD_HEX, '0') : '0'.padStart(WORD_HEX, '0');
    } else {
      hex += uintWord(value, index);
    }
  }
  return hex;
};
