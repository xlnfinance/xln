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

export const buildRadixMerkle = (
  leaves: RadixMerkleLeaf[],
  options?: { radix?: RadixMerkleRadix },
): RadixMerkleResult => {
  const radix = options?.radix === 256 ? 256 : 16;
  if (leaves.length === 0) {
    return { radix, depth: 0, leafCount: 0, root: EMPTY_ROOT };
  }

  const deduped = new Map<string, { path: number[]; hash: string }>();
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

  const buildNode = (level: number, group: typeof items): string => {
    if (group.length === 0) return EMPTY_ROOT;
    if (level >= depth) {
      return group[0]?.hash ?? EMPTY_ROOT;
    }

    const buckets = new Map<number, typeof items>();
    for (const item of group) {
      const slot = item.path[level] ?? 0;
      const existing = buckets.get(slot);
      if (existing) existing.push(item);
      else buckets.set(slot, [item]);
    }

    return branchHash(
      radix,
      Array.from(buckets.entries()).map(([slot, bucket]) => [slot, buildNode(level + 1, bucket)]),
    );
  };

  return {
    radix,
    depth,
    leafCount: items.length,
    root: buildNode(0, items),
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
