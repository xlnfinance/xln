import { computeIntegrityChecksum, computeIntegrityDigest, integrityChecksumFromHex } from '../infra/integrity-checksum';
import { LIMITS } from '../constants';
import { notFound } from './codec';
import { KEY_REBRANCH_NODE, hexBytes } from './keys';
import {
  buildRadixMerkleMaterialized,
  computeRadixMerkleBranchHash,
  computeRadixMerkleEdgeHash,
  computeRadixMerkleLeafHash,
  computeRadixMerkleRootHash,
  type RadixMerkleMaterializedBranch,
  type RadixMerkleRootKind,
} from './merkle';

const MAX_PHYSICAL_VALUE_BYTES = LIMITS.MAX_STORAGE_VALUE_BYTES;
const LEAF_PAYLOAD_BYTES = 4_096;
const NODE_KEY_PREFIX = KEY_REBRANCH_NODE;
const MANIFEST_MAGIC = Buffer.from([0x58, 0x4c, 0x4e, 0x52, 0x42, 0x01]);
const BRANCH_VERSION = 1;
const MAX_PAGE_KEY_BYTES = 4;
const MAX_BRANCH_VALUE_BYTES = 2 + MAX_PAGE_KEY_BYTES + 2 + 256 * (3 + MAX_PAGE_KEY_BYTES + 32);
if (MAX_BRANCH_VALUE_BYTES >= MAX_PHYSICAL_VALUE_BYTES) {
  throw new Error(`STORAGE_REBRANCH_BRANCH_CAPACITY_INVALID:${MAX_BRANCH_VALUE_BYTES}`);
}

type RawBatch = {
  put(key: Buffer, value: Buffer): unknown;
  del?(key: Buffer): unknown;
  write(options?: { sync?: boolean }): Promise<void>;
};

type RawDb = {
  get(key: Buffer): Promise<Buffer>;
  put?(key: Buffer, value: Buffer, options?: { sync?: boolean }): Promise<void>;
  batch(): RawBatch;
  keys?(options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }): AsyncIterable<Buffer | Uint8Array | string>;
};

type RebranchManifest = {
  totalBytes: number;
  leafCount: number;
  rootKind: Exclude<RadixMerkleRootKind, 'empty'>;
  rootPath: number[];
  rootHash: string;
  checksum: string;
};

type RebranchChild = {
  slot: number;
  kind: 'branch' | 'leaf';
  path: number[];
  hash: string;
};

const u16 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`STORAGE_REBRANCH_U16_INVALID:${String(value)}`);
  }
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16BE(value);
  return output;
};

const u32 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`STORAGE_REBRANCH_U32_INVALID:${String(value)}`);
  }
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value);
  return output;
};

const assertLogicalKey = (key: Buffer): void => {
  if (key.byteLength === 0 || key[0] === NODE_KEY_PREFIX) {
    throw new Error(`STORAGE_REBRANCH_LOGICAL_KEY_INVALID:${key.toString('hex')}`);
  }
};

const assertPhysicalValueSize = (value: Buffer, scope: string): void => {
  if (value.byteLength >= MAX_PHYSICAL_VALUE_BYTES) {
    throw new Error(`STORAGE_VALUE_TOO_LARGE:${scope}:bytes=${value.byteLength}:maxExclusive=${MAX_PHYSICAL_VALUE_BYTES}`);
  }
};

const encodeManifest = (manifest: RebranchManifest): Buffer => {
  if (manifest.rootPath.length > MAX_PAGE_KEY_BYTES) {
    throw new Error(`STORAGE_REBRANCH_ROOT_PATH_TOO_LONG:${manifest.rootPath.length}`);
  }
  const encoded = Buffer.concat([
    MANIFEST_MAGIC,
    u32(manifest.totalBytes),
    u32(manifest.leafCount),
    Buffer.from([manifest.rootKind === 'leaf' ? 1 : 2, manifest.rootPath.length]),
    Buffer.from(manifest.rootPath),
    hexBytes(manifest.rootHash),
    Buffer.from(integrityChecksumFromHex(manifest.checksum)),
  ]);
  assertPhysicalValueSize(encoded, 'manifest');
  return encoded;
};

