/**
 * Fixed-radix Merkle node hashing for the persistent consensus/storage maps.
 * Key functions: domain-separated leaf, branch and extension hashes plus path packing.
 * Human-audit importance: 99/100 — roots bind large state without iteration ambiguity.
 */
import { ethers } from 'ethers';
import { hexToBytes } from '../../support/bytes/hex-bytes';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';

export const RADIX_MERKLE_RADICES = [2, 4, 16, 256] as const;
export type RadixMerkleRadix = (typeof RADIX_MERKLE_RADICES)[number];
export type RadixMerkleHashAlgorithm = 'integrity' | 'keccak256';

export const EMPTY_RADIX_MERKLE_ROOT = `0x${'00'.repeat(32)}`;

const UTF8_ENCODER = new TextEncoder();
const hashHexToBytes = (hex: string): Uint8Array => {
  try {
    const bytes = hexToBytes(hex);
    if (bytes.length === 0) throw new Error('empty');
    return bytes;
  } catch {
    throw new Error(`RADIX_MERKLE_HASH_HEX_INVALID:${hex}`);
  }
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const uint16Bytes = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`RADIX_MERKLE_UINT16_OUT_OF_RANGE: ${value}`);
  }
  return Uint8Array.of(value >>> 8, value & 0xff);
};

const domainBytes = (tag: string): Uint8Array => {
  const raw = UTF8_ENCODER.encode(tag);
  return concatBytes(uint16Bytes(raw.length), raw);
};

const LEAF_DOMAIN = domainBytes('xln.storage.merkle.leaf.v1');
const BRANCH_DOMAIN = domainBytes('xln.storage.merkle.branch.v1');
const EXTENSION_DOMAIN = domainBytes('xln.storage.merkle.extension.v1');

