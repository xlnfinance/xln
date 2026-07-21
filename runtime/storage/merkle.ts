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

type MerkleSummaryNode = {
  hash: string;
  branchCount: number;
  extensionCount: number;
  maxDepth: number;
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

  const deduped = new Map<string, MerkleItem>();
  for (const leaf of leaves) {
    const keyHex = bytesToHex(leaf.key);
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
      throw new Error(`RADIX_MERKLE_MIXED_KEY_LENGTHS: expected=${depth} actual=${item.path.length}`);
    }
  }

  const buildSummaryNode = (offset: number, group: MerkleItem[]): MerkleSummaryNode => {
    if (group.length === 0) return { hash: EMPTY_RADIX_MERKLE_ROOT, branchCount: 0, extensionCount: 0, maxDepth: offset };
    if (group.length === 1 || offset >= depth) {
      return { hash: group[0]?.hash ?? EMPTY_RADIX_MERKLE_ROOT, branchCount: 0, extensionCount: 0, maxDepth: offset };
    }

    const shared = commonPrefixLength(group, offset, depth);
    if (shared > 0) {
      const child = buildSummaryNode(offset + shared, group);
      return {
        hash: extensionHash(
          radix,
          group[0]?.path.slice(offset, offset + shared) ?? [],
          child.hash,
          hashAlgorithm,
        ),
        branchCount: child.branchCount,
        extensionCount: child.extensionCount + 1,
        maxDepth: child.maxDepth,
      };
    }

    const buckets = new Map<number, MerkleItem[]>();
    for (const item of group) {
      const slot = item.path[offset] ?? 0;
      const existing = buckets.get(slot);
      if (existing) existing.push(item);
      else buckets.set(slot, [item]);
    }

    const children = Array.from(buckets.entries()).map(([slot, bucket]) => [slot, buildSummaryNode(offset + 1, bucket)] as const);
    return {
      hash: branchHash(
        radix,
        children.map(([slot, child]) => [slot, child.hash]),
        hashAlgorithm,
      ),
      branchCount: children.reduce((sum, [, child]) => sum + child.branchCount, 1),
      extensionCount: children.reduce((sum, [, child]) => sum + child.extensionCount, 0),
      maxDepth: children.reduce((max, [, child]) => Math.max(max, child.maxDepth), offset + 1),
    };
  };

  const materializedLeaves: RadixMerkleMaterializedLeaf[] = [];
  const materializedBranches: RadixMerkleMaterializedBranch[] = [];

  const nodeHash = (node: MerkleMaterializedNode): string => node.hash;
  const edgeHash = (parentPath: number[], child: MerkleMaterializedNode): string => {
    if (child.kind === 'leaf') return child.hash;
    const segment = child.path.slice(parentPath.length + 1);
    return segment.length > 0 ? extensionHash(radix, segment, child.hash, hashAlgorithm) : child.hash;
  };

  const buildNode = (offset: number, group: MerkleItem[]): MerkleMaterializedNode => {
    if (group.length === 1 || offset >= depth) {
      const item = group[0]!;
      const leaf: MerkleMaterializedNode = {
        kind: 'leaf',
        path: [...item.path],
        keyHex: `0x${item.keyHex}`,
        valueHash: `0x${bytesToHex(item.value)}`,
        hash: item.hash,
      };
      materializedLeaves.push({
        path: [...leaf.path],
        key: leaf.keyHex,
        valueHash: leaf.valueHash,
        hash: leaf.hash,
      });
      return leaf;
    }

    const shared = commonPrefixLength(group, offset, depth);
    const branchOffset = offset + shared;
    const branchPath = group[0]?.path.slice(0, branchOffset) ?? [];
    const buckets = new Map<number, MerkleItem[]>();
    for (const item of group) {
      const slot = item.path[branchOffset] ?? 0;
      const existing = buckets.get(slot);
      if (existing) existing.push(item);
      else buckets.set(slot, [item]);
    }

    const children = Array.from(buckets.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([slot, bucket]) => ({ slot, node: buildNode(branchOffset + 1, bucket) }));
    const branch: MerkleMaterializedNode = {
      kind: 'branch',
      path: branchPath,
      hash: branchHash(
        radix,
        children.map((child) => [child.slot, edgeHash(branchPath, child.node)]),
        hashAlgorithm,
      ),
      children,
    };
    materializedBranches.push({
      path: [...branch.path],
      hash: branch.hash,
      children: children.map((child) => ({
        slot: child.slot,
        kind: child.node.kind,
        path: [...child.node.path],
        hash: edgeHash(branch.path, child.node),
      })),
    });
    return branch;
  };

  const summaryRoot = buildSummaryNode(0, items);
  const materializedRoot = buildNode(0, items);
  const rootHash = computeRadixMerkleRootHash(
    radix,
    materializedRoot.kind,
    materializedRoot.path,
    nodeHash(materializedRoot),
    hashAlgorithm,
  );

  return {
    radix,
    depth,
    leafCount: items.length,
    branchCount: summaryRoot.branchCount,
    extensionCount: summaryRoot.extensionCount,
    maxDepth: summaryRoot.maxDepth,
    root: rootHash,
    rootKind: materializedRoot.kind,
    rootPath: [...materializedRoot.path],
    branches: materializedBranches,
    leaves: materializedLeaves,
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
