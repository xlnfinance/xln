import { ethers } from 'ethers';
import { computeIntegrityDigest } from '../infra/integrity-checksum';
import { compareStableText } from '../protocol/serialization';
import type { Env } from '../types';
import { buildDurableRuntimeMachineSnapshot } from '../wal/snapshot';
import {
  computeCanonicalEntityHash,
  computeCanonicalRuntimeStateHash,
} from './canonical-hash';
import { encodeBuffer } from './codec';
import { encodeBinaryPayload } from './binary-codec';
import {
  docRefCellKey,
  docRefForDoc,
  docValueKey,
  liveKeyForDoc,
  liveKeyForRef,
} from './doc-refs';
import {
  prepareAccountStorageDelete,
  prepareAccountStorageLayout,
} from './account-layout';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_LIVE_ENTITY,
  STORAGE_FRAME_FORMAT,
  decodeEntityId,
  hexBytes,
  keyLiveAccountPrefix,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyMerkleBranch,
  keyMerkleBranchPrefix,
  keyMerkleLeaf,
  keyMerkleLeafPrefix,
  keyMerkleRoot,
  keyMerkleRootPrefix,
  normalizeEntityId,
} from './keys';
import { iterateKeys, readRawOrNull, readValidatedOrNull } from './level';
import {
  validateStorageMerkleBranchDocValue,
  validateStorageMerkleLeafDocValue,
  validateStorageMerkleRootDocValue,
} from './authoritative-schema';
import {
  buildHexKeyedMerkle,
  computeRadixMerkleBranchHash,
  computeRadixMerkleEdgeHash,
  computeRadixMerkleLeafHash,
  computeRadixMerkleRootHash,
  packRadixMerklePath,
  radixMerklePathSlots,
  type RadixMerkleRootKind,
  EMPTY_RADIX_MERKLE_ROOT,
} from './merkle';
import { buildReplicaLookup } from './replicas';
import type {
  RuntimeDbLike,
  StorageDoc,
  StorageDocRef,
  StorageEntityHashDoc,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageMerkleBranchDoc,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
} from './types';

type StorageDocEncodedValue = { buffer: Buffer; hash: string; hashBytes: Buffer };

const ENTITY_MERKLE_NAMESPACE = 'runtime-roots' as const;
/** Strict upper bound for one physical Merkle node value in LevelDB. */
export const MAX_PERSISTED_MERKLE_NODE_BYTES = 10_000;

const hashBuffer = (value: Buffer | Uint8Array): string =>
  computeIntegrityDigest(value instanceof Uint8Array ? value : Uint8Array.from(value));

const hashStable = (value: unknown): string => computeIntegrityDigest(encodeBinaryPayload(value, 'msgpack'));

export type StorageReplicaMetaDigestEntry = {
  key: Uint8Array;
  value: Uint8Array;
};

/**
 * Commits validator-local recovery state without making it Entity consensus
 * state. Keys are sorted explicitly, and values are independently hashed so
 * no key/value concatenation ambiguity can produce the same digest.
 */
export const computeStorageReplicaMetaDigest = (
  entries: readonly StorageReplicaMetaDigestEntry[],
): string => hashStable({
  kind: 'xln.storage.replicaMeta.v1',
  entries: entries
    .map((entry) => ({
      key: ethers.hexlify(entry.key).toLowerCase(),
      valueHash: computeIntegrityDigest(entry.value),
    }))
    .sort((left, right) => {
      const byKey = compareStableText(left.key, right.key);
      return byKey !== 0 ? byKey : compareStableText(left.valueHash, right.valueHash);
    }),
});

const hashToBytes = (hash: string): Buffer => hexBytes(hash);

const merkleCellPathBytes = (path: string): Buffer => {
  const raw = String(path);
  if (!/^0x[0-9a-fA-F]{66}$/.test(raw)) {
    throw new Error(`STORAGE_MERKLE_CELL_PATH_INVALID:${raw}`);
  }
  return Buffer.from(raw.slice(2), 'hex');
};

const encodeStorageDocValue = (doc: StorageDoc): StorageDocEncodedValue => {
  const buffer = encodeBuffer(doc.value);
  const hash = hashBuffer(buffer);
  const hashBytes = Buffer.from(hash.slice(2), 'hex');
  return { buffer, hash, hashBytes };
};

const encodeMerkleUint64 = (value: string, label: string): Buffer => {
  if (!/^\d+$/.test(value)) throw new Error(`STORAGE_INVALID_MERKLE_PATH_${label}: ${value}`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`STORAGE_INVALID_MERKLE_PATH_${label}: ${value}`);
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(parsed);
  return out;
};