const hashParts = (
  domain: Uint8Array,
  parts: Uint8Array[],
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => {
  const payload = concatBytes(domain, ...parts);
  return hashAlgorithm === 'keccak256' ? ethers.keccak256(payload) : computeIntegrityDigest(payload);
};

/** Raw UTF-8 key with an explicit byte length; prefix-free and never hashed. */
export const encodeRawRadixTextKey = (value: string): Uint8Array => {
  const raw = UTF8_ENCODER.encode(value);
  if (raw.length > 0xffff) throw new Error(`RADIX_MERKLE_TEXT_KEY_TOO_LONG:${raw.length}`);
  return concatBytes(uint16Bytes(raw.length), raw);
};


const radixMerkleBitsPerSlot = (radix: RadixMerkleRadix): number =>
  Math.log2(radix);

const radixTag = (radix: RadixMerkleRadix): number => radix === 256 ? 0xff : radix;

const pathSlots = (key: Uint8Array, radix: RadixMerkleRadix): number[] => {
  if (radix === 16) {
    // Hot radix: two nibbles per byte, preallocated.
    const slots: number[] = new Array(key.length * 2);
    for (let index = 0; index < key.length; index += 1) {
      const byte = key[index]!;
      slots[index * 2] = byte >>> 4;
      slots[index * 2 + 1] = byte & 0x0f;
    }
    return slots;
  }
  const bitsPerSlot = radixMerkleBitsPerSlot(radix);
  const mask = radix - 1;
  const slots: number[] = [];
  for (const byte of key) {
    for (let bitOffset = 0; bitOffset < 8; bitOffset += bitsPerSlot) {
      slots.push((byte >>> (8 - bitsPerSlot - bitOffset)) & mask);
    }
  }
  return slots;
};

export const radixMerklePathSlots = (key: Uint8Array, radix: RadixMerkleRadix): number[] =>
  pathSlots(key, radix);

export const computeRadixMerkleLeafHash = (
  key: Uint8Array,
  value: Uint8Array,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => hashParts(LEAF_DOMAIN, [key, value], hashAlgorithm);

/** Decode `0x` hex straight into a preimage buffer; returns the byte count. */
const writeHexInto = (target: Uint8Array, offset: number, hex: string): number => {
  const bytes = hashHexToBytes(hex);
  target.set(bytes, offset);
  return bytes.length;
};

const branchHashOrdered = (
  radix: RadixMerkleRadix,
  children: Array<[number, string]>,
): string => {
  if (children.length === 0) return EMPTY_RADIX_MERKLE_ROOT;
  // One preimage buffer per branch: a Hub seals thousands of dirty branches a
  // frame, and a part list plus concat allocated ~35 small arrays for each.
  let size = BRANCH_DOMAIN.length + 1;
  for (const [, hash] of children) size += 1 + (hash.length - 2) / 2;
  const payload = new Uint8Array(size);
  payload.set(BRANCH_DOMAIN, 0);
  let offset = BRANCH_DOMAIN.length;
  payload[offset++] = radixTag(radix);
  for (const [slot, hash] of children) {
    payload[offset++] = slot;
    offset += writeHexInto(payload, offset, hash);
  }
  if (offset !== size) throw new Error('RADIX_MERKLE_BRANCH_PREIMAGE_SIZE');
  return computeIntegrityDigest(payload);
};

/** Dense slot form used by the persistent Patricia hot path; no sort is needed. */
export const computeRadixMerkleBranchHashFromSlots = (
  radix: RadixMerkleRadix,
  children: readonly (string | undefined)[],
): string => {
  if (children.length !== radix) {
    throw new Error(`RADIX_MERKLE_BRANCH_WIDTH_INVALID:${children.length}:${radix}`);
  }
  const ordered: Array<[number, string]> = [];
  for (let slot = 0; slot < children.length; slot += 1) {
    const hash = children[slot];
    if (hash !== undefined) ordered.push([slot, hash]);
  }
  return branchHashOrdered(radix, ordered);
};

const encodePathSegment = (radix: RadixMerkleRadix, path: number[]): Uint8Array => {
  const header = uint16Bytes(path.length);
  const bitsPerSlot = radixMerkleBitsPerSlot(radix);
  const slotsPerByte = 8 / bitsPerSlot;
  const packed = new Uint8Array(Math.ceil(path.length / slotsPerByte));
  for (let index = 0; index < path.length; index += 1) {
    const slot = path[index] ?? 0;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= radix) {
      throw new Error(`RADIX_MERKLE_INVALID_SLOT:${radix}:${slot}`);
    }
    const byteIndex = Math.floor(index / slotsPerByte);
    const shift = 8 - bitsPerSlot * ((index % slotsPerByte) + 1);
    packed[byteIndex] = (packed[byteIndex] ?? 0) | (slot << shift);
  }
  return concatBytes(header, packed);
};

export const packRadixMerklePath = (radix: RadixMerkleRadix, path: number[]): Uint8Array =>
  encodePathSegment(radix, path);

/** Exact inverse used by typed LevelDB keys; non-zero padding is rejected. */
export const unpackRadixMerklePath = (
  radix: RadixMerkleRadix,
  encoded: Uint8Array,
): number[] => {
  if (encoded.byteLength < 2) throw new Error('RADIX_MERKLE_PATH_TRUNCATED');
  const length = (encoded[0]! << 8) | encoded[1]!;
  const bitsPerSlot = radixMerkleBitsPerSlot(radix);
  const slotsPerByte = 8 / bitsPerSlot;
  const byteLength = Math.ceil(length / slotsPerByte);
  if (encoded.byteLength !== byteLength + 2) throw new Error('RADIX_MERKLE_PATH_LENGTH_INVALID');
  const path: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const byte = encoded[2 + Math.floor(index / slotsPerByte)]!;
    const shift = 8 - bitsPerSlot * ((index % slotsPerByte) + 1);
    path.push((byte >>> shift) & (radix - 1));
  }
  const usedBits = length * bitsPerSlot;
  const paddingBits = byteLength * 8 - usedBits;
  if (paddingBits > 0 && (encoded.at(-1)! & ((1 << paddingBits) - 1)) !== 0) {
    throw new Error('RADIX_MERKLE_PATH_PADDING_INVALID');
  }
  return path;
};

const extensionHash = (
  radix: RadixMerkleRadix,
  path: number[],
  childHash: string,
): string =>
  hashParts(EXTENSION_DOMAIN, [
    Uint8Array.of(radixTag(radix)),
    encodePathSegment(radix, path),
    hashHexToBytes(childHash),
  ]);

export const computeRadixMerkleEdgeHash = (
  radix: RadixMerkleRadix,
  parentPath: readonly number[],
  childKind: 'branch' | 'leaf',
  childPath: readonly number[],
  childNodeHash: string,
): string => {
  if (childKind === 'leaf') return childNodeHash;
  const segment = childPath.slice(parentPath.length + 1);
  return segment.length > 0
    ? extensionHash(radix, segment, childNodeHash)
    : childNodeHash;
};
