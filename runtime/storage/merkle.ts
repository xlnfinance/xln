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

export type RadixMerkleStoredChild = {
  slot: number;
  kind: 'branch' | 'leaf';
  path: number[];
  hash: string;
};

export type RadixMerkleStoredBranch = {
  radix: RadixMerkleRadix;
  path: number[];
  hash: string;
  children: RadixMerkleStoredChild[];
};

export type RadixMerkleStoredLeaf = {
  radix: RadixMerkleRadix;
  path: number[];
  key: string;
  valueHash: string;
  hash: string;
};

export type RadixMerkleDirtyNodes = {
  rootHash: string;
  leafCount: number;
  branchPuts: RadixMerkleStoredBranch[];
  leafPuts: RadixMerkleStoredLeaf[];
  branchDels: number[][];
  leafDels: number[][];
};

const EMPTY_ROOT = `0x${'00'.repeat(32)}`;

const domainBytes = (tag: string): Buffer => {
  const raw = Buffer.from(tag, 'utf8');
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(raw.length);
  return Buffer.concat([len, raw]);
};

const LEAF_DOMAIN = domainBytes('xln.storage.merkle.leaf.v1');
const BRANCH_DOMAIN = domainBytes('xln.storage.merkle.branch.v1');
const EXTENSION_DOMAIN = domainBytes('xln.storage.merkle.extension.v1');

const hashParts = (domain: Buffer, parts: Uint8Array[]): string => {
  return ethers.keccak256(Buffer.concat([domain, ...parts.map((part) => Buffer.from(part))]));
};

const hexToBytes = (hex: string): Uint8Array => {
  return Uint8Array.from(Buffer.from(String(hex).replace(/^0x/, ''), 'hex'));
};

const bytesToHex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

const pathSlots = (key: Uint8Array, radix: RadixMerkleRadix): number[] => {
  if (radix === 256) return Array.from(key);
  return Array.from(key).flatMap((byte) => [byte >> 4, byte & 0x0f]);
};

const leafHash = (leaf: RadixMerkleLeaf): string =>
  hashParts(LEAF_DOMAIN, [leaf.key, leaf.value]);