const bookPairMerklePayload = (pairId: string): Buffer => {
  const normalized = String(pairId || '').trim();
  const [baseTokenId, quoteTokenId, extra] = normalized.split('/');
  const numericPair =
    baseTokenId !== undefined &&
    quoteTokenId !== undefined &&
    extra === undefined &&
    /^\d+$/.test(baseTokenId) &&
    /^\d+$/.test(quoteTokenId);
  if (numericPair) {
    return Buffer.concat([
      encodeMerkleUint64(baseTokenId, 'BOOK_BASE'),
      encodeMerkleUint64(quoteTokenId, 'BOOK_QUOTE'),
      Buffer.alloc(16),
    ]);
  }
  if (!normalized) {
    throw new Error(`STORAGE_INVALID_BOOK_MERKLE_PATH: ${pairId}`);
  }
  return hashToBytes(computeIntegrityDigest(ethers.toUtf8Bytes(`xln:book-pair:${normalized}`)));
};

const storageMerklePath = (key: string): string => {
  const normalized = String(key || '');
  if (normalized === 'entity') {
    return `0x${Buffer.concat([Buffer.from([0x01]), Buffer.alloc(32)]).toString('hex')}`;
  }

  if (normalized.startsWith('accounts/')) {
    const counterpartyId = normalized.slice('accounts/'.length);
    return `0x${Buffer.concat([Buffer.from([0x02]), hexBytes(counterpartyId)]).toString('hex')}`;
  }

  if (normalized.startsWith('books/')) {
    const pairId = normalized.slice('books/'.length);
    return `0x${Buffer.concat([Buffer.from([0x03]), bookPairMerklePayload(pairId)]).toString('hex')}`;
  }

  throw new Error(`STORAGE_UNKNOWN_MERKLE_PATH: ${normalized}`);
};

export const storageMerkleCellHexKey = (cellKey: string): string =>
  `0x${merkleCellPathBytes(storageMerklePath(cellKey)).toString('hex')}`;

export const computeStorageStateRoot = (entityHashes: StorageFrameEntityHash[]): string => {
  return buildHexKeyedMerkle(
    entityHashes
      .map((entry) => ({
        hexKey: normalizeEntityId(entry.entityId),
        value: hashToBytes(entry.hash),
      })),
    { radix: DEFAULT_ACCOUNT_MERKLE_RADIX },
  ).root;
};

/**
 * Rebuild the storage commitment from an isolated set of projected documents.
 * Snapshot verification must hash the bytes it read back from the snapshot
 * namespace; reusing the live Merkle cache would only prove that the source
 * cache was internally consistent, not that the copied checkpoint is usable.
 */
export const computeStorageEntityHashesFromDocs = (
  docs: readonly StorageDoc[],
): StorageFrameEntityHash[] => {
  const cellsByEntity = new Map<string, Array<{ hexKey: string; value: Buffer }>>();
  for (const doc of docs) {
    const ref = docRefForDoc(doc);
    const entityId = normalizeEntityId(ref.entityId);
    const cells = cellsByEntity.get(entityId) ?? [];
    cells.push({
      hexKey: storageMerkleCellHexKey(docRefCellKey(ref)),
      value: hashToBytes(encodeStorageDocValue(doc).hash),
    });
    cellsByEntity.set(entityId, cells);
  }
  return Array.from(cellsByEntity.entries(), ([entityId, cells]) => ({
    entityId,
    hash: buildHexKeyedMerkle(cells, { radix: DEFAULT_ACCOUNT_MERKLE_RADIX }).root,
    cellCount: cells.length,
  })).sort((left, right) => compareStableText(left.entityId, right.entityId));
};

export const normalizeFrameEntityHashes = (entityHashes: StorageFrameEntityHash[] | undefined): StorageFrameEntityHash[] =>
  (entityHashes ?? [])
    .map((entry) => ({
      entityId: normalizeEntityId(entry.entityId),
      hash: String(entry.hash || ''),
      cellCount: Number(entry.cellCount ?? 0),
    }))
    .sort((left, right) => compareStableText(left.entityId, right.entityId));

export const assertEntityHashesEqual = (
  actual: StorageFrameEntityHash[] | undefined,
  expected: StorageFrameEntityHash[] | undefined,
  context: string,
): void => {
  const left = normalizeFrameEntityHashes(actual);
  const right = normalizeFrameEntityHashes(expected);
  if (left.length !== right.length) {
    throw new Error(`STORAGE_ENTITY_HASH_COUNT_MISMATCH: ${context} actual=${left.length} expected=${right.length}`);
  }
  for (let index = 0; index < left.length; index += 1) {
    const actualEntry = left[index]!;
    const expectedEntry = right[index]!;
    if (
      actualEntry.entityId !== expectedEntry.entityId ||
      actualEntry.hash !== expectedEntry.hash ||
      actualEntry.cellCount !== expectedEntry.cellCount
    ) {
      throw new Error(
        `STORAGE_ENTITY_HASH_MISMATCH: ${context} entity=${expectedEntry.entityId} ` +
          `actual=${actualEntry.hash}/${actualEntry.cellCount} expected=${expectedEntry.hash}/${expectedEntry.cellCount}`,
      );
    }
  }
};