const decodeManifest = (value: Buffer): RebranchManifest | null => {
  if (value.byteLength < MANIFEST_MAGIC.byteLength ||
      !value.subarray(0, MANIFEST_MAGIC.byteLength).equals(MANIFEST_MAGIC)) return null;
  const fixedOffset = MANIFEST_MAGIC.byteLength;
  if (value.byteLength < fixedOffset + 10 + 32 + 16) {
    throw new Error(`STORAGE_REBRANCH_MANIFEST_TRUNCATED:${value.byteLength}`);
  }
  const totalBytes = value.readUInt32BE(fixedOffset);
  const leafCount = value.readUInt32BE(fixedOffset + 4);
  const kindByte = value[fixedOffset + 8];
  const pathLength = value[fixedOffset + 9] ?? 0xff;
  const expectedBytes = fixedOffset + 10 + pathLength + 32 + 16;
  if (value.byteLength !== expectedBytes || pathLength > MAX_PAGE_KEY_BYTES || leafCount < 1) {
    throw new Error(
      `STORAGE_REBRANCH_MANIFEST_FIELDS_INVALID:bytes=${value.byteLength}:total=${totalBytes}:` +
      `leaves=${leafCount}:path=${pathLength}`,
    );
  }
  if (leafCount !== Math.max(1, Math.ceil(totalBytes / LEAF_PAYLOAD_BYTES))) {
    throw new Error(`STORAGE_REBRANCH_LEAF_COUNT_INVALID:bytes=${totalBytes}:leaves=${leafCount}`);
  }
  const rootKind = kindByte === 1 ? 'leaf' : kindByte === 2 ? 'branch' : null;
  if (!rootKind || (leafCount === 1) !== (rootKind === 'leaf')) {
    throw new Error(`STORAGE_REBRANCH_ROOT_KIND_INVALID:kind=${kindByte}:leaves=${leafCount}`);
  }
  const pathOffset = fixedOffset + 10;
  const hashOffset = pathOffset + pathLength;
  return {
    totalBytes,
    leafCount,
    rootKind,
    rootPath: Array.from(value.subarray(pathOffset, hashOffset)),
    rootHash: `0x${value.subarray(hashOffset, hashOffset + 32).toString('hex')}`,
    checksum: `0x${value.subarray(hashOffset + 32, hashOffset + 48).toString('hex')}`,
  };
};

const physicalKeyPrefix = (logicalKey: Buffer): Buffer => {
  if (logicalKey.byteLength > 0xffff) throw new Error(`STORAGE_REBRANCH_LOGICAL_KEY_TOO_LARGE:${logicalKey.byteLength}`);
  return Buffer.concat([Buffer.from([NODE_KEY_PREFIX]), u16(logicalKey.byteLength), logicalKey]);
};

const leafNodeKey = (logicalKey: Buffer, pageIndex: number): Buffer =>
  Buffer.concat([physicalKeyPrefix(logicalKey), Buffer.from([0]), u32(pageIndex)]);

const branchNodeKey = (logicalKey: Buffer, path: readonly number[]): Buffer => {
  if (path.length > MAX_PAGE_KEY_BYTES) {
    throw new Error(`STORAGE_REBRANCH_BRANCH_PATH_TOO_LONG:${path.length}`);
  }
  return Buffer.concat([
    physicalKeyPrefix(logicalKey),
    Buffer.from([1, path.length]),
    Buffer.from(path),
  ]);
};

const encodeBranch = (branch: RadixMerkleMaterializedBranch): Buffer => {
  if (branch.path.length > MAX_PAGE_KEY_BYTES || branch.children.length < 2 || branch.children.length > 256) {
    throw new Error(
      `STORAGE_REBRANCH_BRANCH_SHAPE_INVALID:path=${branch.path.length}:children=${branch.children.length}`,
    );
  }
  const encoded = Buffer.concat([
    Buffer.from([BRANCH_VERSION, branch.path.length]),
    Buffer.from(branch.path),
    u16(branch.children.length),
    ...branch.children.map((child) => {
      if (child.path.length > MAX_PAGE_KEY_BYTES) {
        throw new Error(`STORAGE_REBRANCH_CHILD_PATH_TOO_LONG:${child.path.length}`);
      }
      return Buffer.concat([
        Buffer.from([child.slot, child.kind === 'leaf' ? 0 : 1, child.path.length]),
        Buffer.from(child.path),
        hexBytes(child.hash),
      ]);
    }),
  ]);
  assertPhysicalValueSize(encoded, 'branch');
  return encoded;
};

