import { ethers } from 'ethers';

export type RadixMerkleRadix = 16 | 256;

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

const EMPTY_ROOT = `0x${'00'.repeat(32)}`;

const hashParts = (tag: number, parts: Uint8Array[]): string => {
  return ethers.keccak256(Buffer.concat([Buffer.from([tag]), ...parts.map((part) => Buffer.from(part))]));
};

const hexToBytes = (hex: string): Uint8Array => {
  return Uint8Array.from(Buffer.from(String(hex).replace(/^0x/, ''), 'hex'));
};

const pathSlots = (key: Uint8Array, radix: RadixMerkleRadix): number[] => {
  if (radix === 256) return Array.from(key);
  return Array.from(key).flatMap((byte) => [byte >> 4, byte & 0x0f]);
};

const leafHash = (leaf: RadixMerkleLeaf): string => hashParts(0x00, [leaf.key, leaf.value]);

const branchHash = (radix: RadixMerkleRadix, children: Array<[number, string]>): string => {
  if (children.length === 0) return EMPTY_ROOT;
  const parts: Uint8Array[] = [Uint8Array.of(radix === 256 ? 0xff : 0x10)];
  for (const [slot, hash] of children.sort((left, right) => left[0] - right[0])) {
    parts.push(Uint8Array.of(slot));
    parts.push(hexToBytes(hash));
  }
  return hashParts(0x01, parts);
};

const encodePathSegment = (radix: RadixMerkleRadix, path: number[]): Uint8Array => {
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(path.length);
  if (radix === 256) return Buffer.concat([header, Buffer.from(path)]);

  const packed = Buffer.alloc(Math.ceil(path.length / 2));
  for (let index = 0; index < path.length; index += 1) {
    const slot = path[index] ?? 0;
    if (slot < 0 || slot > 0x0f) throw new Error(`RADIX_MERKLE_INVALID_NIBBLE: ${slot}`);
    const byteIndex = Math.floor(index / 2);
    if (index % 2 === 0) packed[byteIndex] = (packed[byteIndex] ?? 0) | (slot << 4);
    else packed[byteIndex] = (packed[byteIndex] ?? 0) | slot;
  }
  return Buffer.concat([header, packed]);
};

const extensionHash = (radix: RadixMerkleRadix, path: number[], childHash: string): string =>
  hashParts(0x02, [
    Uint8Array.of(radix === 256 ? 0xff : 0x10),
    encodePathSegment(radix, path),
    hexToBytes(childHash),
  ]);

type MerkleItem = {
  path: number[];
  hash: string;
};

type MerkleNode = {
  hash: string;
  branchCount: number;
  extensionCount: number;
  maxDepth: number;
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
  options?: { radix?: RadixMerkleRadix },
): RadixMerkleResult => {
  const radix = options?.radix === 256 ? 256 : 16;
  if (leaves.length === 0) {
    return { radix, depth: 0, leafCount: 0, branchCount: 0, extensionCount: 0, maxDepth: 0, root: EMPTY_ROOT };
  }

  const deduped = new Map<string, MerkleItem>();
  for (const leaf of leaves) {
    const keyHex = Buffer.from(leaf.key).toString('hex');
    deduped.set(keyHex, {
      path: pathSlots(leaf.key, radix),
      hash: leafHash(leaf),
    });
  }

  const items = Array.from(deduped.values());
  const depth = items[0]?.path.length ?? 0;
  for (const item of items) {
    if (item.path.length !== depth) {
      throw new Error(`RADIX_MERKLE_MIXED_KEY_LENGTHS: expected=${depth} actual=${item.path.length}`);
    }
  }

  const buildNode = (offset: number, group: MerkleItem[]): MerkleNode => {
    if (group.length === 0) return { hash: EMPTY_ROOT, branchCount: 0, extensionCount: 0, maxDepth: offset };
    if (group.length === 1 || offset >= depth) {
      return { hash: group[0]?.hash ?? EMPTY_ROOT, branchCount: 0, extensionCount: 0, maxDepth: offset };
    }

    const shared = commonPrefixLength(group, offset, depth);
    if (shared > 0) {
      const child = buildNode(offset + shared, group);
      return {
        hash: extensionHash(radix, group[0]?.path.slice(offset, offset + shared) ?? [], child.hash),
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

    const children = Array.from(buckets.entries()).map(([slot, bucket]) => [slot, buildNode(offset + 1, bucket)] as const);
    return {
      hash: branchHash(
        radix,
        children.map(([slot, child]) => [slot, child.hash]),
      ),
      branchCount: children.reduce((sum, [, child]) => sum + child.branchCount, 1),
      extensionCount: children.reduce((sum, [, child]) => sum + child.extensionCount, 0),
      maxDepth: children.reduce((max, [, child]) => Math.max(max, child.maxDepth), offset + 1),
    };
  };

  const root = buildNode(0, items);

  return {
    radix,
    depth,
    leafCount: items.length,
    branchCount: root.branchCount,
    extensionCount: root.extensionCount,
    maxDepth: root.maxDepth,
    root: root.hash,
  };
};

export const buildHexKeyedMerkle = (
  leaves: Array<{ hexKey: string; value: Uint8Array }>,
  options?: { radix?: RadixMerkleRadix },
): RadixMerkleResult => {
  return buildRadixMerkle(
    leaves.map((leaf) => ({
      key: hexToBytes(leaf.hexKey),
      value: leaf.value,
    })),
    options,
  );
};
