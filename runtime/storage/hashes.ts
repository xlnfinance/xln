import { ethers } from 'ethers';
import { compareStableText, serializeTaggedJson } from '../serialization-utils';
import type { Env } from '../types';
import {
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalRuntimeStateHash,
} from './canonical-hash';
import { encodeBuffer } from './codec';
import {
  docRefCellKey,
  docRefForDoc,
  docValueKey,
} from './doc-refs';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_LIVE_ENTITY,
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
import { iterateKeys, readJsonOrNull, readRawOrNull } from './level';
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

const hashBuffer = (value: Buffer | Uint8Array): string =>
  ethers.keccak256(value instanceof Uint8Array ? value : Uint8Array.from(value));

const hashStable = (value: unknown): string => ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(value)));

const hashToBytes = (hash: string): Buffer =>
  Buffer.from(String(hash || '').replace(/^0x/, '').padStart(64, '0'), 'hex');

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
  return hashToBytes(ethers.keccak256(ethers.toUtf8Bytes(`xln:book-pair:${normalized}`)));
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
  `0x${hashToBytes(storageMerklePath(cellKey)).toString('hex')}`;

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
): { canonicalStateHash: string; canonicalEntityHashes: StorageFrameEntityHash[] } => {
  void touchedEntities;
  void previousFrame;
  void replicaLookup;
  const canonicalEntityHashes = computeCanonicalEntityHashesFromEnv(env)
    .sort((left, right) => compareStableText(left.entityId, right.entityId));
  return {
    canonicalEntityHashes,
    canonicalStateHash: computeCanonicalRuntimeStateHash(env.height, env.timestamp, canonicalEntityHashes),
  };
};