export const prepareStorageCanonicalStateHashes = (
  env: Env,
  touchedEntities: string[],
  previousFrame: StorageFrameRecord | null,
  replicaLookup = buildReplicaLookup(env),
  runtimeMachine = buildDurableRuntimeMachineSnapshot(env),
): { canonicalStateHash: string; canonicalEntityHashes: StorageFrameEntityHash[] } => {
  void touchedEntities;
  void previousFrame;
  const canonicalEntityHashes = Array.from(
    replicaLookup.values(),
    ({ replica }) => computeCanonicalEntityHash(replica),
  )
    .sort((left, right) => compareStableText(left.entityId, right.entityId));
  return {
    canonicalEntityHashes,
    canonicalStateHash: computeCanonicalRuntimeStateHash(
      env.height,
      env.timestamp,
      canonicalEntityHashes,
      runtimeMachine,
    ),
  };
};

export const computeStorageFrameHash = (record: StorageFrameRecord): string => {
  // Local WAL integrity intentionally covers the complete persisted record,
  // including runtimeOutputs/transport state. Cross-replay state identity is
  // canonicalStateHash, which commits to replayable Entity state instead.
  const stableRecord = { ...record };
  delete stableRecord.frameHash;
  return hashStable({
    kind: STORAGE_FRAME_FORMAT.domain,
    ...stableRecord,
    entityHashes: (stableRecord.entityHashes ?? [])
      .map((entry) => ({
        entityId: normalizeEntityId(entry.entityId),
        hash: entry.hash,
        cellCount: entry.cellCount,
      }))
      .sort((left, right) => compareStableText(left.entityId, right.entityId)),
  });
};

/**
 * Per-frame replay oracle. Entity heads commit validator-recomputed consensus
 * state roots, while the durable Runtime machine covers state outside Entity
 * consensus. Hashing only the input or copying the persisted stateHash into
 * "actual" would let a changed reducer replay a valid WAL into different
 * financial state without identifying the first divergent frame.
 */
export const computeStoragePostStateHash = (input: {
  height: number;
  timestamp: number;
  replicaMetaDigest: string;
  runtimeMachine: Record<string, unknown>;
}): string => hashStable({
  kind: STORAGE_FRAME_FORMAT.postStateDomain,
  height: input.height,
  timestamp: input.timestamp,
  replicaMetaDigest: input.replicaMetaDigest,
  runtimeMachine: input.runtimeMachine,
});

type PersistedMerkleLeafNode = {
  kind: 'leaf';
  path: number[];
  key: string;
  valueHash: string;
  /** Absent exactly while this node must be rehashed and persisted. */
  hash?: string;
};

type PersistedMerkleChildRef = {
  slot: number;
  kind: 'branch' | 'leaf';
  path: number[];
  /** Absent when the referenced child edge changed. */
  hash?: string;
  node?: PersistedMerkleNode;
};

type PersistedMerkleBranchNode = {
  kind: 'branch';
  path: number[];
  children: Map<number, PersistedMerkleChildRef>;
  /** Absent exactly while this node must be rehashed and persisted. */
  hash?: string;
};

type PersistedMerkleNode = PersistedMerkleLeafNode | PersistedMerkleBranchNode;

const commonMerklePathPrefixLength = (left: number[], right: number[]): number => {
  const max = Math.min(left.length, right.length);
  let length = 0;
  while (length < max && left[length] === right[length]) length += 1;
  return length;
};

const merklePathHasPrefix = (path: number[], prefix: number[]): boolean => {
  if (prefix.length > path.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (path[index] !== prefix[index]) return false;
  }
  return true;
};

const nodeSlotUnder = (parentPath: number[], childPath: number[]): number =>
  childPath[parentPath.length] ?? 0;

const merklePathKey = (path: number[]): string => JSON.stringify(path);

const parseMerklePathKey = (key: string): number[] => JSON.parse(key) as number[];

const cloneMerklePathSet = (paths: Set<string>): number[][] =>
  Array.from(paths)
    .sort(compareStableText)
    .map(parseMerklePathKey);

class PersistedEntityMerkleEditor {
  private rootNodeLoaded = false;
  private rootNode: PersistedMerkleNode | null = null;
  private leafCountValue: number;
  private readonly initialBranchPaths = new Set<string>();
  private readonly initialLeafPaths = new Set<string>();

  constructor(
    private readonly db: RuntimeDbLike,
    private readonly entityId: string,
    private readonly rootDoc: StorageMerkleRootDoc,
  ) {
    this.leafCountValue = rootDoc.leafCount;
  }

