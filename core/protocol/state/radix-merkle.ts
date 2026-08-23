/**
 * Pure fixed-radix Merkle construction and verification for consensus/storage maps.
 * Key functions: domain-separated node hashing plus canonical proof verification.
 * Human-audit importance: 99/100 — roots bind large state without iteration ambiguity.
 */
import { ethers } from 'ethers';
import { hexToBytes as decodeHexBytes } from '../../support/bytes/hex-bytes';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';

export const RADIX_MERKLE_RADICES = [2, 4, 16, 256] as const;
export type RadixMerkleRadix = (typeof RADIX_MERKLE_RADICES)[number];
export type RadixMerkleHashAlgorithm = 'integrity' | 'keccak256';
export type RadixMerkleOptions = {
  radix?: RadixMerkleRadix;
  hashAlgorithm?: RadixMerkleHashAlgorithm;
};

export type RadixMerkleLeaf = {
  key: Uint8Array;
  value: Uint8Array;
  /** Precomputed `computeRadixMerkleLeafHash(key, value)`; value bytes are then only needed by materialization. */
  hash?: string;
};

export type RadixMerkleResult = {
  radix: RadixMerkleRadix;
  depth: number;
  leafCount: number;
  branchCount: number;
  extensionCount: number;
  maxDepth: number;
  root: string;
};

type RadixMerkleRootKind = 'empty' | 'branch' | 'leaf';

type RadixMerkleMaterializedLeaf = {
  path: number[];
  key: string;
  valueHash: string;
  hash: string;
};

type RadixMerkleMaterializedBranch = {
  path: number[];
  hash: string;
  children: Array<{
    slot: number;
    kind: 'branch' | 'leaf';
    path: number[];
    hash: string;
  }>;
};

export type RadixMerkleMaterializedResult = RadixMerkleResult & {
  rootKind: RadixMerkleRootKind;
  rootPath: number[];
  branches: RadixMerkleMaterializedBranch[];
  leaves: RadixMerkleMaterializedLeaf[];
};

export const EMPTY_RADIX_MERKLE_ROOT = `0x${'00'.repeat(32)}`;

const UTF8_ENCODER = new TextEncoder();
const hexToBytes = (hex: string): Uint8Array => {
  try {
    const bytes = decodeHexBytes(hex);
    if (bytes.length === 0) throw new Error('empty');
    return bytes;
  } catch {
    throw new Error(`RADIX_MERKLE_HASH_HEX_INVALID:${hex}`);
  }
};
const HEX_BYTE_TEXT = Array.from(
  { length: 256 },
  (_, value) => value.toString(16).padStart(2, '0'),
);

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

