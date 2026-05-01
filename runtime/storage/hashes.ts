import type { BookState } from '../orderbook';
import { ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import type { AccountMachine, Env } from '../types';
import {
  computeCanonicalEntityHash,
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalRuntimeStateHash,
  type CanonicalFrameEntityHash,
} from './canonical-hash';
import { encodeBuffer } from './codec';
import {
  docRefCellKey,
  docRefForDoc,
  docValueKey,
  keyLiveDocHash,
} from './doc-refs';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  hexBytes,
  keyLiveAccountPrefix,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveEntityHash,
  keyLiveEntityHashPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
} from './keys';
import { iterateKeys, readJsonOrNull, readRawOrNull } from './level';
import { buildHexKeyedMerkle, MutableRadixMerkleTree } from './merkle';
import { projectAccountDoc, projectEntityCoreDoc } from './projections';
import { buildReplicaLookup, findReplicaForEntity } from './replicas';
import type {
  RuntimeDbLike,
  StorageDoc,
  StorageDocRef,
  StorageEntityHashDoc,
  StorageFrameEntityHash,
  StorageFrameRecord,
  StorageHashCell,
} from './types';

type StorageDocEncodedValue = { buffer: Buffer; hash: string; hashBytes: Buffer };
type StorageDocWithComputedHash = StorageDoc & {
  hash?: string;
  encodedValue?: Buffer;
  hashBytes?: Buffer;
};
type RuntimeEntityHashDoc = StorageEntityHashDoc & {
  cellMap?: Map<string, string>;
  merkleTree?: MutableRadixMerkleTree;
};

const MAX_PERSISTED_HASH_CELLS = Math.max(
  0,
  Math.floor(Number(process.env['XLN_STORAGE_MAX_PERSISTED_HASH_CELLS'] ?? 4096)),
);

const setHiddenDocComputedValue = <K extends keyof StorageDocWithComputedHash>(
  doc: StorageDocWithComputedHash,
  key: K,
  value: StorageDocWithComputedHash[K],
): void => {
  Object.defineProperty(doc, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

const hashBuffer = (value: Buffer | Uint8Array): string =>
  ethers.keccak256(value instanceof Uint8Array ? value : Uint8Array.from(value));

const hashStable = (value: unknown): string => ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(value)));

const hashToBytes = (hash: string): Buffer =>
  Buffer.from(String(hash || '').replace(/^0x/, '').padStart(64, '0'), 'hex');