export const storageCanonicalHashEnabled = (): boolean => {
  if (typeof process === 'undefined') return false;
  if (String(process.env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production') return true;
  const raw = String(process.env['XLN_STORAGE_VERIFY_CANONICAL'] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

export const computeStorageFrameHash = (record: StorageFrameRecord): string => {
  const stableRecord = { ...record };
  delete stableRecord.frameHash;
  return hashStable({
    kind: 'xln.storage.frame.v1',
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

type PersistedMerkleLeafNode = {
  kind: 'leaf';
  path: number[];
  key: string;
  valueHash: string;
  hash: string;
  dirty?: boolean;
};

type PersistedMerkleChildRef = {
  slot: number;
  kind: 'branch' | 'leaf';
  path: number[];
  hash: string;
  node?: PersistedMerkleNode;
};

type PersistedMerkleBranchNode = {
  kind: 'branch';
  path: number[];
  children: Map<number, PersistedMerkleChildRef>;
  hash: string;
  dirty?: boolean;
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
    this.leafCountValue = Math.max(0, Math.floor(Number(rootDoc.leafCount ?? 0)));
  }

  static async open(db: RuntimeDbLike, entityId: string): Promise<PersistedEntityMerkleEditor | null> {
    const normalized = normalizeEntityId(entityId);
    const rootDoc = await readJsonOrNull<StorageMerkleRootDoc>(db, keyMerkleRoot(normalized, ENTITY_MERKLE_NAMESPACE));
    if (!rootDoc) return null;
    if (rootDoc.rootKind === 'empty' || rootDoc.leafCount === 0) {
      return new PersistedEntityMerkleEditor(db, normalized, {
        ...rootDoc,
        rootHash: rootDoc.rootHash || EMPTY_RADIX_MERKLE_ROOT,
        rootKind: 'empty',
        rootPath: [],
        leafCount: 0,
      });
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

  async put(cellKey: string, valueHash: string): Promise<void> {
    const leaf = this.makeLeaf(cellKey, valueHash, true);
    const result = await this.insertNode(await this.loadRootNode(), leaf);
    this.rootNode = result.node;
    this.rootNodeLoaded = true;
    if (!result.existed) this.leafCountValue += 1;
  }

  async del(cellKey: string): Promise<void> {
    const path = this.pathForCellKey(cellKey);
    const result = await this.deleteNode(await this.loadRootNode(), path);
    if (!result.deleted) return;
    this.rootNode = result.node;
    this.rootNodeLoaded = true;
    this.leafCountValue = Math.max(0, this.leafCountValue - 1);
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
    const rootHash = root
      ? computeRadixMerkleRootHash(DEFAULT_ACCOUNT_MERKLE_RADIX, root.kind, root.path, this.nodeHash(root))
      : EMPTY_RADIX_MERKLE_ROOT;
    const branchPuts: StorageMerkleBranchDoc[] = [];
    const leafPuts: StorageMerkleLeafDoc[] = [];
    this.collectDirty(root, branchPuts, leafPuts);
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
    return radixMerklePathSlots(hashToBytes(storageMerklePath(cellKey)), DEFAULT_ACCOUNT_MERKLE_RADIX);
  }

  private makeLeaf(cellKey: string, valueHash: string, dirty: boolean): PersistedMerkleLeafNode {
    const keyBytes = hashToBytes(storageMerklePath(cellKey));
    const valueBytes = hashToBytes(valueHash);
    const path = radixMerklePathSlots(keyBytes, DEFAULT_ACCOUNT_MERKLE_RADIX);
    return {
      kind: 'leaf',
      path,
      key: `0x${Buffer.from(keyBytes).toString('hex')}`,
      valueHash,
      hash: computeRadixMerkleLeafHash(keyBytes, valueBytes),
      dirty,
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
    const doc = await readJsonOrNull<StorageMerkleLeafDoc>(
      this.db,
      keyMerkleLeaf(this.entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, path)),
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
    const doc = await readJsonOrNull<StorageMerkleBranchDoc>(
      this.db,
      keyMerkleBranch(this.entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, path)),
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
      hash: computeRadixMerkleEdgeHash(
        DEFAULT_ACCOUNT_MERKLE_RADIX,
        parentPath,
        node.kind,
        node.path,
        this.nodeHash(node),
      ),
      node,
    };
  }

  private nodeHash(node: PersistedMerkleNode): string {
    if (node.kind === 'leaf') {
      if (!node.dirty && node.hash) return node.hash;
      node.hash = computeRadixMerkleLeafHash(
        Buffer.from(node.key.replace(/^0x/, ''), 'hex'),
        Buffer.from(node.valueHash.replace(/^0x/, ''), 'hex'),
      );
      return node.hash;
    }
    if (!node.dirty && node.hash) return node.hash;
    node.hash = computeRadixMerkleBranchHash(
      DEFAULT_ACCOUNT_MERKLE_RADIX,
      Array.from(node.children.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([slot, child]) => [slot, this.childEdgeHash(node.path, child)]),
    );
    return node.hash;
  }

  private childEdgeHash(parentPath: number[], child: PersistedMerkleChildRef): string {
    if (!child.node) return child.hash;
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
    node.dirty = true;
    node.hash = '';
  }

  private makeBranch(path: number[], children: PersistedMerkleNode[]): PersistedMerkleBranchNode {
    const branch: PersistedMerkleBranchNode = {
      kind: 'branch',
      path,
      hash: '',
      dirty: true,
      children: new Map(),
    };
    for (const child of children) {
      const ref = this.childRefFromNode(path, child);
      branch.children.set(ref.slot, ref);
    }
    branch.hash = this.nodeHash(branch);
    return branch;
  }

  private async insertNode(
    node: PersistedMerkleNode | null,
    leaf: PersistedMerkleLeafNode,
  ): Promise<{ node: PersistedMerkleNode; existed: boolean }> {
    if (!node) return { node: leaf, existed: false };
    if (node.kind === 'leaf') {
      const shared = commonMerklePathPrefixLength(node.path, leaf.path);
      if (shared === node.path.length && shared === leaf.path.length) {
        node.key = leaf.key;
        node.valueHash = leaf.valueHash;
        node.hash = leaf.hash;
        node.dirty = true;
        return { node, existed: true };
      }
      return {
        node: this.makeBranch(node.path.slice(0, shared), [node, leaf]),
        existed: false,
      };
    }

    const shared = commonMerklePathPrefixLength(node.path, leaf.path);
    if (shared < node.path.length) {
      return {
        node: this.makeBranch(node.path.slice(0, shared), [node, leaf]),
        existed: false,
      };
    }

    const slot = nodeSlotUnder(node.path, leaf.path);
    const childRef = node.children.get(slot);
    if (!childRef) {
      node.children.set(slot, this.childRefFromNode(node.path, leaf));
      this.markBranchDirty(node);
      return { node, existed: false };
    }

    const child = await this.loadChild(childRef);
    const result = await this.insertNode(child, leaf);
    node.children.set(slot, this.childRefFromNode(node.path, result.node));
    this.markBranchDirty(node);
    return { node, existed: result.existed };
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

  private collectDirty(
    node: PersistedMerkleNode | null,
    branchPuts: StorageMerkleBranchDoc[],
    leafPuts: StorageMerkleLeafDoc[],
  ): void {
    if (!node) return;
    if (node.kind === 'leaf') {
      if (node.dirty) {
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

    if (node.dirty) {
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
    for (const child of node.children.values()) {
      if (child.node) this.collectDirty(child.node, branchPuts, leafPuts);
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

const appendEntityMerkleFlush = (
  entityId: string,
  flushed: EntityMerkleFlush,
  merklePuts: Array<{ key: Buffer; value: Buffer }>,
  merkleDelsByKey: Map<string, Buffer>,
): void => {
  merklePuts.push({ key: keyMerkleRoot(entityId, ENTITY_MERKLE_NAMESPACE), value: encodeBuffer(flushed.rootDoc) });
  for (const branchDoc of flushed.branchPuts) {
    merklePuts.push({
      key: keyMerkleBranch(entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(branchDoc.radix, branchDoc.path)),
      value: encodeBuffer(branchDoc),
    });
  }
  for (const leafDoc of flushed.leafPuts) {
    merklePuts.push({
      key: keyMerkleLeaf(entityId, ENTITY_MERKLE_NAMESPACE, packRadixMerklePath(leafDoc.radix, leafDoc.path)),
      value: encodeBuffer(leafDoc),
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
    const entityId = decodeEntityId(key.subarray(1, 33));
    const rootDoc = await readJsonOrNull<StorageMerkleRootDoc>(db, key);
    if (!rootDoc || rootDoc.namespace !== ENTITY_MERKLE_NAMESPACE) continue;
    docs.set(normalizeEntityId(entityId), {
      entityId: normalizeEntityId(entityId),
      hash: rootDoc.rootHash || EMPTY_RADIX_MERKLE_ROOT,
      cellCount: Math.max(0, Math.floor(Number(rootDoc.leafCount ?? 0))),
    });
  }

  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    const entityId = decodeEntityId(key.subarray(1, 33));
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
  merklePuts: Array<{ key: Buffer; value: Buffer }>;
  merkleDels: Buffer[];
}> => {
  const entityHashDocs = options.entityHashDocs
    ? new Map(options.entityHashDocs)
    : await readAllEntityHashDocs(options.db);
  const docValueBuffers = new Map<string, Buffer>();
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
    if (hash) await editor.put(key, hash);
    else await editor.del(key);
    touchedEntityIds.add(normalized);
    entityHashDocs.set(normalized, entityHashDocs.get(normalized) ?? {
      entityId: normalized,
      hash: EMPTY_RADIX_MERKLE_ROOT,
      cellCount: editor.leafCount,
    });
  };

  for (const doc of options.puts) {
    const ref = docRefForDoc(doc);
    const encoded = encodeStorageDocValue(doc);
    docValueBuffers.set(docValueKey(doc), encoded.buffer);
    await updateEntityCell(ref.entityId, docRefCellKey(ref), encoded.hash);
  }

  for (const ref of options.dels) {
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
    merklePuts,
    merkleDels: Array.from(merkleDelsByKey.values()),
  };
};