const branchHash = (radix: RadixMerkleRadix, children: Array<[number, string]>): string => {
  if (children.length === 0) return EMPTY_ROOT;
  const parts: Uint8Array[] = [Uint8Array.of(radix === 256 ? 0xff : 0x10)];
  for (const [slot, hash] of children.sort((left, right) => left[0] - right[0])) {
    parts.push(Uint8Array.of(slot));
    parts.push(hexToBytes(hash));
  }
  return hashParts(BRANCH_DOMAIN, parts);
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

export const packRadixMerklePath = (radix: RadixMerkleRadix, path: number[]): Buffer =>
  Buffer.from(encodePathSegment(radix, path));

const extensionHash = (radix: RadixMerkleRadix, path: number[], childHash: string): string =>
  hashParts(EXTENSION_DOMAIN, [
    Uint8Array.of(radix === 256 ? 0xff : 0x10),
    encodePathSegment(radix, path),
    hexToBytes(childHash),
  ]);

type MerkleItem = {
  keyHex: string;
  path: number[];
  hash: string;
};

type MerkleNode = {
  hash: string;
  branchCount: number;
  extensionCount: number;
  maxDepth: number;
};

type MutableLeafNode = {
  kind: 'leaf';
  key: Uint8Array;
  path: number[];
  value: Uint8Array;
  hash?: string;
  dirty?: boolean;
};

type MutableBranchNode = {
  kind: 'branch';
  path: number[];
  children: Map<number, MutableMerkleNode>;
  hash?: string;
  dirty?: boolean;
};

type MutableMerkleNode = MutableLeafNode | MutableBranchNode;

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

const commonPathPrefixLength = (left: number[], right: number[]): number => {
  const max = Math.min(left.length, right.length);
  let length = 0;
  while (length < max && left[length] === right[length]) length += 1;
  return length;
};

const pathHasPrefix = (path: number[], prefix: number[]): boolean => {
  if (prefix.length > path.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (path[index] !== prefix[index]) return false;
  }
  return true;
};

const mutableLeaf = (key: Uint8Array, value: Uint8Array, radix: RadixMerkleRadix): MutableLeafNode => ({
  kind: 'leaf',
  key: Uint8Array.from(key),
  path: pathSlots(key, radix),
  value: Uint8Array.from(value),
  dirty: true,
});

const invalidateNode = (node: MutableMerkleNode): void => {
  delete node.hash;
  node.dirty = true;
};

const mutableNodeHash = (node: MutableMerkleNode, radix: RadixMerkleRadix): string => {
  if (node.hash) return node.hash;
  if (node.kind === 'leaf') {
    node.hash = leafHash({ key: node.key, value: node.value });
    return node.hash;
  }
  node.hash = branchHash(
    radix,
    Array.from(node.children.entries()).map(([slot, child]) => [slot, mutableEdgeHash(node.path, child, radix)]),
  );
  return node.hash;
};

const mutableEdgeHash = (
  parentPath: number[],
  child: MutableMerkleNode,
  radix: RadixMerkleRadix,
): string => {
  const childHash = mutableNodeHash(child, radix);
  if (child.kind === 'leaf') return childHash;
  const segment = child.path.slice(parentPath.length + 1);
  return segment.length > 0 ? extensionHash(radix, segment, childHash) : childHash;
};

const mutableRootHash = (root: MutableMerkleNode | null, radix: RadixMerkleRadix): string => {
  if (!root) return EMPTY_ROOT;
  const hash = mutableNodeHash(root, radix);
  return root.kind === 'branch' && root.path.length > 0
    ? extensionHash(radix, root.path, hash)
    : hash;
};

const insertMutableNode = (
  node: MutableMerkleNode | null,
  leaf: MutableLeafNode,
): { node: MutableMerkleNode; touchedNodes: number } => {
  if (!node) return { node: leaf, touchedNodes: 1 };
  if (node.kind === 'leaf') {
    if (node.path.length === leaf.path.length && commonPathPrefixLength(node.path, leaf.path) === node.path.length) {
      node.value = Uint8Array.from(leaf.value);
      invalidateNode(node);
      return { node, touchedNodes: 1 };
    }
    const shared = commonPathPrefixLength(node.path, leaf.path);
    const branch: MutableBranchNode = {
      kind: 'branch',
      path: node.path.slice(0, shared),
      children: new Map<number, MutableMerkleNode>([
        [node.path[shared] ?? 0, node],
        [leaf.path[shared] ?? 0, leaf],
      ]),
      dirty: true,
    };
    return { node: branch, touchedNodes: 2 };
  }

  const shared = commonPathPrefixLength(node.path, leaf.path);
  if (shared < node.path.length) {
    const branch: MutableBranchNode = {
      kind: 'branch',
      path: node.path.slice(0, shared),
      children: new Map<number, MutableMerkleNode>([
        [node.path[shared] ?? 0, node],
        [leaf.path[shared] ?? 0, leaf],
      ]),
      dirty: true,
    };
    return { node: branch, touchedNodes: 2 };
  }

  const slot = leaf.path[node.path.length] ?? 0;
  const child = node.children.get(slot) ?? null;
  const inserted = insertMutableNode(child, leaf);
  node.children.set(slot, inserted.node);
  invalidateNode(node);
  return { node, touchedNodes: inserted.touchedNodes + 1 };
};

const collapseMutableBranch = (node: MutableBranchNode): MutableMerkleNode | null => {
  if (node.children.size === 0) return null;
  if (node.children.size === 1) return Array.from(node.children.values())[0] ?? null;
  return node;
};

const deleteMutableNode = (
  node: MutableMerkleNode | null,
  path: number[],
): { node: MutableMerkleNode | null; deleted: boolean; touchedNodes: number; branchDels: number[][]; leafDels: number[][] } => {
  if (!node) return { node: null, deleted: false, touchedNodes: 0, branchDels: [], leafDels: [] };
  if (node.kind === 'leaf') {
    const matches = node.path.length === path.length && commonPathPrefixLength(node.path, path) === path.length;
    return {
      node: matches ? null : node,
      deleted: matches,
      touchedNodes: matches ? 1 : 0,
      branchDels: [],
      leafDels: matches ? [node.path] : [],
    };
  }
  if (!pathHasPrefix(path, node.path)) return { node, deleted: false, touchedNodes: 0, branchDels: [], leafDels: [] };
  const slot = path[node.path.length] ?? 0;
  const child = node.children.get(slot) ?? null;
  const result = deleteMutableNode(child, path);
  if (!result.deleted) return { node, deleted: false, touchedNodes: result.touchedNodes, branchDels: result.branchDels, leafDels: result.leafDels };
  if (result.node) node.children.set(slot, result.node);
  else node.children.delete(slot);
  invalidateNode(node);
  const collapsed = collapseMutableBranch(node);
  return {
    node: collapsed,
    deleted: true,
    touchedNodes: result.touchedNodes + 1,
    branchDels: collapsed === node ? result.branchDels : [...result.branchDels, node.path],
    leafDels: result.leafDels,
  };
};

const collectMutableLeaves = (node: MutableMerkleNode | null, out: RadixMerkleLeaf[]): void => {
  if (!node) return;
  if (node.kind === 'leaf') {
    out.push({ key: Uint8Array.from(node.key), value: Uint8Array.from(node.value) });
    return;
  }
  for (const child of node.children.values()) collectMutableLeaves(child, out);
};

const mutableHasKey = (
  node: MutableMerkleNode | null,
  keyPath: number[],
): boolean => {
  if (!node) return false;
  if (node.kind === 'leaf') {
    return node.path.length === keyPath.length && commonPathPrefixLength(node.path, keyPath) === keyPath.length;
  }
  if (!pathHasPrefix(keyPath, node.path)) return false;
  const slot = keyPath[node.path.length] ?? 0;
  return mutableHasKey(node.children.get(slot) ?? null, keyPath);
};

const clearMutableDirty = (node: MutableMerkleNode | null): void => {
  if (!node) return;
  node.dirty = false;
  if (node.kind === 'branch') {
    for (const child of node.children.values()) clearMutableDirty(child);
  }
};

const collectDirtyMutableNodes = (
  node: MutableMerkleNode | null,
  radix: RadixMerkleRadix,
  out: Pick<RadixMerkleDirtyNodes, 'branchPuts' | 'leafPuts'>,
): void => {
  if (!node) return;
  if (node.kind === 'leaf') {
    if (node.dirty) {
      out.leafPuts.push({
        radix,
        path: [...node.path],
        key: bytesToHex(node.key),
        valueHash: bytesToHex(node.value),
        hash: mutableNodeHash(node, radix),
      });
    }
    return;
  }

  if (node.dirty) {
    out.branchPuts.push({
      radix,
      path: [...node.path],
      hash: mutableNodeHash(node, radix),
      children: Array.from(node.children.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([slot, child]) => ({
          slot,
          kind: child.kind,
          path: [...child.path],
          hash: mutableEdgeHash(node.path, child, radix),
        })),
    });
  }
  for (const child of node.children.values()) collectDirtyMutableNodes(child, radix, out);
};

export class MutableRadixMerkleTree {
  readonly radix: RadixMerkleRadix;
  private root: MutableMerkleNode | null = null;
  private leaves = 0;
  private lastTouched = 0;
  private deletedBranches: number[][] = [];
  private deletedLeaves: number[][] = [];

  constructor(options?: { radix?: RadixMerkleRadix; leaves?: RadixMerkleLeaf[] }) {
    this.radix = options?.radix === 256 ? 256 : 16;
    for (const leaf of options?.leaves ?? []) {
      this.put(leaf.key, leaf.value);
    }
  }

  get leafCount(): number {
    return this.leaves;
  }

  get lastTouchedNodes(): number {
    return this.lastTouched;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    const exists = mutableHasKey(this.root, pathSlots(key, this.radix));
    const result = insertMutableNode(this.root, mutableLeaf(key, value, this.radix));
    this.root = result.node;
    this.lastTouched = result.touchedNodes;
    if (!exists) this.leaves += 1;
  }

  del(key: Uint8Array): boolean {
    const result = deleteMutableNode(this.root, pathSlots(key, this.radix));
    this.root = result.node;
    this.lastTouched = result.touchedNodes;
    if (result.deleted) {
      this.leaves = Math.max(0, this.leaves - 1);
      this.deletedBranches.push(...result.branchDels.map((path) => [...path]));
      this.deletedLeaves.push(...result.leafDels.map((path) => [...path]));
    }
    return result.deleted;
  }

  getRoot(): string {
    return mutableRootHash(this.root, this.radix);
  }

  toLeaves(): RadixMerkleLeaf[] {
    const leaves: RadixMerkleLeaf[] = [];
    collectMutableLeaves(this.root, leaves);
    return leaves;
  }

  verify(mode: 'none' | 'shallow' | 'deep' = 'shallow'): void {
    if (mode === 'none') return;
    const expected = buildRadixMerkle(this.toLeaves(), { radix: this.radix });
    if (expected.leafCount !== this.leaves) {
      throw new Error(`RADIX_MERKLE_MUTABLE_LEAF_COUNT_MISMATCH: actual=${this.leaves} expected=${expected.leafCount}`);
    }
    if (expected.root !== this.getRoot()) {
      throw new Error(`RADIX_MERKLE_MUTABLE_ROOT_MISMATCH: actual=${this.getRoot()} expected=${expected.root}`);
    }
  }

  takeDirtyNodes(): RadixMerkleDirtyNodes {
    const out: RadixMerkleDirtyNodes = {
      rootHash: this.getRoot(),
      leafCount: this.leaves,
      branchPuts: [],
      leafPuts: [],
      branchDels: this.deletedBranches.map((path) => [...path]),
      leafDels: this.deletedLeaves.map((path) => [...path]),
    };
    collectDirtyMutableNodes(this.root, this.radix, out);
    clearMutableDirty(this.root);
    this.deletedBranches = [];
    this.deletedLeaves = [];
    return out;
  }
}

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
      keyHex,
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