const encodeStorageDocValue = (doc: StorageDoc): StorageDocEncodedValue => {
  const cached = doc as StorageDocWithComputedHash;
  if (
    typeof cached.hash === 'string' &&
    Buffer.isBuffer(cached.encodedValue) &&
    Buffer.isBuffer(cached.hashBytes)
  ) {
    return { buffer: cached.encodedValue, hash: cached.hash, hashBytes: cached.hashBytes };
  }
  const buffer = encodeBuffer(doc.value);
  const hash = hashBuffer(buffer);
  const hashBytes = Buffer.from(hash.slice(2), 'hex');
  // Per-frame StorageDoc objects are the overlay. Keep computed values on that
  // object, hidden from diff encoding. Durable truth remains KEY_LIVE_DOC_HASH
  // and KEY_LIVE_ENTITY_HASH in LevelDB.
  setHiddenDocComputedValue(cached, 'encodedValue', buffer);
  setHiddenDocComputedValue(cached, 'hash', hash);
  setHiddenDocComputedValue(cached, 'hashBytes', hashBytes);
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
  const [baseTokenId, quoteTokenId, extra] = String(pairId || '').split('/');
  if (baseTokenId === undefined || quoteTokenId === undefined || extra !== undefined) {
    throw new Error(`STORAGE_INVALID_BOOK_MERKLE_PATH: ${pairId}`);
  }
  return Buffer.concat([
    encodeMerkleUint64(baseTokenId, 'BOOK_BASE'),
    encodeMerkleUint64(quoteTokenId, 'BOOK_QUOTE'),
    Buffer.alloc(16),
  ]);
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

const normalizeHashCells = (cells: Iterable<StorageHashCell>): StorageHashCell[] =>
  Array.from(cells)
    .map((cell) => ({ key: String(cell.key), hash: String(cell.hash) }))
    .filter((cell) => cell.key.length > 0 && /^0x[0-9a-f]{64}$/i.test(cell.hash))
    .sort((left, right) => left.key.localeCompare(right.key));

const hashCellLeaf = (cell: StorageHashCell): { key: Uint8Array; value: Uint8Array } => ({
  key: hashToBytes(storageMerklePath(cell.key)),
  value: hashToBytes(cell.hash),
});

const setHiddenEntityHashState = (
  doc: RuntimeEntityHashDoc,
  cellMap: Map<string, string>,
  merkleTree: MutableRadixMerkleTree,
): void => {
  Object.defineProperty(doc, 'cellMap', {
    value: cellMap,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(doc, 'merkleTree', {
    value: merkleTree,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

const syncEntityHashDocVisibleCells = (doc: RuntimeEntityHashDoc): StorageEntityHashDoc => {
  const cellMap = doc.cellMap ?? new Map(doc.cells.map((cell) => [cell.key, cell.hash]));
  doc.cellCount = cellMap.size;
  doc.cells = cellMap.size <= MAX_PERSISTED_HASH_CELLS
    ? Array.from(cellMap, ([key, hash]) => ({ key, hash })).sort((left, right) => left.key.localeCompare(right.key))
    : [];
  return doc;
};

const buildEntityHashDoc = (entityId: string, cells: Iterable<StorageHashCell>): StorageEntityHashDoc => {
  const normalizedCells = normalizeHashCells(cells);
  const cellMap = new Map(normalizedCells.map((cell) => [cell.key, cell.hash]));
  const merkleTree = new MutableRadixMerkleTree({
    radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
    leaves: normalizedCells.map(hashCellLeaf),
  });
  const doc: RuntimeEntityHashDoc = {
    entityId: normalizeEntityId(entityId),
    cells: normalizedCells.length <= MAX_PERSISTED_HASH_CELLS ? normalizedCells : [],
    cellCount: normalizedCells.length,
    hash: merkleTree.getRoot(),
  };
  setHiddenEntityHashState(doc, cellMap, merkleTree);
  return doc;
};

const ensureEntityHashRuntime = (doc: StorageEntityHashDoc): RuntimeEntityHashDoc => {
  const runtimeDoc = doc as RuntimeEntityHashDoc;
  if (
    runtimeDoc.cellMap instanceof Map &&
    runtimeDoc.merkleTree instanceof MutableRadixMerkleTree &&
    runtimeDoc.cellMap.size === runtimeDoc.merkleTree.leafCount
  ) {
    return runtimeDoc;
  }
  const normalizedCells = normalizeHashCells(runtimeDoc.cells);
  const cellMap = new Map(normalizedCells.map((cell) => [cell.key, cell.hash]));
  const merkleTree = new MutableRadixMerkleTree({
    radix: DEFAULT_ACCOUNT_MERKLE_RADIX,
    leaves: normalizedCells.map(hashCellLeaf),
  });
  runtimeDoc.hash = merkleTree.getRoot();
  runtimeDoc.cellCount = cellMap.size;
  setHiddenEntityHashState(runtimeDoc, cellMap, merkleTree);
  return syncEntityHashDocVisibleCells(runtimeDoc);
};

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
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

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
  const liveEntityIds = new Set(Array.from(env.eReplicas.values()).map((replica) => normalizeEntityId(replica.entityId)));
  const previousHashes = Array.isArray(previousFrame?.canonicalEntityHashes)
    ? normalizeFrameEntityHashes(previousFrame.canonicalEntityHashes)
    : [];
  const canonicalHashByEntity = new Map<string, CanonicalFrameEntityHash>();

  if (previousHashes.length > 0) {
    for (const entry of previousHashes) {
      if (liveEntityIds.has(entry.entityId)) canonicalHashByEntity.set(entry.entityId, entry);
    }
  } else {
    for (const entry of computeCanonicalEntityHashesFromEnv(env)) {
      canonicalHashByEntity.set(entry.entityId, entry);
    }
  }

  for (const entityId of touchedEntities) {
    const normalized = normalizeEntityId(entityId);
    const replica = findReplicaForEntity(env, normalized, replicaLookup)?.replica;
    if (replica) {
      canonicalHashByEntity.set(normalized, computeCanonicalEntityHash(replica));
    } else {
      canonicalHashByEntity.delete(normalized);
    }
  }

  const canonicalEntityHashes = Array.from(canonicalHashByEntity.values())
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  return {
    canonicalEntityHashes,
    canonicalStateHash: computeCanonicalRuntimeStateHash(env.height, env.timestamp, canonicalEntityHashes),
  };
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
      .sort((left, right) => left.entityId.localeCompare(right.entityId)),
  });
};

const readEntityHashDoc = async (db: RuntimeDbLike, entityId: string): Promise<StorageEntityHashDoc | null> =>
  readJsonOrNull<StorageEntityHashDoc>(db, keyLiveEntityHash(entityId));

const buildEntityHashDocFromLive = async (db: RuntimeDbLike, entityId: string): Promise<StorageEntityHashDoc> => {
  const normalizedEntityId = normalizeEntityId(entityId);
  const cells: StorageHashCell[] = [];
  const entityRaw = await readRawOrNull(db, keyLiveEntity(normalizedEntityId));
  if (entityRaw) cells.push({ key: 'entity', hash: hashBuffer(entityRaw) });

  for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix(normalizedEntityId) })) {
    const raw = await readRawOrNull(db, key);
    if (!raw) continue;
    const parsed = parseLiveAccountKey(key);
    cells.push({ key: docRefCellKey({ family: 'account', entityId: normalizedEntityId, counterpartyId: parsed.counterpartyId }), hash: hashBuffer(raw) });
  }

  for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix(normalizedEntityId) })) {
    const raw = await readRawOrNull(db, key);
    if (!raw) continue;
    const parsed = parseLiveBookKey(key);
    cells.push({ key: docRefCellKey({ family: 'book', entityId: normalizedEntityId, pairId: parsed.pairId }), hash: hashBuffer(raw) });
  }

  return buildEntityHashDoc(normalizedEntityId, cells);
};