  static async open(db: RuntimeDbLike, entityId: string): Promise<PersistedEntityMerkleEditor | null> {
    const normalized = normalizeEntityId(entityId);
    const rootDoc = await readValidatedOrNull(
      db,
      keyMerkleRoot(normalized, ENTITY_MERKLE_NAMESPACE),
      validateStorageMerkleRootDocValue,
    );
    if (!rootDoc) return null;
    if (rootDoc.rootKind === 'empty' || rootDoc.leafCount === 0) {
      return new PersistedEntityMerkleEditor(db, normalized, rootDoc);
    }
    if ((rootDoc.rootKind === 'branch' || rootDoc.rootKind === 'leaf') && Array.isArray(rootDoc.rootPath)) {
      return new PersistedEntityMerkleEditor(db, normalized, rootDoc);
    }
    throw new Error(`STORAGE_MERKLE_ROOT_INVALID: entity=${normalized}`);
  }

  static empty(db: RuntimeDbLike, entityId: string): PersistedEntityMerkleEditor {
    const normalized = normalizeEntityId(entityId);
    return new PersistedEntityMerkleEditor(db, normalized, {
      entityId: normalized,
      namespace: ENTITY_MERKLE_NAMESPACE,
      radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
      rootHash: EMPTY_RADIX_MERKLE_ROOT,
      rootKind: 'empty',
      rootPath: [],
      leafCount: 0,
    });
  }

  get leafCount(): number {
    return this.leafCountValue;
  }

  async put(cellKey: string, valueHash: string): Promise<boolean> {
    const leaf = this.makeLeaf(cellKey, valueHash);
    const result = await this.insertNode(await this.loadRootNode(), leaf);
    if (!result.changed) return false;
    this.rootNode = result.node;
    this.rootNodeLoaded = true;
    if (!result.existed) this.leafCountValue += 1;
    return true;
  }

  async del(cellKey: string): Promise<boolean> {
    const path = this.pathForCellKey(cellKey);
    const result = await this.deleteNode(await this.loadRootNode(), path);
    if (!result.deleted) return false;
    this.rootNode = result.node;
    this.rootNodeLoaded = true;
    this.leafCountValue = Math.max(0, this.leafCountValue - 1);
    return true;
  }

  async flush(): Promise<{
    rootDoc: StorageMerkleRootDoc;
    branchPuts: StorageMerkleBranchDoc[];
    leafPuts: StorageMerkleLeafDoc[];
    branchDels: number[][];
    leafDels: number[][];
  }> {
    const root = await this.loadRootNode();
    const rootKind: RadixMerkleRootKind = root?.kind ?? 'empty';
    const rootPath = root ? [...root.path] : [];
    const branchPuts: StorageMerkleBranchDoc[] = [];
    const leafPuts: StorageMerkleLeafDoc[] = [];
    this.collectChanged(root, branchPuts, leafPuts);
    const rootHash = root
      ? computeRadixMerkleRootHash(DEFAULT_ACCOUNT_MERKLE_RADIX, root.kind, root.path, this.nodeHash(root))
      : EMPTY_RADIX_MERKLE_ROOT;
    const finalBranchPaths = new Set<string>();
    const finalLeafPaths = new Set<string>();
    this.collectLoadedFinalPaths(root, finalBranchPaths, finalLeafPaths);
    const branchDels = new Set([...this.initialBranchPaths].filter((path) => !finalBranchPaths.has(path)));
    const leafDels = new Set([...this.initialLeafPaths].filter((path) => !finalLeafPaths.has(path)));
    return {
      rootDoc: {
        entityId: this.entityId,
        namespace: ENTITY_MERKLE_NAMESPACE,
        radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
        rootHash,
        rootKind,
        rootPath,
        leafCount: this.leafCountValue,
      },
      branchPuts,
      leafPuts,
      branchDels: cloneMerklePathSet(branchDels),
      leafDels: cloneMerklePathSet(leafDels),
    };
  }

  private pathForCellKey(cellKey: string): number[] {
    return radixMerklePathSlots(merkleCellPathBytes(storageMerklePath(cellKey)), DEFAULT_ACCOUNT_MERKLE_RADIX);
  }

  private makeLeaf(cellKey: string, valueHash: string): PersistedMerkleLeafNode {
    const keyBytes = merkleCellPathBytes(storageMerklePath(cellKey));
    const path = radixMerklePathSlots(keyBytes, DEFAULT_ACCOUNT_MERKLE_RADIX);
    return {
      kind: 'leaf',
      path,
      key: `0x${Buffer.from(keyBytes).toString('hex')}`,
      valueHash,
    };
  }

  private async loadRootNode(): Promise<PersistedMerkleNode | null> {
    if (this.rootNodeLoaded) return this.rootNode;
    this.rootNodeLoaded = true;
    const rootKind = this.rootDoc.rootKind;
    const rootPath = this.rootDoc.rootPath ?? [];
    if (rootKind === 'empty' || this.leafCountValue === 0) {
      this.rootNode = null;
      return null;
    }
    if (rootKind === 'leaf') {
      this.rootNode = await this.loadLeaf(rootPath);
      return this.rootNode;
    }
    if (rootKind === 'branch') {
      this.rootNode = await this.loadBranch(rootPath);
      return this.rootNode;
    }
    throw new Error(`STORAGE_MERKLE_ROOT_UNSUPPORTED: entity=${this.entityId}`);
  }

