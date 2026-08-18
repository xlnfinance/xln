/**
 * Canonical keccak256 over UTF-8 text.
 *
 * Consensus identities hash canonical text on the hot path. Routing that
 * through ethers costs two extra conversions per call (BytesLike normalization
 * in, hex formatting out) for a digest that is byte-identical to hashing the
 * UTF-8 bytes directly. Keep one implementation so the digest cannot drift
 * between call sites.
 */
import { countOp, countOpWithSite } from '../../support/performance/op-counters';
import { keccak256Bytes } from './fast-keccak';

const textEncoder = new TextEncoder();
const HEX_BYTE = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

const toHexDigest = (digest: Uint8Array): string => {
  let hex = '0x';
  for (let index = 0; index < digest.length; index += 1) hex += HEX_BYTE[digest[index]!];
  return hex;
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isWellFormed = (text: string): boolean =>
  typeof (text as { isWellFormed?: () => boolean }).isWellFormed === 'function'
    ? (text as unknown as { isWellFormed: () => boolean }).isWellFormed()
    : !LONE_SURROGATE.test(text);

/**
 * UTF-8 bytes of `text`, byte-identical to `ethers.toUtf8Bytes` (which walks
 * the string in JS): rejects lone surrogates instead of substituting U+FFFD,
 * otherwise the native encoder.
 */
export const utf8Bytes = (text: string): Uint8Array => {
  if (!isWellFormed(text)) throw new Error('UTF8_LONE_SURROGATE');
  return textEncoder.encode(text);
};

/** UTF-8 byte length of `text` without materialising the bytes where the host allows. */
export const utf8ByteLength = (text: string): number =>
  typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : textEncoder.encode(text).byteLength;

/** Lowercase `0x`-prefixed keccak256 of the UTF-8 encoding of `text`. */
export const keccakTextHash = (text: string): string => {
  const bytes = utf8Bytes(text);
  countOpWithSite('keccak.text', bytes.length, 1);
  return toHexDigest(keccak256Bytes(bytes));
};

/** Lowercase `0x`-prefixed keccak256 of raw bytes. */
export const keccakBytesHash = (bytes: Uint8Array): string => {
  countOp('keccak.bytes', bytes.length);
  return toHexDigest(keccak256Bytes(bytes));
};

const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let value = 0; value < 16; value += 1) {
  HEX_NIBBLE['0123456789abcdef'.charCodeAt(value)] = value;
  HEX_NIBBLE['0123456789ABCDEF'.charCodeAt(value)] = value;
}

/** Bytes of a `0x`-prefixed even-length hex string; throws like ethers.getBytes on malformed input. */
export const hexToBytes = (hex: string): Uint8Array => {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || hex.charCodeAt(0) !== 0x30 || (hex.charCodeAt(1) | 0x20) !== 0x78) {
    throw new Error('HEX_BYTES_INVALID');
  }
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const high = HEX_NIBBLE[hex.charCodeAt(index * 2 + 2)] ?? -1;
    const low = HEX_NIBBLE[hex.charCodeAt(index * 2 + 3)] ?? -1;
    if (high < 0 || low < 0) throw new Error('HEX_BYTES_INVALID');
    bytes[index] = (high << 4) | low;
  }
  return bytes;
};

/** Lowercase keccak256 of hex-encoded bytes; identical to `ethers.keccak256(hex)` without its BytesLike walk. */
export const keccakHexHash = (hex: string): string => {
  const bytes = hexToBytes(hex);
  countOp('keccak.hex', bytes.length);
  return toHexDigest(keccak256Bytes(bytes));
};
