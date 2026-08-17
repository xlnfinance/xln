/**
 * Canonical keccak256 over UTF-8 text.
 *
 * Consensus identities hash canonical text on the hot path. Routing that
 * through ethers costs two extra conversions per call (BytesLike normalization
 * in, hex formatting out) for a digest that is byte-identical to hashing the
 * UTF-8 bytes directly. Keep one implementation so the digest cannot drift
 * between call sites.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';

const textEncoder = new TextEncoder();
const HEX_BYTE = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

const toHexDigest = (digest: Uint8Array): string => {
  let hex = '0x';
  for (let index = 0; index < digest.length; index += 1) hex += HEX_BYTE[digest[index]!];
  return hex;
};

/** Lowercase `0x`-prefixed keccak256 of the UTF-8 encoding of `text`. */
export const keccakTextHash = (text: string): string =>
  toHexDigest(keccak_256(textEncoder.encode(text)));

/** Lowercase `0x`-prefixed keccak256 of raw bytes. */
export const keccakBytesHash = (bytes: Uint8Array): string => toHexDigest(keccak_256(bytes));