  private async loadLeaf(path: number[]): Promise<PersistedMerkleLeafNode> {
    const doc = await readValidatedOrNull(
      this.db,
      keyMerkleLeaf(this.entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, path)),
      validateStorageMerkleLeafDocValue,
    );
    if (!doc) throw new Error(`STORAGE_MERKLE_LEAF_MISSING: entity=${this.entityId} path=${path.join('.')}`);
    this.initialLeafPaths.add(merklePathKey(doc.path));
    return {
      kind: 'leaf',
      path: [...doc.path],
      key: doc.key,
      valueHash: doc.valueHash,
      hash: doc.hash,
    };
  }

  private async loadBranch(path: number[]): Promise<PersistedMerkleBranchNode> {
    const doc = await readValidatedOrNull(
      this.db,
      keyMerkleBranch(this.entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, path)),
      validateStorageMerkleBranchDocValue,
    );
    if (!doc) throw new Error(`STORAGE_MERKLE_BRANCH_MISSING: entity=${this.entityId} path=${path.join('.')}`);
    this.initialBranchPaths.add(merklePathKey(doc.path));
    return {
      kind: 'branch',
      path: [...doc.path],
      hash: doc.hash,
      children: new Map(doc.children.map((child) => [
        child.slot,
        {
          slot: child.slot,
          kind: child.kind,
          path: [...child.path],
          hash: child.hash,
        } satisfies PersistedMerkleChildRef,
      ])),
    };
  }

  private async loadChild(ref: PersistedMerkleChildRef): Promise<PersistedMerkleNode> {
    if (ref.node) return ref.node;
    ref.node = ref.kind === 'leaf'
      ? await this.loadLeaf(ref.path)
      : await this.loadBranch(ref.path);
    return ref.node;
  }

  private childRefFromNode(parentPath: number[], node: PersistedMerkleNode): PersistedMerkleChildRef {
    return {
      slot: nodeSlotUnder(parentPath, node.path),
      kind: node.kind,
      path: [...node.path],
      node,
    };
  }

  private nodeHash(node: PersistedMerkleNode): string {
    if (node.kind === 'leaf') {
      if (node.hash) return node.hash;
      node.hash = computeRadixMerkleLeafHash(
        Buffer.from(node.key.replace(/^0x/, ''), 'hex'),
        Buffer.from(node.valueHash.replace(/^0x/, ''), 'hex'),
      );
      return node.hash;
    }
    if (node.hash) return node.hash;
    node.hash = computeRadixMerkleBranchHash(
      DEFAULT_ACCOUNT_MERKLE_RADIX,
      Array.from(node.children.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([slot, child]) => [slot, this.childEdgeHash(node.path, child)]),
    );
    return node.hash;
  }

  private childEdgeHash(parentPath: number[], child: PersistedMerkleChildRef): string {
    if (!child.node) {
      if (!child.hash) throw new Error(`STORAGE_MERKLE_CHILD_HASH_MISSING: entity=${this.entityId}`);
      return child.hash;
    }
    if (child.hash && child.node.hash) return child.hash;
    child.kind = child.node.kind;
    child.path = [...child.node.path];
    child.hash = computeRadixMerkleEdgeHash(
      DEFAULT_ACCOUNT_MERKLE_RADIX,
      parentPath,
      child.node.kind,
      child.node.path,
      this.nodeHash(child.node),
    );
    return child.hash;
  }

  private markBranchDirty(node: PersistedMerkleBranchNode): void {
    delete node.hash;
  }

  private makeBranch(path: number[], children: PersistedMerkleNode[]): PersistedMerkleBranchNode {
    const branch: PersistedMerkleBranchNode = {
      kind: 'branch',
      path,
      children: new Map(),
    };
    for (const child of children) {
      const ref = this.childRefFromNode(path, child);
      branch.children.set(ref.slot, ref);
    }
    return branch;
  }

  private async insertNode(
    node: PersistedMerkleNode | null,
    leaf: PersistedMerkleLeafNode,
  ): Promise<{ node: PersistedMerkleNode; existed: boolean; changed: boolean }> {
    if (!node) return { node: leaf, existed: false, changed: true };
    if (node.kind === 'leaf') {
      const shared = commonMerklePathPrefixLength(node.path, leaf.path);
      if (shared === node.path.length && shared === leaf.path.length) {
        if (node.key === leaf.key && node.valueHash === leaf.valueHash) {
          return { node, existed: true, changed: false };
        }
        node.key = leaf.key;
        node.valueHash = leaf.valueHash;
        delete node.hash;
        return { node, existed: true, changed: true };
      }
      return {
        node: this.makeBranch(node.path.slice(0, shared), [node, leaf]),
        existed: false,
        changed: true,
      };
    }

    const shared = commonMerklePathPrefixLength(node.path, leaf.path);
    if (shared < node.path.length) {
      return {
        node: this.makeBranch(node.path.slice(0, shared), [node, leaf]),
        existed: false,
        changed: true,
      };
    }

    const slot = nodeSlotUnder(node.path, leaf.path);
    const childRef = node.children.get(slot);
    if (!childRef) {
      node.children.set(slot, this.childRefFromNode(node.path, leaf));
      this.markBranchDirty(node);
      return { node, existed: false, changed: true };
    }

    const child = await this.loadChild(childRef);
    const result = await this.insertNode(child, leaf);
    if (!result.changed) return { node, existed: result.existed, changed: false };
    node.children.set(slot, this.childRefFromNode(node.path, result.node));
    this.markBranchDirty(node);
    return { node, existed: result.existed, changed: true };
  }

  private async deleteNode(
    node: PersistedMerkleNode | null,
    path: number[],
  ): Promise<{ node: PersistedMerkleNode | null; deleted: boolean }> {
    if (!node) return { node: null, deleted: false };
    if (node.kind === 'leaf') {
      const matches = commonMerklePathPrefixLength(node.path, path) === path.length && node.path.length === path.length;
      if (!matches) return { node, deleted: false };
      return { node: null, deleted: true };
    }
    if (!merklePathHasPrefix(path, node.path)) return { node, deleted: false };
    const slot = nodeSlotUnder(node.path, path);
    const childRef = node.children.get(slot);
    if (!childRef) return { node, deleted: false };
    const child = await this.loadChild(childRef);
    const result = await this.deleteNode(child, path);
    if (!result.deleted) return { node, deleted: false };
    if (result.node) node.children.set(slot, this.childRefFromNode(node.path, result.node));
    else node.children.delete(slot);
    this.markBranchDirty(node);
    if (node.children.size === 0) {
      return { node: null, deleted: true };
    }
    if (node.children.size === 1) {
      const only = Array.from(node.children.values())[0]!;
      return { node: await this.loadChild(only), deleted: true };
    }
    return { node, deleted: true };
  }

  private collectChanged(
    node: PersistedMerkleNode | null,
    branchPuts: StorageMerkleBranchDoc[],
    leafPuts: StorageMerkleLeafDoc[],
  ): void {
    if (!node) return;
    if (node.kind === 'leaf') {
      if (!node.hash) {
        leafPuts.push({
          entityId: this.entityId,
          namespace: ENTITY_MERKLE_NAMESPACE,
          radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
          path: [...node.path],
          key: node.key,
          valueHash: node.valueHash,
          hash: this.nodeHash(node),
        });
      }
      return;
    }

    const changed = !node.hash;
    for (const child of node.children.values()) {
      if (child.node) this.collectChanged(child.node, branchPuts, leafPuts);
    }
    if (changed) {
      branchPuts.push({
        entityId: this.entityId,
        namespace: ENTITY_MERKLE_NAMESPACE,
        radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
        path: [...node.path],
        hash: this.nodeHash(node),
        children: Array.from(node.children.entries())
          .sort((left, right) => left[0] - right[0])
          .map(([slot, child]) => ({
            slot,
            kind: child.node?.kind ?? child.kind,
            path: [...(child.node?.path ?? child.path)],
            hash: this.childEdgeHash(node.path, child),
          })),
      });
    }
  }

  private collectLoadedFinalPaths(
    node: PersistedMerkleNode | null,
    branchPaths: Set<string>,
    leafPaths: Set<string>,
  ): void {
    if (!node) return;
    if (node.kind === 'leaf') {
      leafPaths.add(merklePathKey(node.path));
      return;
    }
    branchPaths.add(merklePathKey(node.path));
    // Every mutation goes through loadChild(), so an unloaded subtree is unchanged
    // on disk and must stay out of both initial and final diff sets.
    for (const child of node.children.values()) {
      if (child.node) this.collectLoadedFinalPaths(child.node, branchPaths, leafPaths);
    }
  }
}