const decodeBranch = (value: Buffer, expectedPath: readonly number[]): RebranchChild[] => {
  if (value.byteLength < 4 || value[0] !== BRANCH_VERSION) {
    throw new Error(`STORAGE_REBRANCH_BRANCH_HEADER_INVALID:${value.byteLength}`);
  }
  const pathLength = value[1] ?? 0xff;
  const countOffset = 2 + pathLength;
  if (pathLength > MAX_PAGE_KEY_BYTES || countOffset + 2 > value.byteLength) {
    throw new Error(`STORAGE_REBRANCH_BRANCH_PATH_INVALID:${pathLength}`);
  }
  const path = Array.from(value.subarray(2, countOffset));
  if (path.length !== expectedPath.length || path.some((slot, index) => slot !== expectedPath[index])) {
    throw new Error(`STORAGE_REBRANCH_BRANCH_KEY_MISMATCH:${path.join('.')}:${expectedPath.join('.')}`);
  }
  const childCount = value.readUInt16BE(countOffset);
  if (childCount < 2 || childCount > 256) {
    throw new Error(`STORAGE_REBRANCH_BRANCH_CHILD_COUNT_INVALID:${childCount}`);
  }
  const children: RebranchChild[] = [];
  let offset = countOffset + 2;
  for (let index = 0; index < childCount; index += 1) {
    if (offset + 3 > value.byteLength) throw new Error(`STORAGE_REBRANCH_BRANCH_TRUNCATED:${index}`);
    const slot = value[offset]!;
    const kindByte = value[offset + 1]!;
    const childPathLength = value[offset + 2]!;
    offset += 3;
    if (childPathLength > MAX_PAGE_KEY_BYTES || offset + childPathLength + 32 > value.byteLength) {
      throw new Error(`STORAGE_REBRANCH_CHILD_INVALID:${index}`);
    }
    const childPath = Array.from(value.subarray(offset, offset + childPathLength));
    offset += childPathLength;
    const hash = `0x${value.subarray(offset, offset + 32).toString('hex')}`;
    offset += 32;
    if (kindByte !== 0 && kindByte !== 1) throw new Error(`STORAGE_REBRANCH_CHILD_KIND_INVALID:${kindByte}`);
    children.push({ slot, kind: kindByte === 0 ? 'leaf' : 'branch', path: childPath, hash });
  }
  if (offset !== value.byteLength) throw new Error(`STORAGE_REBRANCH_BRANCH_TRAILING_BYTES:${value.byteLength - offset}`);
  return children;
};

const pageIndexFromPath = (path: readonly number[]): number => {
  if (path.length !== MAX_PAGE_KEY_BYTES) {
    throw new Error(`STORAGE_REBRANCH_LEAF_PATH_INVALID:${path.length}`);
  }
  return Buffer.from(path).readUInt32BE(0);
};

type PhysicalPut = { key: Buffer; value: Buffer };

const buildRebranchedPut = (key: Buffer, value: Buffer): { rootValue: Buffer; nodes: PhysicalPut[] } => {
  assertLogicalKey(key);
  const collisionWithManifest = value.subarray(0, MANIFEST_MAGIC.byteLength).equals(MANIFEST_MAGIC);
  if (value.byteLength < MAX_PHYSICAL_VALUE_BYTES && !collisionWithManifest) {
    return { rootValue: value, nodes: [] };
  }
  const pages = Array.from(
    { length: Math.max(1, Math.ceil(value.byteLength / LEAF_PAYLOAD_BYTES)) },
    (_, index) => value.subarray(index * LEAF_PAYLOAD_BYTES, (index + 1) * LEAF_PAYLOAD_BYTES),
  );
  const materialized = buildRadixMerkleMaterialized(
    pages.map((page, index) => ({ key: u32(index), value: hexBytes(computeIntegrityDigest(page)) })),
    { radix: 256 },
  );
  if (materialized.rootKind === 'empty') throw new Error('STORAGE_REBRANCH_EMPTY_ROOT');
  const nodes: PhysicalPut[] = [];
  for (const [index, page] of pages.entries()) {
    assertPhysicalValueSize(page, 'leaf');
    nodes.push({ key: leafNodeKey(key, index), value: page });
  }
  for (const branch of materialized.branches) {
    nodes.push({ key: branchNodeKey(key, branch.path), value: encodeBranch(branch) });
  }
  return {
    rootValue: encodeManifest({
      totalBytes: value.byteLength,
      leafCount: pages.length,
      rootKind: materialized.rootKind,
      rootPath: materialized.rootPath,
      rootHash: materialized.root,
      checksum: computeIntegrityChecksum(value),
    }),
    nodes,
  };
};

