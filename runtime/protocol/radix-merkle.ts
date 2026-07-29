import { ethers } from 'ethers';
import { computeIntegrityDigest } from '../infra/integrity-checksum';

export type RadixMerkleRadix = 16 | 256;
export type RadixMerkleHashAlgorithm = 'integrity' | 'keccak256';
export type RadixMerkleOptions = {
  radix?: RadixMerkleRadix;
  hashAlgorithm?: RadixMerkleHashAlgorithm;
};

export type RadixMerkleLeaf = {
  key: Uint8Array;
  value: Uint8Array;
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

export type RadixMerkleRootKind = 'empty' | 'branch' | 'leaf';

export type RadixMerkleRootRef = {
  kind: RadixMerkleRootKind;
  path: number[];
};

export type RadixMerkleMaterializedLeaf = {
  path: number[];
  key: string;
  valueHash: string;
  hash: string;
};

export type RadixMerkleMaterializedBranch = {
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

const bytesToHex = (bytes: Uint8Array): string => ethers.hexlify(bytes).slice(2);

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

const hexToBytes = (hex: string): Uint8Array => {
  const normalized = String(hex).replace(/^0x/, '');
  return ethers.getBytes(`0x${normalized}`);
};

const pathSlots = (key: Uint8Array, radix: RadixMerkleRadix): number[] => {
  if (radix === 256) return Array.from(key);
  return Array.from(key).flatMap((byte) => [byte >> 4, byte & 0x0f]);
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

const branchHash = (
  radix: RadixMerkleRadix,
  children: Array<[number, string]>,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => {
  if (children.length === 0) return EMPTY_RADIX_MERKLE_ROOT;
  const parts: Uint8Array[] = [Uint8Array.of(radix === 256 ? 0xff : 0x10)];
  for (const [slot, hash] of children.sort((left, right) => left[0] - right[0])) {
    parts.push(Uint8Array.of(slot));
    parts.push(hexToBytes(hash));
  }
  return hashParts(BRANCH_DOMAIN, parts, hashAlgorithm);
};

export const computeRadixMerkleBranchHash = (
  radix: RadixMerkleRadix,
  children: Array<[number, string]>,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => branchHash(radix, children, hashAlgorithm);

const encodePathSegment = (radix: RadixMerkleRadix, path: number[]): Uint8Array => {
  const header = uint16Bytes(path.length);
  if (radix === 256) return concatBytes(header, Uint8Array.from(path));

  const packed = new Uint8Array(Math.ceil(path.length / 2));
  for (let index = 0; index < path.length; index += 1) {
    const slot = path[index] ?? 0;
    if (slot < 0 || slot > 0x0f) throw new Error(`RADIX_MERKLE_INVALID_NIBBLE: ${slot}`);
    const byteIndex = Math.floor(index / 2);
    if (index % 2 === 0) packed[byteIndex] = (packed[byteIndex] ?? 0) | (slot << 4);
    else packed[byteIndex] = (packed[byteIndex] ?? 0) | slot;
  }
  return concatBytes(header, packed);
};

export const packRadixMerklePath = (radix: RadixMerkleRadix, path: number[]): Uint8Array =>
  encodePathSegment(radix, path);

const extensionHash = (
  radix: RadixMerkleRadix,
  path: number[],
  childHash: string,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string =>
  hashParts(EXTENSION_DOMAIN, [
    Uint8Array.of(radix === 256 ? 0xff : 0x10),
    encodePathSegment(radix, path),
    hexToBytes(childHash),
  ], hashAlgorithm);

export const computeRadixMerkleEdgeHash = (
  radix: RadixMerkleRadix,
  parentPath: number[],
  childKind: 'branch' | 'leaf',
  childPath: number[],
  childNodeHash: string,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'integrity',
): string => {
  if (childKind === 'leaf') return childNodeHash;
  const segment = childPath.slice(parentPath.length + 1);
  return segment.length > 0
    ? extensionHash(radix, segment, childNodeHash, hashAlgorithm)
    : childNodeHash;
};

export const computeRadixMerkleRootHash = (
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
      path: pathSlots(leaf.key, radix),
      hash: leafHash(leaf, hashAlgorithm),
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
  const built = buildRadixMerkleMaterialized(leaves, options);
  return {
    radix: built.radix,
    depth: built.depth,
    leafCount: built.leafCount,
    branchCount: built.branchCount,
    extensionCount: built.extensionCount,
    maxDepth: built.maxDepth,
    root: built.root,
  };
};

export const buildRadixMerkleMaterialized = (
  leaves: RadixMerkleLeaf[],
  options?: RadixMerkleOptions,
): RadixMerkleMaterializedResult => {
  const radix = options?.radix === 256 ? 256 : 16;
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

export const buildHexKeyedMerkleMaterialized = (
  leaves: Array<{ hexKey: string; value: Uint8Array }>,
  options?: RadixMerkleOptions,
): RadixMerkleMaterializedResult => {
  return buildRadixMerkleMaterialized(
    leaves.map((leaf) => ({
      key: hexToBytes(leaf.hexKey),
      value: leaf.value,
    })),
    options,
  );
};