const hasAnyKey = async (db: RuntimeDbLike, prefix: Buffer): Promise<boolean> => {
  for await (const _key of iterateKeys(db, { prefix })) return true;
  return false;
};

const hasPersistedLiveDocs = async (db: RuntimeDbLike, entityId: string): Promise<boolean> => {
  const normalized = normalizeEntityId(entityId);
  if (await readRawOrNull(db, keyLiveEntity(normalized))) return true;
  if (await hasAnyKey(db, keyLiveAccountPrefix(normalized))) return true;
  return hasAnyKey(db, keyLiveBookPrefix(normalized));
};

const assertNoMerkleSideRowsWithoutRoot = async (db: RuntimeDbLike, entityId: string): Promise<void> => {
  const normalized = normalizeEntityId(entityId);
  const hasSideRows =
    await hasAnyKey(db, keyMerkleBranchPrefix(normalized, ENTITY_MERKLE_NAMESPACE)) ||
    await hasAnyKey(db, keyMerkleLeafPrefix(normalized, ENTITY_MERKLE_NAMESPACE));
  if (hasSideRows) throw new Error(`STORAGE_MERKLE_ORPHANED_SIDE_RECORDS: entity=${normalized}`);
};

type EntityMerkleFlush = {
  rootDoc: StorageMerkleRootDoc;
  branchPuts: StorageMerkleBranchDoc[];
  leafPuts: StorageMerkleLeafDoc[];
  branchDels: number[][];
  leafDels: number[][];
};