const physicalKeysForManifest = (key: Buffer, manifest: RebranchManifest): Buffer[] => {
  const leaves = Array.from({ length: manifest.leafCount }, (_, index) => ({
    key: u32(index),
    value: Buffer.alloc(32),
  }));
  const materialized = buildRadixMerkleMaterialized(leaves, { radix: 256 });
  return [
    ...leaves.map((_, index) => leafNodeKey(key, index)),
    ...materialized.branches.map((branch) => branchNodeKey(key, branch.path)),
  ];
};

const readRawOrNull = async (db: RawDb, key: Buffer): Promise<Buffer | null> => {
  try {
    return await db.get(key);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
};

const readRebranchedValue = async (db: RawDb, key: Buffer): Promise<Buffer> => {
  assertLogicalKey(key);
  const stored = await db.get(key);
  const manifest = decodeManifest(stored);
  if (!manifest) return stored;
  const pages = new Map<number, Buffer>();

  const readLeaf = async (path: readonly number[], expectedHash?: string): Promise<string> => {
    const pageIndex = pageIndexFromPath(path);
    if (pageIndex >= manifest.leafCount || pages.has(pageIndex)) {
      throw new Error(`STORAGE_REBRANCH_LEAF_INDEX_INVALID:${pageIndex}`);
    }
    const page = await db.get(leafNodeKey(key, pageIndex));
    const expectedLength = pageIndex === manifest.leafCount - 1
      ? manifest.totalBytes - pageIndex * LEAF_PAYLOAD_BYTES
      : LEAF_PAYLOAD_BYTES;
    if (page.byteLength !== expectedLength) {
      throw new Error(
        `STORAGE_REBRANCH_LEAF_LENGTH_MISMATCH:index=${pageIndex}:actual=${page.byteLength}:expected=${expectedLength}`,
      );
    }
    const pageHash = computeIntegrityDigest(page);
    const nodeHash = computeRadixMerkleLeafHash(u32(pageIndex), hexBytes(pageHash));
    if (expectedHash && nodeHash !== expectedHash) {
      throw new Error(`STORAGE_REBRANCH_LEAF_HASH_MISMATCH:index=${pageIndex}:actual=${nodeHash}:expected=${expectedHash}`);
    }
    pages.set(pageIndex, page);
    return nodeHash;
  };

  const readBranch = async (
    path: readonly number[],
    parentPath?: readonly number[],
    expectedEdgeHash?: string,
  ): Promise<string> => {
    const encoded = await db.get(branchNodeKey(key, path));
    const children = decodeBranch(encoded, path);
    for (const child of children) {
      if (child.kind === 'leaf') await readLeaf(child.path, child.hash);
      else await readBranch(child.path, path, child.hash);
    }
    const nodeHash = computeRadixMerkleBranchHash(256, children.map((child) => [child.slot, child.hash]));
    if (parentPath && expectedEdgeHash) {
      const edgeHash = computeRadixMerkleEdgeHash(256, [...parentPath], 'branch', [...path], nodeHash);
      if (edgeHash !== expectedEdgeHash) {
        throw new Error(`STORAGE_REBRANCH_EDGE_HASH_MISMATCH:actual=${edgeHash}:expected=${expectedEdgeHash}`);
      }
    }
    return nodeHash;
  };

  const rootNodeHash = manifest.rootKind === 'leaf'
    ? await readLeaf(manifest.rootPath)
    : await readBranch(manifest.rootPath);
  const actualRoot = computeRadixMerkleRootHash(256, manifest.rootKind, manifest.rootPath, rootNodeHash);
  if (actualRoot !== manifest.rootHash) {
    throw new Error(`STORAGE_REBRANCH_ROOT_HASH_MISMATCH:actual=${actualRoot}:expected=${manifest.rootHash}`);
  }
  if (pages.size !== manifest.leafCount) {
    throw new Error(`STORAGE_REBRANCH_LEAF_SET_INCOMPLETE:actual=${pages.size}:expected=${manifest.leafCount}`);
  }
  const value = Buffer.concat(
    Array.from({ length: manifest.leafCount }, (_, index) => {
      const page = pages.get(index);
      if (!page) throw new Error(`STORAGE_REBRANCH_LEAF_MISSING:${index}`);
      return page;
    }),
    manifest.totalBytes,
  );
  const checksum = computeIntegrityChecksum(value);
  if (checksum !== manifest.checksum) {
    throw new Error(`STORAGE_REBRANCH_CHECKSUM_MISMATCH:actual=${checksum}:expected=${manifest.checksum}`);
  }
  return value;
};

const isRebranchNodeKey = (raw: Buffer | Uint8Array | string): boolean => {
  const key = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw));
  return key[0] === NODE_KEY_PREFIX;
};