const bytesToHex = (bytes: Uint8Array): string => {
  let output = '';
  for (const byte of bytes) output += HEX_BYTE_TEXT[byte];
  return output;
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

const leafHash = (
  leaf: RadixMerkleLeaf,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => hashParts(LEAF_DOMAIN, [leaf.key, leaf.value], hashAlgorithm);

export const computeRadixMerkleLeafHash = (
  key: Uint8Array,
  value: Uint8Array,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => leafHash({ key, value }, hashAlgorithm);

/** Decode `0x` hex straight into a preimage buffer; returns the byte count. */
const writeHexInto = (target: Uint8Array, offset: number, hex: string): number => {
  const bytes = hexToBytes(hex);
  target.set(bytes, offset);
  return bytes.length;
};

const branchHashOrdered = (
  radix: RadixMerkleRadix,
  children: Array<[number, string]>,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
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
  return hashAlgorithm === 'keccak256' ? ethers.keccak256(payload) : computeIntegrityDigest(payload);
};

const branchHash = (
  radix: RadixMerkleRadix,
  children: Array<[number, string]>,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => branchHashOrdered(
  radix,
  children.sort((left, right) => left[0] - right[0]),
  hashAlgorithm,
);

/** Dense slot form used by the persistent Patricia hot path; no sort is needed. */
export const computeRadixMerkleBranchHashFromSlots = (
  radix: RadixMerkleRadix,
  children: readonly (string | undefined)[],
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => {
  if (children.length !== radix) {
    throw new Error(`RADIX_MERKLE_BRANCH_WIDTH_INVALID:${children.length}:${radix}`);
  }
  const ordered: Array<[number, string]> = [];
  for (let slot = 0; slot < children.length; slot += 1) {
    const hash = children[slot];
    if (hash !== undefined) ordered.push([slot, hash]);
  }
  return branchHashOrdered(radix, ordered, hashAlgorithm);
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
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string =>
  hashParts(EXTENSION_DOMAIN, [
    Uint8Array.of(radixTag(radix)),
    encodePathSegment(radix, path),
    hexToBytes(childHash),
  ], hashAlgorithm);

export const computeRadixMerkleEdgeHash = (
  radix: RadixMerkleRadix,
  parentPath: readonly number[],
  childKind: 'branch' | 'leaf',
  childPath: readonly number[],
  childNodeHash: string,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => {
  if (childKind === 'leaf') return childNodeHash;
  const segment = childPath.slice(parentPath.length + 1);
  return segment.length > 0
    ? extensionHash(radix, segment, childNodeHash, hashAlgorithm)
    : childNodeHash;
};

const computeRadixMerkleRootHash = (
  radix: RadixMerkleRadix,
  rootKind: RadixMerkleRootKind,
  rootPath: number[],
  rootNodeHash: string,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => {
  if (rootKind === 'empty') return EMPTY_RADIX_MERKLE_ROOT;
  if (rootKind === 'leaf') return rootNodeHash;
  return rootPath.length > 0
    ? extensionHash(radix, rootPath, rootNodeHash, hashAlgorithm)
    : rootNodeHash;
};


type MerkleItem = {
  keyHex: string;
  path: number[];
  key: Uint8Array;
  value: Uint8Array;
  hash: string;
};

type MerkleMaterializedNode =
  | {
      kind: 'leaf';
      path: number[];
      keyHex: string;
      valueHash: string;
      hash: string;
    }
  | {
      kind: 'branch';
      path: number[];
      hash: string;
      children: Array<{ slot: number; node: MerkleMaterializedNode }>;
    };

const commonPrefixLength = (items: MerkleItem[], offset: number, depth: number): number => {
  if (items.length <= 1 || offset >= depth) return 0;
  let length = 0;
  while (offset + length < depth) {
    const slot = items[0]?.path[offset + length];
    if (slot === undefined) break;
    for (let index = 1; index < items.length; index += 1) {
      if (items[index]?.path[offset + length] !== slot) return length;
    }
    length += 1;
  }
  return length;
};

type MerkleBuildContext = {
  radix: RadixMerkleRadix;
  hashAlgorithm: RadixMerkleHashAlgorithm;
  depth: number;
};

// Fixed-schema trees (Entity account leaf, Account state root) rebuild the
// same few dozen keys on every commit; their slot paths never change.
const PATH_SLOT_CACHE_MAX = 4096;
const pathSlotCache = new Map<string, number[]>();
const cachedPathSlots = (keyHex: string, key: Uint8Array, radix: RadixMerkleRadix): number[] => {
  const cacheKey = `${radix}:${keyHex}`;
  const hit = pathSlotCache.get(cacheKey);
  if (hit) return hit;
  const slots = pathSlots(key, radix);
  if (pathSlotCache.size >= PATH_SLOT_CACHE_MAX) pathSlotCache.clear();
  pathSlotCache.set(cacheKey, slots);
  return slots;
};

const normalizeMerkleItems = (
  leaves: RadixMerkleLeaf[],
  radix: RadixMerkleRadix,
  hashAlgorithm: RadixMerkleHashAlgorithm,
): { items: MerkleItem[]; depth: number } => {
  const deduped = new Map<string, MerkleItem>();
  for (const leaf of leaves) {
    const keyHex = bytesToHex(leaf.key);
    if (deduped.has(keyHex)) {
      // Last-write-wins would hide a storage namespace collision and make the
      // committed root depend on caller order.
      throw new Error(`RADIX_MERKLE_DUPLICATE_KEY:${keyHex}`);
    }
    deduped.set(keyHex, {
      keyHex,
      key: leaf.key,
      value: leaf.value,
      path: cachedPathSlots(keyHex, leaf.key, radix),
      hash: leaf.hash ?? leafHash(leaf, hashAlgorithm),
    });
  }
  const items = Array.from(deduped.values());
  const depth = items[0]?.path.length ?? 0;
  for (const item of items) {
    if (item.path.length !== depth) {
      throw new Error(
        `RADIX_MERKLE_MIXED_KEY_LENGTHS: expected=${depth} actual=${item.path.length}`,
      );
    }
  }
  return { items, depth };
};

const bucketMerkleItems = (
  items: MerkleItem[],
  offset: number,
): Map<number, MerkleItem[]> => {
  const buckets = new Map<number, MerkleItem[]>();
  for (const item of items) {
    const slot = item.path[offset] ?? 0;
    const bucket = buckets.get(slot);
    if (bucket) bucket.push(item);
    else buckets.set(slot, [item]);
  }
  return buckets;
};

type MerkleMaterializationContext = MerkleBuildContext & {
  branches: RadixMerkleMaterializedBranch[];
  leaves: RadixMerkleMaterializedLeaf[];
  branchCount: number;
  extensionCount: number;
  maxDepth: number;
};

const materializedEdgeHash = (
  context: MerkleBuildContext,
  parentPath: number[],
  child: MerkleMaterializedNode,
): string => {
  if (child.kind === 'leaf') return child.hash;
  const segment = child.path.slice(parentPath.length + 1);
  return segment.length > 0
    ? extensionHash(
        context.radix,
        segment,
        child.hash,
        context.hashAlgorithm,
      )
    : child.hash;
};

const materializeLeaf = (
  context: MerkleMaterializationContext,
  item: MerkleItem,
): MerkleMaterializedNode => {
  const leaf: MerkleMaterializedNode = {
    kind: 'leaf',
    path: [...item.path],
    keyHex: `0x${item.keyHex}`,
    valueHash: `0x${bytesToHex(item.value)}`,
    hash: item.hash,
  };
  context.leaves.push({
    path: [...leaf.path],
    key: leaf.keyHex,
    valueHash: leaf.valueHash,
    hash: leaf.hash,
  });
  return leaf;
};

const buildMaterializedMerkleNode = (
  context: MerkleMaterializationContext,
  offset: number,
  group: MerkleItem[],
): MerkleMaterializedNode => {
  if (group.length === 1 || offset >= context.depth) {
    const item = group[0];
    if (!item) throw new Error('RADIX_MERKLE_EMPTY_MATERIALIZED_NODE');
    context.maxDepth = Math.max(context.maxDepth, offset);
    return materializeLeaf(context, item);
  }
  const shared = commonPrefixLength(group, offset, context.depth);
  context.branchCount += 1;
  if (shared > 0) context.extensionCount += 1;
  const branchOffset = offset + shared;
  const branchPath = group[0]?.path.slice(0, branchOffset) ?? [];
  const children = Array.from(bucketMerkleItems(group, branchOffset).entries())
    .sort(([left], [right]) => left - right)
    .map(([slot, bucket]) => ({
      slot,
      node: buildMaterializedMerkleNode(
        context,
        branchOffset + 1,
        bucket,
      ),
    }));
  const branch: MerkleMaterializedNode = {
    kind: 'branch',
    path: branchPath,
    hash: branchHash(
      context.radix,
      children.map(child => [
        child.slot,
        materializedEdgeHash(context, branchPath, child.node),
      ]),
      context.hashAlgorithm,
    ),
    children,
  };
  context.branches.push({
    path: [...branch.path],
    hash: branch.hash,
    children: children.map(child => ({
      slot: child.slot,
      kind: child.node.kind,
      path: [...child.node.path],
      hash: materializedEdgeHash(context, branch.path, child.node),
    })),
  });
  return branch;
};

export const buildRadixMerkle = (
  leaves: RadixMerkleLeaf[],
  options?: RadixMerkleOptions,
): RadixMerkleResult => {
  const radix = options?.radix ?? 16;
  const hashAlgorithm = options?.hashAlgorithm ?? 'integrity';
  if (leaves.length === 0) {
    return {
      radix,
      depth: 0,
      leafCount: 0,
      branchCount: 0,
      extensionCount: 0,
      maxDepth: 0,
      root: EMPTY_RADIX_MERKLE_ROOT,
    };
  }
  const { items, depth } = normalizeMerkleItems(leaves, radix, hashAlgorithm);
  const counters = { branchCount: 0, extensionCount: 0, maxDepth: 0 };
  type CompactNode = Readonly<{
    kind: 'leaf' | 'branch';
    path: number[];
    hash: string;
  }>;
  const buildCompact = (offset: number, group: MerkleItem[]): CompactNode => {
    if (group.length === 1 || offset >= depth) {
      const item = group[0];
      if (!item) throw new Error('RADIX_MERKLE_EMPTY_COMPACT_NODE');
      counters.maxDepth = Math.max(counters.maxDepth, offset);
      return { kind: 'leaf', path: item.path, hash: item.hash };
    }
    const shared = commonPrefixLength(group, offset, depth);
    counters.branchCount += 1;
    if (shared > 0) counters.extensionCount += 1;
    const branchOffset = offset + shared;
    const branchPath = group[0]?.path.slice(0, branchOffset) ?? [];
    const children = Array.from(bucketMerkleItems(group, branchOffset).entries())
      .sort(([left], [right]) => left - right)
      .map(([slot, bucket]) => ({ slot, node: buildCompact(branchOffset + 1, bucket) }));
    return {
      kind: 'branch',
      path: branchPath,
      hash: branchHash(
        radix,
        children.map(({ slot, node }) => [
          slot,
          node.kind === 'leaf'
            ? node.hash
            : computeRadixMerkleEdgeHash(
                radix,
                branchPath,
                node.kind,
                node.path,
                node.hash,
                hashAlgorithm,
              ),
        ]),
        hashAlgorithm,
      ),
    };
  };
  const rootNode = buildCompact(0, items);
  return {
    radix,
    depth,
    leafCount: leaves.length,
    branchCount: counters.branchCount,
    extensionCount: counters.extensionCount,
    maxDepth: counters.maxDepth,
    root: computeRadixMerkleRootHash(
      radix,
      rootNode.kind,
      rootNode.path,
      rootNode.hash,
      hashAlgorithm,
    ),
  };
};

export const buildRadixMerkleMaterialized = (
  leaves: RadixMerkleLeaf[],
  options?: RadixMerkleOptions,
): RadixMerkleMaterializedResult => {
  const radix = options?.radix ?? 16;
  const hashAlgorithm = options?.hashAlgorithm ?? 'integrity';
  if (leaves.length === 0) {
    return {
      radix,
      depth: 0,
      leafCount: 0,
      branchCount: 0,
      extensionCount: 0,
      maxDepth: 0,
      root: EMPTY_RADIX_MERKLE_ROOT,
      rootKind: 'empty',
      rootPath: [],
      branches: [],
      leaves: [],
    };
  }

  const { items, depth } = normalizeMerkleItems(
    leaves,
    radix,
    hashAlgorithm,
  );
  const context: MerkleMaterializationContext = {
    radix,
    hashAlgorithm,
    depth,
    branches: [],
    leaves: [],
    branchCount: 0,
    extensionCount: 0,
    maxDepth: 0,
  };
  const materializedRoot = buildMaterializedMerkleNode(context, 0, items);
  const rootHash = computeRadixMerkleRootHash(
    radix,
    materializedRoot.kind,
    materializedRoot.path,
    materializedRoot.hash,
    hashAlgorithm,
  );

  return {
    radix,
    depth,
    leafCount: items.length,
    branchCount: context.branchCount,
    extensionCount: context.extensionCount,
    maxDepth: context.maxDepth,
    root: rootHash,
    rootKind: materializedRoot.kind,
    rootPath: [...materializedRoot.path],
    branches: context.branches,
    leaves: context.leaves,
  };
};

export const buildHexKeyedMerkle = (
  leaves: Array<{ hexKey: string; value: Uint8Array }>,
  options?: RadixMerkleOptions,
): RadixMerkleResult => {
  return buildRadixMerkle(
    leaves.map((leaf) => ({
      key: hexToBytes(leaf.hexKey),
      value: leaf.value,
    })),
    options,
  );
};