type StorageMerkleNodeDoc = StorageMerkleRootDoc | StorageMerkleBranchDoc | StorageMerkleLeafDoc;

const encodeMerkleNode = (doc: StorageMerkleNodeDoc): Buffer => {
  const validated = 'rootHash' in doc
    ? validateStorageMerkleRootDocValue(doc)
    : 'children' in doc
      ? validateStorageMerkleBranchDocValue(doc)
      : validateStorageMerkleLeafDocValue(doc);
  const encoded = encodeBuffer(validated);
  if (encoded.byteLength >= MAX_PERSISTED_MERKLE_NODE_BYTES) {
    throw new Error(`STORAGE_MERKLE_NODE_TOO_LARGE:bytes=${encoded.byteLength}`);
  }
  return encoded;
};

const appendEntityMerkleFlush = (
  entityId: string,
  flushed: EntityMerkleFlush,
  merklePuts: Array<{ key: Buffer; value: Buffer }>,
  merkleDelsByKey: Map<string, Buffer>,
): void => {
  merklePuts.push({ key: keyMerkleRoot(entityId, ENTITY_MERKLE_NAMESPACE), value: encodeMerkleNode(flushed.rootDoc) });
  for (const branchDoc of flushed.branchPuts) {
    merklePuts.push({
      key: keyMerkleBranch(entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(branchDoc.radix, branchDoc.path)),
      value: encodeMerkleNode(branchDoc),
    });
  }
  for (const leafDoc of flushed.leafPuts) {
    merklePuts.push({
      key: keyMerkleLeaf(entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(leafDoc.radix, leafDoc.path)),
      value: encodeMerkleNode(leafDoc),
    });
  }
  for (const path of flushed.branchDels) {
    const key = keyMerkleBranch(entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, path));
    merkleDelsByKey.set(key.toString('hex'), key);
  }
  for (const path of flushed.leafDels) {
    const key = keyMerkleLeaf(entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, path));
    merkleDelsByKey.set(key.toString('hex'), key);
  }
};

export const readAllEntityHashDocs = async (db: RuntimeDbLike): Promise<Map<string, StorageEntityHashDoc>> => {
  const docs = new Map<string, StorageEntityHashDoc>();
  for await (const key of iterateKeys(db, { prefix: keyMerkleRootPrefix() })) {
    const rootDoc = await readValidatedOrNull(db, key, validateStorageMerkleRootDocValue);
    if (!rootDoc || rootDoc.namespace !== ENTITY_MERKLE_NAMESPACE) continue;
    if (!key.equals(keyMerkleRoot(rootDoc.entityId, rootDoc.namespace))) {
      throw new Error(`STORAGE_MERKLE_ROOT_KEY_MISMATCH:${key.toString('hex')}`);
    }
    const entityId = normalizeEntityId(rootDoc.entityId);
    docs.set(normalizeEntityId(entityId), {
      entityId: normalizeEntityId(entityId),
      hash: rootDoc.rootHash,
      cellCount: rootDoc.leafCount,
    });
  }

  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    if (key.length !== 33) throw new Error(`STORAGE_LIVE_ENTITY_KEY_INVALID:${key.toString('hex')}`);
    const entityId = decodeEntityId(key.subarray(1));
    const normalized = normalizeEntityId(entityId);
    if (!docs.has(normalized)) {
      await assertNoMerkleSideRowsWithoutRoot(db, normalized);
      throw new Error(`STORAGE_MERKLE_ROOT_MISSING: entity=${normalized}`);
    }
  }
  return docs;
};

export const toFrameEntityHashes = (docs: Iterable<StorageEntityHashDoc>): StorageFrameEntityHash[] =>
  Array.from(docs)
    .map((doc) => ({ entityId: normalizeEntityId(doc.entityId), hash: doc.hash, cellCount: Number(doc.cellCount) }))
    .sort((left, right) => compareStableText(left.entityId, right.entityId));