const logicalKeys = (
  db: RawDb,
  options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean },
): AsyncIterable<Buffer | Uint8Array | string> => ({
  async *[Symbol.asyncIterator]() {
    if (!db.keys) return;
    for await (const key of db.keys(options)) {
      if (!isRebranchNodeKey(key)) yield key;
    }
  },
});

const rebranchedBatch = (db: RawDb): RawBatch => {
  const operations = new Map<string, { key: Buffer; value: Buffer | null }>();
  const wrapper: RawBatch = {
    put(key, value) {
      assertLogicalKey(key);
      operations.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
      return wrapper;
    },
    del(key) {
      assertLogicalKey(key);
      operations.set(key.toString('hex'), { key: Buffer.from(key), value: null });
      return wrapper;
    },
    async write(options) {
      const raw = db.batch();
      for (const operation of operations.values()) {
        const previousRoot = await readRawOrNull(db, operation.key);
        const previousManifest = previousRoot ? decodeManifest(previousRoot) : null;
        const previousNodes = previousManifest
          ? physicalKeysForManifest(operation.key, previousManifest)
          : [];
        const next = operation.value ? buildRebranchedPut(operation.key, operation.value) : null;
        const nextNodes = new Map(next?.nodes.map((node) => [node.key.toString('hex'), node]) ?? []);
        if ((previousRoot || previousNodes.length > 0) && typeof raw.del !== 'function') {
          throw new Error('STORAGE_REBRANCH_DELETE_UNSUPPORTED');
        }
        for (const key of previousNodes) {
          if (!nextNodes.has(key.toString('hex'))) raw.del!(key);
        }
        for (const node of nextNodes.values()) {
          const previous = await readRawOrNull(db, node.key);
          if (!previous?.equals(node.value)) raw.put(node.key, node.value);
        }
        if (!next) {
          if (previousRoot) raw.del!(operation.key);
        } else if (!previousRoot?.equals(next.rootValue)) {
          raw.put(operation.key, next.rootValue);
        }
      }
      await raw.write(options);
    },
  };
  return wrapper;
};

/**
 * Large logical values become mutable path-addressed radix trees. Physical
 * node keys are derived only from the logical key plus their packed tree path;
 * content hashes verify values but never address them.
 */
export const withRebranchedValues = <T extends RawDb>(db: T): T => new Proxy(db, {
  get(target, property, receiver) {
    if (property === 'get') return (key: Buffer) => readRebranchedValue(target, key);
    if (property === 'put') {
      return async (key: Buffer, value: Buffer, options?: { sync?: boolean }): Promise<void> => {
        const batch = rebranchedBatch(target);
        batch.put(key, value);
        await batch.write(options);
      };
    }
    if (property === 'batch') return () => rebranchedBatch(target);
    if (property === 'keys') return (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) => logicalKeys(target, options);
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export const STORAGE_MAX_PHYSICAL_VALUE_BYTES = MAX_PHYSICAL_VALUE_BYTES;
export const STORAGE_REBRANCH_LEAF_PAYLOAD_BYTES = LEAF_PAYLOAD_BYTES;