export const readAllEntityHashDocs = async (db: RuntimeDbLike): Promise<Map<string, StorageEntityHashDoc>> => {
  const docs = new Map<string, StorageEntityHashDoc>();
  for await (const key of iterateKeys(db, { prefix: keyLiveEntityHashPrefix() })) {
    const entityId = decodeEntityId(key.subarray(1, 33));
    const doc = await readEntityHashDoc(db, entityId);
    if (!doc) continue;
    if (doc.cells.length === 0 && Number(doc.cellCount ?? 0) > 0) {
      docs.set(normalizeEntityId(entityId), await buildEntityHashDocFromLive(db, entityId));
    } else {
      docs.set(normalizeEntityId(entityId), buildEntityHashDoc(entityId, doc.cells));
    }
  }

  if (docs.size > 0) return docs;

  // Backward-compatibility bootstrap for DBs created before storage-debug-v1
  // hash docs. This is intentionally one-time O(live state); subsequent frames
  // update only touched cell hashes.
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    const entityId = decodeEntityId(key.subarray(1, 33));
    docs.set(normalizeEntityId(entityId), await buildEntityHashDocFromLive(db, entityId));
  }
  return docs;
};

export const toFrameEntityHashes = (docs: Iterable<StorageEntityHashDoc>): StorageFrameEntityHash[] =>
  Array.from(docs)
    .map((doc) => ({ entityId: normalizeEntityId(doc.entityId), hash: doc.hash, cellCount: Number(doc.cellCount ?? doc.cells.length) }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

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
  docHashPuts: Array<{ key: Buffer; value: Buffer }>;
  docHashDels: Buffer[];
  entityHashPuts: Array<{ key: Buffer; value: Buffer }>;
}> => {
  const entityHashDocs = options.entityHashDocs
    ? new Map(options.entityHashDocs)
    : await readAllEntityHashDocs(options.db);
  const docValueBuffers = new Map<string, Buffer>();
  const docHashPuts: Array<{ key: Buffer; value: Buffer }> = [];
  const docHashDels: Buffer[] = [];
  const touchedEntityIds = new Set<string>();

  const ensureEntityDoc = async (entityId: string): Promise<StorageEntityHashDoc> => {
    const normalized = normalizeEntityId(entityId);
    let doc = entityHashDocs.get(normalized);
    if (!doc || (doc.cells.length === 0 && Number(doc.cellCount ?? 0) > 0 && !(doc as RuntimeEntityHashDoc).cellMap)) {
      doc = await buildEntityHashDocFromLive(options.db, normalized);
      entityHashDocs.set(normalized, doc);
    }
    return doc;
  };

  const updateEntityCell = async (entityId: string, key: string, hash: string | null): Promise<void> => {
    const normalized = normalizeEntityId(entityId);
    const current = ensureEntityHashRuntime(await ensureEntityDoc(normalized));
    const cellMap = current.cellMap!;
    const merkleTree = current.merkleTree!;
    if (hash) {
      cellMap.set(key, hash);
      merkleTree.put(hashToBytes(storageMerklePath(key)), hashToBytes(hash));
    } else {
      cellMap.delete(key);
      merkleTree.del(hashToBytes(storageMerklePath(key)));
    }
    current.hash = merkleTree.getRoot();
    current.cellCount = cellMap.size;
    entityHashDocs.set(normalized, current);
    touchedEntityIds.add(normalized);
  };

  for (const doc of options.puts) {
    const ref = docRefForDoc(doc);
    const encoded = encodeStorageDocValue(doc);
    docValueBuffers.set(docValueKey(doc), encoded.buffer);
    docHashPuts.push({ key: keyLiveDocHash(ref), value: encoded.hashBytes });
    await updateEntityCell(ref.entityId, docRefCellKey(ref), encoded.hash);
  }

  for (const ref of options.dels) {
    docHashDels.push(keyLiveDocHash(ref));
    await updateEntityCell(ref.entityId, docRefCellKey(ref), null);
  }

  const entityHashPuts = Array.from(touchedEntityIds).map((entityId) => {
    const doc = syncEntityHashDocVisibleCells(
      (entityHashDocs.get(entityId) ?? buildEntityHashDoc(entityId, [])) as RuntimeEntityHashDoc,
    );
    return {
      key: keyLiveEntityHash(entityId),
      value: encodeBuffer(doc),
    };
  });
  const entityHashes = toFrameEntityHashes(entityHashDocs.values());
  return {
    stateHash: computeStorageStateRoot(entityHashes),
    entityHashes,
    entityHashDocs,
    docValueBuffers,
    docHashPuts,
    docHashDels,
    entityHashPuts,
  };
};

export const computeStorageDebugStateHashFromEnv = (env: Env): string => {
  const entityHashDocs: StorageEntityHashDoc[] = [];
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const entityId = normalizeEntityId(String(replica?.entityId || String(replicaKey).split(':')[0] || ''));
    if (!entityId || !replica?.state) continue;
    const cells: StorageHashCell[] = [];
    cells.push({
      key: 'entity',
      hash: hashBuffer(encodeBuffer(projectEntityCoreDoc(replica.state, replica))),
    });
    for (const [counterpartyId, account] of replica.state.accounts ?? new Map<string, AccountMachine>()) {
      cells.push({
        key: docRefCellKey({ family: 'account', entityId, counterpartyId: normalizeEntityId(counterpartyId) }),
        hash: hashBuffer(encodeBuffer(projectAccountDoc(account))),
      });
    }
    for (const [pairId, book] of replica.state.orderbookExt?.books ?? new Map<string, BookState>()) {
      cells.push({
        key: docRefCellKey({ family: 'book', entityId, pairId: String(pairId) }),
        hash: hashBuffer(encodeBuffer(book)),
      });
    }
    entityHashDocs.push(buildEntityHashDoc(entityId, cells));
  }
  return computeStorageStateRoot(toFrameEntityHashes(entityHashDocs));
};