export const prepareStorageStateHashes = async (options: {
  db: RuntimeDbLike;
  puts: StorageDoc[];
  dels: StorageDocRef[];
  entityHashDocs?: Map<string, StorageEntityHashDoc>;
}): Promise<{
  stateHash: string;
  entityHashes: StorageFrameEntityHash[];
  entityHashDocs: Map<string, StorageEntityHashDoc>;
  docValueBuffers: Map<string, Buffer>;
  docPuts: Array<{ key: Buffer; value: Buffer }>;
  docDels: Buffer[];
  merklePuts: Array<{ key: Buffer; value: Buffer }>;
  merkleDels: Buffer[];
}> => {
  const effectivePuts = new Map<string, StorageDoc>();
  for (const doc of options.puts) effectivePuts.set(liveKeyForDoc(doc).toString('hex'), doc);
  const effectiveDels = new Map<string, StorageDocRef>();
  for (const ref of options.dels) {
    const keyHex = liveKeyForRef(ref).toString('hex');
    effectivePuts.delete(keyHex);
    effectiveDels.set(keyHex, ref);
  }
  const entityHashDocs = options.entityHashDocs
    ? new Map(options.entityHashDocs)
    : await readAllEntityHashDocs(options.db);
  const docValueBuffers = new Map<string, Buffer>();
  const docPuts: Array<{ key: Buffer; value: Buffer }> = [];
  const docDels: Buffer[] = [];
  const touchedEntityIds = new Set<string>();
  const persistedEditors = new Map<string, PersistedEntityMerkleEditor>();

  const openEntityEditor = async (entityId: string): Promise<PersistedEntityMerkleEditor> => {
    const normalized = normalizeEntityId(entityId);
    const existing = persistedEditors.get(normalized);
    if (existing) return existing;
    let editor = await PersistedEntityMerkleEditor.open(options.db, normalized);
    if (!editor) {
      await assertNoMerkleSideRowsWithoutRoot(options.db, normalized);
      if (await hasPersistedLiveDocs(options.db, normalized)) {
        throw new Error(`STORAGE_MERKLE_ROOT_MISSING: entity=${normalized}`);
      }
      editor = PersistedEntityMerkleEditor.empty(options.db, normalized);
    }
    persistedEditors.set(normalized, editor);
    return editor;
  };

  const updateEntityCell = async (entityId: string, key: string, hash: string | null): Promise<void> => {
    const normalized = normalizeEntityId(entityId);
    const editor = await openEntityEditor(normalized);
    const changed = hash ? await editor.put(key, hash) : await editor.del(key);
    if (!changed) return;
    touchedEntityIds.add(normalized);
    entityHashDocs.set(normalized, entityHashDocs.get(normalized) ?? {
      entityId: normalized,
      hash: EMPTY_RADIX_MERKLE_ROOT,
      cellCount: editor.leafCount,
    });
  };

  for (const doc of effectivePuts.values()) {
    const ref = docRefForDoc(doc);
    const encoded = encodeStorageDocValue(doc);
    docValueBuffers.set(docValueKey(doc), encoded.buffer);
    if (doc.family === 'account') {
      const layout = await prepareAccountStorageLayout(
        options.db,
        normalizeEntityId(doc.entityId),
        normalizeEntityId(doc.counterpartyId),
        liveKeyForDoc(doc),
        doc.value,
      );
      if (!layout.logicalValue.equals(encoded.buffer) || layout.logicalHash !== encoded.hash) {
        throw new Error(`STORAGE_ACCOUNT_LAYOUT_LOGICAL_MISMATCH:${doc.entityId}:${doc.counterpartyId}`);
      }
      docPuts.push(...layout.puts);
      docDels.push(...layout.dels);
    } else {
      docPuts.push({ key: liveKeyForDoc(doc), value: encoded.buffer });
    }
    await updateEntityCell(ref.entityId, docRefCellKey(ref), encoded.hash);
  }

  for (const ref of effectiveDels.values()) {
    if (ref.family === 'account') {
      docDels.push(...await prepareAccountStorageDelete(
        options.db,
        normalizeEntityId(ref.entityId),
        normalizeEntityId(ref.counterpartyId),
        liveKeyForRef(ref),
      ));
    } else {
      docDels.push(liveKeyForRef(ref));
    }
    await updateEntityCell(ref.entityId, docRefCellKey(ref), null);
  }

  const merklePuts: Array<{ key: Buffer; value: Buffer }> = [];
  const merkleDelsByKey = new Map<string, Buffer>();
  for (const entityId of touchedEntityIds) {
    const editor = persistedEditors.get(entityId);
    if (!editor) throw new Error(`STORAGE_MERKLE_EDITOR_MISSING: entity=${entityId}`);
    const flushed = await editor.flush();
    const doc = (entityHashDocs.get(entityId) ?? {
      entityId,
      hash: flushed.rootDoc.rootHash,
      cellCount: flushed.rootDoc.leafCount,
    }) as StorageEntityHashDoc;
    doc.hash = flushed.rootDoc.rootHash;
    doc.cellCount = flushed.rootDoc.leafCount;
    entityHashDocs.set(entityId, doc);
    appendEntityMerkleFlush(entityId, flushed, merklePuts, merkleDelsByKey);
  }
  const entityHashes = toFrameEntityHashes(entityHashDocs.values());
  return {
    stateHash: computeStorageStateRoot(entityHashes),
    entityHashes,
    entityHashDocs,
    docValueBuffers,
    docPuts,
    docDels,
    merklePuts,
    merkleDels: Array.from(merkleDelsByKey.values()),
  };
};
