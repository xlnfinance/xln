/**
 * Direct ABI codec for the Hanko envelope tuple
 * `tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[])`.
 *
 * Byte-identical to `AbiCoder.encode/decode` of that type (differential test in
 * `__tests__/security/hanko/hanko-abi.test.ts`). The generic coder parses
 * fragments, wraps every value in Typed/Result objects and copies bytes per
 * word; a busy hub encodes one envelope per certified output, which made the
 * generic path ~5% of hub CPU. Values are already validated by the caller;
 * this module only lays out words. Decoding is bounds-checked and the caller
 * still enforces canonical form by re-encoding.
 */

const WORD = 64; // hex chars per 32-byte word
const HEX_WORD_RE = /^[0-9a-f]{64}$/;

export type HankoAbiClaim = readonly [
  entityId: string,
  entityIndexes: readonly bigint[],
  weights: readonly bigint[],
  threshold: bigint,
  boardChangeDelay: bigint,
  controlChangeDelay: bigint,
  dividendChangeDelay: bigint,
];

export type HankoAbiEnvelope = readonly [
  placeholders: readonly string[],
  packedSignatures: string,
  claims: readonly HankoAbiClaim[],
];

const uintWord = (value: bigint): string => value.toString(16).padStart(WORD, '0');
const bytes32Word = (value: string): string => value.slice(2).toLowerCase();

const uintArray = (values: readonly bigint[]): string => {
  let out = uintWord(BigInt(values.length));
  for (let index = 0; index < values.length; index += 1) out += uintWord(values[index]!);
  return out;
};

const encodeClaim = (claim: HankoAbiClaim): string => {
  const [entityId, indexes, weights, threshold, board, control, dividend] = claim;
  const indexesOffset = 7 * 32;
  const weightsOffset = indexesOffset + 32 * (1 + indexes.length);
  return bytes32Word(entityId)
    + uintWord(BigInt(indexesOffset))
    + uintWord(BigInt(weightsOffset))
    + uintWord(threshold)
    + uintWord(board)
    + uintWord(control)
    + uintWord(dividend)
    + uintArray(indexes)
    + uintArray(weights);
};

/** `0x`-prefixed lowercase hex, identical to `AbiCoder.encode([HANKO_TYPE], [envelope])`. */
export const encodeHankoAbi = (envelope: HankoAbiEnvelope): string => {
  const [placeholders, packed, claims] = envelope;
  const packedHex = packed.slice(2).toLowerCase();
  const packedBytes = packedHex.length / 2;
  const packedPadded = packedHex + '0'.repeat((WORD - (packedHex.length % WORD)) % WORD);

  let placeholdersEnc = uintWord(BigInt(placeholders.length));
  for (let index = 0; index < placeholders.length; index += 1) {
    placeholdersEnc += bytes32Word(placeholders[index]!);
  }
  const packedEnc = uintWord(BigInt(packedBytes)) + packedPadded;

  const claimEncodings = claims.map(encodeClaim);
  let claimsHeads = '';
  let claimsTails = '';
  let claimOffset = 32 * claims.length;
  for (let index = 0; index < claimEncodings.length; index += 1) {
    const encoded = claimEncodings[index]!;
    claimsHeads += uintWord(BigInt(claimOffset));
    claimsTails += encoded;
    claimOffset += encoded.length / 2;
  }
  const claimsEnc = uintWord(BigInt(claims.length)) + claimsHeads + claimsTails;

  const placeholdersOffset = 3 * 32;
  const packedOffset = placeholdersOffset + placeholdersEnc.length / 2;
  const claimsOffset = packedOffset + packedEnc.length / 2;
  return '0x'
    + uintWord(32n)
    + uintWord(BigInt(placeholdersOffset))
    + uintWord(BigInt(packedOffset))
    + uintWord(BigInt(claimsOffset))
    + placeholdersEnc
    + packedEnc
    + claimsEnc;
};

class HankoAbiReader {
  constructor(private readonly hex: string) {}

  /** Read the 32-byte word at byte offset `offset`; throws when out of range. */
  word(offset: number): string {
    const start = offset * 2;
    if (!Number.isSafeInteger(offset) || offset < 0 || start + WORD > this.hex.length) {
      throw new Error(`HANKO_ABI_OUT_OF_BOUNDS:${offset}`);
    }
    return this.hex.slice(start, start + WORD);
  }

  uint(offset: number): bigint {
    return BigInt(`0x${this.word(offset)}`);
  }

  /** Small non-negative integer (lengths / offsets) — anything past the buffer is invalid. */
  size(offset: number): number {
    const value = this.uint(offset);
    if (value > BigInt(this.hex.length / 2)) throw new Error(`HANKO_ABI_SIZE_INVALID:${offset}`);
    return Number(value);
  }

  bytes32(offset: number): string {
    const word = this.word(offset);
    if (!HEX_WORD_RE.test(word)) throw new Error(`HANKO_ABI_WORD_INVALID:${offset}`);
    return `0x${word}`;
  }

  uintArray(offset: number): bigint[] {
    const length = this.size(offset);
    const values: bigint[] = new Array(length);
    for (let index = 0; index < length; index += 1) values[index] = this.uint(offset + 32 * (1 + index));
    return values;
  }

  /** AbiCoder masks fixed-width integers to their size; the canonical re-encode rejects the excess. */
  uint32(offset: number): bigint {
    return this.uint(offset) & 0xffff_ffffn;
  }

  bytes(offset: number): string {
    const length = this.size(offset);
    const start = (offset + 32) * 2;
    const end = start + length * 2;
    if (end > this.hex.length) throw new Error(`HANKO_ABI_OUT_OF_BOUNDS:${offset}`);
    return `0x${this.hex.slice(start, end)}`;
  }
}

/**
 * Decode `AbiCoder.encode([HANKO_TYPE], [envelope])`. Input must be `0x` +
 * even-length lowercase hex (the caller normalises). Structural violations
 * throw `HANKO_ABI_*`; like AbiCoder, trailing bytes and oversized fixed-width
 * integers decode leniently — the caller re-encodes to reject every
 * non-canonical layout.
 */
export const decodeHankoAbi = (encoded: string): HankoAbiEnvelope => {
  const hex = encoded.slice(2);
  const reader = new HankoAbiReader(hex);
  const tuple = reader.size(0);
  const placeholdersAt = tuple + reader.size(tuple);
  const packedAt = tuple + reader.size(tuple + 32);
  const claimsAt = tuple + reader.size(tuple + 64);

  const placeholderCount = reader.size(placeholdersAt);
  const placeholders: string[] = new Array(placeholderCount);
  for (let index = 0; index < placeholderCount; index += 1) {
    placeholders[index] = reader.bytes32(placeholdersAt + 32 * (1 + index));
  }
  const packed = reader.bytes(packedAt);

  const claimCount = reader.size(claimsAt);
  const claimsBase = claimsAt + 32;
  const claims: HankoAbiClaim[] = new Array(claimCount);
  for (let index = 0; index < claimCount; index += 1) {
    const claimAt = claimsBase + reader.size(claimsBase + 32 * index);
    claims[index] = [
      reader.bytes32(claimAt),
      reader.uintArray(claimAt + reader.size(claimAt + 32)),
      reader.uintArray(claimAt + reader.size(claimAt + 64)),
      reader.uint(claimAt + 96),
      reader.uint32(claimAt + 128),
      reader.uint32(claimAt + 160),
      reader.uint32(claimAt + 192),
    ];
  }
  return [placeholders, packed, claims];
};
