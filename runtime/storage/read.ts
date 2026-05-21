import type { BookState } from '../orderbook';
import type { EntityState, Env } from '../types';
import { ethers } from 'ethers';
import { decodeBuffer } from './codec';
import { docRefCellKey, docRefKey, docValueKey } from './doc-refs';
import { storageMerkleCellHexKey } from './hashes';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  KEY_HEAD,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  hexBytes,
  keyDiff,
  keyFrame,
  keyMerkleLeaf,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyMerkleBranchPrefix,
  keyMerkleLeafPrefix,
  keyMerkleRoot,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
  prefixUpperBound,
  textBytes,
} from './keys';
import { iterateKeys, readJsonOrNull, readRawOrNull } from './level';
import { listSnapshotHeights } from './lifecycle';
import { compareAscii } from '../sorted-index';
import {
  buildHexKeyedMerkle,
  computeRadixMerkleBranchHash,
  computeRadixMerkleLeafHash,
  packRadixMerklePath,
  radixMerklePathSlots,
} from './merkle';
import { hydrateEntityStateFromStorage } from './projections';
import type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageEntityCoreDoc,
  StorageFrameRecord,
  StorageHead,
  StorageMerkleBranchDoc,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
  StorageReplicaMeta,
} from './types';

export type StorageAccountDocPage = {
  items: StorageAccountDoc[];
  nextCursor: string | null;
};

export type StorageBookDocPage = {
  items: Array<{ pairId: string; book: BookState }>;
  nextCursor: string | null;
};

export type StorageEntityViewPage = {
  core: StorageEntityCoreDoc;
  accounts: StorageAccountDocPage;
  books: StorageBookDocPage;
};

export type StoragePageQuery = {
  cursor?: string;
  limit?: number;
  sortDir?: 'asc' | 'desc';
};

export const readStorageHead = async (
  db: RuntimeDbLike,
): Promise<StorageHead | null> => readJsonOrNull<StorageHead>(db, KEY_HEAD);

export const readStorageFrameRecord = async (
  db: RuntimeDbLike,
  height: number,
): Promise<StorageFrameRecord | null> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return null;
  return readJsonOrNull<StorageFrameRecord>(db, keyFrame(targetHeight));
};

export const readStorageReplicaMeta = async (
  db: RuntimeDbLike,
  entityId: string,
): Promise<StorageReplicaMeta | null> => readJsonOrNull<StorageReplicaMeta>(db, keyLiveReplicaMeta(entityId));

export const listStorageSnapshotHeights = async (db: RuntimeDbLike): Promise<number[]> => {
  return listSnapshotHeights(db);
};

const findLatestSnapshotAtOrBelow = async (db: RuntimeDbLike, height: number): Promise<number> => {
  const heights = await listSnapshotHeights(db);
  let best = 0;
  for (const value of heights) {
    if (value <= height && value > best) best = value;
  }
  return best;
};

const storageVerifyDocHashesEnabled = (): boolean => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] ?? '' : '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

const storageVerifyMerkleMode = (): 'none' | 'deep' => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_VERIFY_MERKLE'] ?? '' : '')
    .trim()
    .toLowerCase();
  if (raw === 'deep' || raw === '1' || raw === 'true' || raw === 'yes') return 'deep';
  return 'none';
};

const hashRawDocValue = (value: Buffer | Uint8Array): string =>
  ethers.keccak256(value instanceof Uint8Array ? value : Uint8Array.from(value));

const assertLiveDocHash = async (options: {
  db: RuntimeDbLike;
  ref: StorageDocRef;
  raw: Buffer | Uint8Array;
  enabled: boolean;
}): Promise<void> => {
  if (!options.enabled) return;
  const key = docRefKey(options.ref);
  const entityId = normalizeEntityId(options.ref.entityId);
  const leafKeyHex = storageMerkleCellHexKey(docRefCellKey(options.ref));
  const leafKeyBytes = Buffer.from(leafKeyHex.slice(2), 'hex');
  const leafPath = radixMerklePathSlots(leafKeyBytes, DEFAULT_ACCOUNT_MERKLE_RADIX);
  const leaf = await readJsonOrNull<StorageMerkleLeafDoc>(
    options.db,
    keyMerkleLeaf(entityId, 'runtime-roots', packRadixMerklePath(DEFAULT_ACCOUNT_MERKLE_RADIX, leafPath)),
  );
  if (!leaf) throw new Error(`STORAGE_DOC_HASH_MISSING: ${key}`);
  const expected = String(leaf.valueHash || '');
  const actual = hashRawDocValue(options.raw);
  if (actual !== expected) {
    throw new Error(`STORAGE_DOC_HASH_MISMATCH: ${key} actual=${actual} expected=${expected}`);
  }
  const valueBytes = Buffer.from(expected.replace(/^0x/, ''), 'hex');
  const actualLeafHash = computeRadixMerkleLeafHash(leafKeyBytes, valueBytes);
  if (actualLeafHash !== leaf.hash) {
    throw new Error(`STORAGE_MERKLE_LEAF_HASH_MISMATCH: entity=${entityId} path=${leaf.path.join('.')}`);
  }
};

const assertLiveMerkleIntegrity = async (
  db: RuntimeDbLike,
  entityId: string,
  mode: 'none' | 'deep',
): Promise<void> => {
  if (mode === 'none') return;
  const normalized = normalizeEntityId(entityId);
  const root = await readJsonOrNull<StorageMerkleRootDoc>(db, keyMerkleRoot(normalized, 'runtime-roots'));
  if (!root) throw new Error(`STORAGE_MERKLE_ROOT_MISSING: entity=${normalized}`);

  let branchCount = 0;
  for await (const key of iterateKeys(db, { prefix: keyMerkleBranchPrefix(normalized, 'runtime-roots') })) {
    const branch = decodeBuffer<StorageMerkleBranchDoc>(await db.get(key));
    const actual = computeRadixMerkleBranchHash(
      branch.radix,
      branch.children.map((child) => [child.slot, child.hash]),
    );
    if (actual !== branch.hash) {
      throw new Error(`STORAGE_MERKLE_BRANCH_HASH_MISMATCH: entity=${normalized} path=${branch.path.join('.')}`);
    }
    branchCount += 1;
  }

  const leaves: Array<{ hexKey: string; value: Uint8Array }> = [];
  for await (const key of iterateKeys(db, { prefix: keyMerkleLeafPrefix(normalized, 'runtime-roots') })) {
    const leaf = decodeBuffer<StorageMerkleLeafDoc>(await db.get(key));
    const keyBytes = Buffer.from(String(leaf.key || '').replace(/^0x/, ''), 'hex');
    const valueBytes = Buffer.from(String(leaf.valueHash || '').replace(/^0x/, ''), 'hex');
    const actual = computeRadixMerkleLeafHash(keyBytes, valueBytes);
    if (actual !== leaf.hash) {
      throw new Error(`STORAGE_MERKLE_LEAF_HASH_MISMATCH: entity=${normalized} path=${leaf.path.join('.')}`);
    }
    leaves.push({ hexKey: leaf.key, value: valueBytes });
  }
  if (leaves.length !== root.leafCount) {
    throw new Error(`STORAGE_MERKLE_DEEP_LEAF_COUNT_MISMATCH: entity=${normalized} actual=${leaves.length} expected=${root.leafCount}`);
  }
  const rebuilt = buildHexKeyedMerkle(leaves, { radix: root.radix });
  if (rebuilt.root !== root.rootHash) {
    throw new Error(`STORAGE_MERKLE_DEEP_ROOT_MISMATCH: entity=${normalized} actual=${rebuilt.root} expected=${root.rootHash} branches=${branchCount}`);
  }
};

const readPageLimit = (query?: StoragePageQuery): number => {
  const raw = Number(query?.limit ?? 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.floor(raw))) : 10;
};

const readAccountCursor = (query?: StoragePageQuery): string =>
  query?.cursor ? normalizeEntityId(query.cursor) : '';

const isAfterAccountCursor = (
  counterpartyId: string,
  cursor: string,
  direction: 'asc' | 'desc',
): boolean => !cursor || (direction === 'desc' ? counterpartyId < cursor : counterpartyId > cursor);

const pushAccountCandidate = (
  candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }>,
  seen: Set<string>,
  counterpartyId: string,
  doc: StorageAccountDoc,
  limit: number,
  direction: 'asc' | 'desc',
): void => {
  const normalized = normalizeEntityId(counterpartyId);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  const compare = (left: string, right: string): number =>
    direction === 'desc' ? compareAscii(right, left) : compareAscii(left, right);
  let insertAt = candidates.length;
  while (insertAt > 0 && compare(normalized, candidates[insertAt - 1]!.counterpartyId) < 0) {
    insertAt -= 1;
  }
  candidates.splice(insertAt, 0, { counterpartyId: normalized, doc });
  if (candidates.length > limit + 1) {
    const dropped = candidates.pop();
    if (dropped) seen.delete(dropped.counterpartyId);
  }
};

const accountPageFromCandidates = (
  candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }>,
  limit: number,
): StorageAccountDocPage => {
  const visible = candidates.slice(0, limit);
  return {
    items: visible.map((entry) => entry.doc),
    nextCursor: candidates.length > limit ? visible[visible.length - 1]?.counterpartyId ?? null : null,
  };
};

const parseSnapshotAccountKey = (key: Buffer): { entityId: string; counterpartyId: string } => ({
  entityId: decodeEntityId(key.subarray(9, 41)),
  counterpartyId: decodeEntityId(key.subarray(41, 73)),
});

const keySnapshotAccountCursor = (height: number, entityId: string, counterpartyId: string): Buffer =>
  Buffer.concat([keySnapshotAccountPrefix(height, entityId), hexBytes(counterpartyId)]);

const keySnapshotBookCursor = (height: number, entityId: string, pairId: string): Buffer =>
  Buffer.concat([keySnapshotBookPrefix(height, entityId), textBytes(pairId)]);

const listAccountPageFromKeyspace = async (options: {
  db: RuntimeDbLike;
  prefix: Buffer;
  cursorKey?: Buffer | undefined;
  parseKey: (key: Buffer) => { counterpartyId: string };
  cursor: string;
  limit: number;
  direction: 'asc' | 'desc';
  overlay?: Map<string, StorageAccountDoc | null>;
}): Promise<StorageAccountDocPage | null> => {
  const { db, prefix, parseKey, cursor, limit, direction, overlay } = options;
  if (typeof db.keys !== 'function') return null;
  const candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }> = [];
  const seen = new Set<string>();

  for (const [counterpartyId, doc] of overlay?.entries?.() ?? []) {
    if (!doc || !isAfterAccountCursor(counterpartyId, cursor, direction)) continue;
    pushAccountCandidate(candidates, seen, counterpartyId, doc, limit, direction);
  }

  const upperBound = prefixUpperBound(prefix);
  const range = direction === 'asc'
    ? (upperBound ? { gte: options.cursorKey ?? prefix, lt: upperBound } : { gte: options.cursorKey ?? prefix })
    : (upperBound
        ? { gte: prefix, lt: options.cursorKey ?? upperBound, reverse: true }
        : { prefix, reverse: true });
  for await (const key of iterateKeys(db, range)) {
    const { counterpartyId } = parseKey(key);
    const normalized = normalizeEntityId(counterpartyId);
    if (!isAfterAccountCursor(normalized, cursor, direction)) continue;
    if (overlay?.has(normalized)) continue;
    const doc = decodeBuffer<StorageAccountDoc>(await db.get(key));
    pushAccountCandidate(candidates, seen, normalized, doc, limit, direction);
    const worst = candidates[candidates.length - 1]?.counterpartyId;
    if (direction === 'asc' && candidates.length > limit && worst && compareAscii(normalized, worst) >= 0) break;
    if (direction === 'desc' && candidates.length > limit && worst && compareAscii(normalized, worst) <= 0) break;
  }

  return accountPageFromCandidates(candidates, limit);
};

export const findStorageLatestSnapshotAtOrBelow = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  return findLatestSnapshotAtOrBelow(db, height);
};

export const listStorageLiveEntityIds = async (db: RuntimeDbLike): Promise<string[]> => {
  const ids: string[] = [];
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    ids.push(decodeEntityId(key.subarray(1, 33)));
  }
  return ids;
};

export const listStorageSnapshotEntityIds = async (
  db: RuntimeDbLike,
  height: number,
): Promise<string[]> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return [];
  const ids: string[] = [];
  for await (const key of iterateKeys(db, { prefix: keySnapshotEntityPrefix(targetHeight) })) {
    ids.push(decodeEntityId(key.subarray(9, 41)));
  }
  return ids;
};

const applyDocs = (
  target: Map<string, StorageDoc>,
  puts: StorageDoc[],
  dels: StorageDocRef[],
  entityId?: string,
): void => {
  const filterEntity = entityId ? normalizeEntityId(entityId) : null;
  for (const ref of dels) {
    if (filterEntity && normalizeEntityId(ref.entityId) !== filterEntity) continue;
    target.delete(docRefKey(ref));
  }
  for (const doc of puts) {
    if (filterEntity && normalizeEntityId(doc.entityId) !== filterEntity) continue;
    target.set(docValueKey(doc), doc);
  }
};

const readRequiredDiff = async (
  db: RuntimeDbLike,
  height: number,
  scope: string,
): Promise<StorageDiffRecord> => {
  const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(height));
  if (!diff) {
    throw new Error(`STORAGE_DIFF_MISSING: height=${height} scope=${scope}`);
  }
  return diff;
};

const loadSnapshotDocsForEntity = async (db: RuntimeDbLike, snapshotHeight: number, entityId: string): Promise<Map<string, StorageDoc>> => {
  const docs = new Map<string, StorageDoc>();

  const entityBuffer = await readJsonOrNull<StorageEntityCoreDoc>(db, keySnapshotEntity(snapshotHeight, entityId));
  if (entityBuffer) {
    docs.set(`e:${normalizeEntityId(entityId)}`, { family: 'entity', entityId: normalizeEntityId(entityId), value: entityBuffer });
  }

  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(snapshotHeight, entityId) })) {
    const entity = decodeEntityId(key.subarray(9, 41));
    const counterparty = decodeEntityId(key.subarray(41, 73));
    const value = decodeBuffer<StorageAccountDoc>(await db.get(key));
    docs.set(`a:${normalizeEntityId(entity)}:${normalizeEntityId(counterparty)}`, {
      family: 'account',
      entityId: normalizeEntityId(entity),
      counterpartyId: normalizeEntityId(counterparty),
      value,
    });
  }

  for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(snapshotHeight, entityId) })) {
    const parsed = parseLiveBookKey(key, 9);
    const value = decodeBuffer<BookState>(await db.get(key));
    docs.set(`b:${normalizeEntityId(parsed.entityId)}:${parsed.pairId}`, {
      family: 'book',
      entityId: normalizeEntityId(parsed.entityId),
      pairId: parsed.pairId,
      value,
    });
  }

  return docs;
};

const loadEntityCoreDocAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  liveStateReadable = true,
): Promise<StorageEntityCoreDoc | null> => {
  const normalized = normalizeEntityId(entityId);
  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    return readJsonOrNull<StorageEntityCoreDoc>(db, keyLiveEntity(normalized));
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  let core = baseSnapshotHeight > 0
    ? await readJsonOrNull<StorageEntityCoreDoc>(db, keySnapshotEntity(baseSnapshotHeight, normalized))
    : null;
  for (let cursor = baseSnapshotHeight + 1; cursor <= targetHeight; cursor += 1) {
    const diff = await readRequiredDiff(db, cursor, `entity:${normalized}`);
    for (const ref of diff.dels) {
      if (ref.family === 'entity' && normalizeEntityId(ref.entityId) === normalized) core = null;
    }
    for (const doc of diff.puts) {
      if (doc.family === 'entity' && normalizeEntityId(doc.entityId) === normalized) core = doc.value;
    }
  }
  return core;
};

const collectHistoricalAccountOverlay = async (
  db: RuntimeDbLike,
  entityId: string,
  fromHeightExclusive: number,
  toHeight: number,
): Promise<Map<string, StorageAccountDoc | null>> => {
  const normalized = normalizeEntityId(entityId);
  const overlay = new Map<string, StorageAccountDoc | null>();
  for (let height = fromHeightExclusive + 1; height <= toHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, `accounts:${normalized}`);
    for (const ref of diff.dels) {
      if (ref.family === 'account' && normalizeEntityId(ref.entityId) === normalized) {
        overlay.set(normalizeEntityId(ref.counterpartyId), null);
      }
    }
    for (const doc of diff.puts) {
      if (doc.family === 'account' && normalizeEntityId(doc.entityId) === normalized) {
        overlay.set(normalizeEntityId(doc.counterpartyId), doc.value);
      }
    }
  }
  return overlay;
};

const loadAccountDocPageAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  query?: StoragePageQuery,
  liveStateReadable = true,
): Promise<StorageAccountDocPage | null> => {
  const normalized = normalizeEntityId(entityId);
  const limit = readPageLimit(query);
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const cursor = readAccountCursor(query);

  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    const prefix = keyLiveAccountPrefix(normalized);
    return listAccountPageFromKeyspace({
      db,
      prefix,
      cursorKey: cursor ? keyLiveAccount(normalized, cursor) : undefined,
      parseKey: parseLiveAccountKey,
      cursor,
      limit,
      direction,
    });
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const overlay = await collectHistoricalAccountOverlay(db, normalized, baseSnapshotHeight, targetHeight);
  if (baseSnapshotHeight <= 0) {
    const candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }> = [];
    const seen = new Set<string>();
    for (const [counterpartyId, doc] of overlay.entries()) {
      if (!doc || !isAfterAccountCursor(counterpartyId, cursor, direction)) continue;
      pushAccountCandidate(candidates, seen, counterpartyId, doc, limit, direction);
    }
    return accountPageFromCandidates(candidates, limit);
  }
  const prefix = keySnapshotAccountPrefix(baseSnapshotHeight, normalized);
  return listAccountPageFromKeyspace({
    db,
    prefix,
    cursorKey: cursor ? keySnapshotAccountCursor(baseSnapshotHeight, normalized, cursor) : undefined,
    parseKey: parseSnapshotAccountKey,
    cursor,
    limit,
    direction,
    overlay,
  });
};

const loadAccountDocAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  liveStateReadable = true,
): Promise<StorageAccountDoc | null> => {
  const normalized = normalizeEntityId(entityId);
  const counterparty = normalizeEntityId(counterpartyId);

  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    const raw = await readRawOrNull(db, keyLiveAccount(normalized, counterparty));
    if (!raw) return null;
    await assertLiveDocHash({
      db,
      ref: { family: 'account', entityId: normalized, counterpartyId: counterparty },
      raw,
      enabled: storageVerifyDocHashesEnabled(),
    });
    return decodeBuffer<StorageAccountDoc>(raw);
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  let doc = baseSnapshotHeight > 0
    ? await readJsonOrNull<StorageAccountDoc>(
        db,
        keySnapshotAccountCursor(baseSnapshotHeight, normalized, counterparty),
      )
    : null;
  for (let height = baseSnapshotHeight + 1; height <= targetHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, `account:${normalized}:${counterparty}`);
    for (const ref of diff.dels) {
      if (
        ref.family === 'account' &&
        normalizeEntityId(ref.entityId) === normalized &&
        normalizeEntityId(ref.counterpartyId) === counterparty
      ) {
        doc = null;
      }
    }
    for (const item of diff.puts) {
      if (
        item.family === 'account' &&
        normalizeEntityId(item.entityId) === normalized &&
        normalizeEntityId(item.counterpartyId) === counterparty
      ) {
        doc = item.value;
      }
    }
  }
  return doc;
};

const readBookCursor = (query?: StoragePageQuery): string =>
  String(query?.cursor || '').trim();

const compareBookPairKeyOrder = (left: string, right: string): number => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return leftBytes.length < rightBytes.length ? -1 : 1;
  return Buffer.compare(leftBytes, rightBytes);
};

const isAfterBookCursor = (
  pairId: string,
  cursor: string,
  direction: 'asc' | 'desc',
): boolean => {
  if (!cursor) return true;
  const order = compareBookPairKeyOrder(pairId, cursor);
  return direction === 'desc' ? order < 0 : order > 0;
};

const pushBookCandidate = (
  candidates: Array<{ pairId: string; book: BookState }>,
  seen: Set<string>,
  pairId: string,
  book: BookState,
  limit: number,
  direction: 'asc' | 'desc',
): void => {
  if (seen.has(pairId)) return;
  seen.add(pairId);
  const compare = (left: string, right: string): number =>
    direction === 'desc' ? compareBookPairKeyOrder(right, left) : compareBookPairKeyOrder(left, right);
  let insertAt = candidates.length;
  while (insertAt > 0 && compare(pairId, candidates[insertAt - 1]!.pairId) < 0) {
    insertAt -= 1;
  }
  candidates.splice(insertAt, 0, { pairId, book });
  if (candidates.length > limit + 1) {
    const dropped = candidates.pop();
    if (dropped) seen.delete(dropped.pairId);
  }
};

const bookPageFromCandidates = (
  candidates: Array<{ pairId: string; book: BookState }>,
  limit: number,
): StorageBookDocPage => {
  const visible = candidates.slice(0, limit);
  return {
    items: visible.map((entry) => ({ pairId: entry.pairId, book: entry.book })),
    nextCursor: candidates.length > limit ? visible[visible.length - 1]?.pairId ?? null : null,
  };
};

const listBookPageFromKeyspace = async (options: {
  db: RuntimeDbLike;
  prefix: Buffer;
  cursorKey?: Buffer | undefined;
  parseKey: (key: Buffer) => { pairId: string };
  cursor: string;
  limit: number;
  direction: 'asc' | 'desc';
  overlay?: Map<string, BookState | null>;
}): Promise<StorageBookDocPage | null> => {
  const { db, prefix, parseKey, cursor, limit, direction, overlay } = options;
  if (typeof db.keys !== 'function') return null;
  const candidates: Array<{ pairId: string; book: BookState }> = [];
  const seen = new Set<string>();

  for (const [pairId, book] of overlay?.entries?.() ?? []) {
    if (!book || !isAfterBookCursor(pairId, cursor, direction)) continue;
    pushBookCandidate(candidates, seen, pairId, book, limit, direction);
  }

  const upperBound = prefixUpperBound(prefix);
  const range = direction === 'asc'
    ? (upperBound ? { gte: options.cursorKey ?? prefix, lt: upperBound } : { gte: options.cursorKey ?? prefix })
    : (upperBound
        ? { gte: prefix, lt: options.cursorKey ?? upperBound, reverse: true }
        : { prefix, reverse: true });
  for await (const key of iterateKeys(db, range)) {
    const { pairId } = parseKey(key);
    if (!isAfterBookCursor(pairId, cursor, direction)) continue;
    if (overlay?.has(pairId)) continue;
    const book = decodeBuffer<BookState>(await db.get(key));
    pushBookCandidate(candidates, seen, pairId, book, limit, direction);
    const worst = candidates[candidates.length - 1]?.pairId;
    if (!worst || candidates.length <= limit) continue;
    const order = compareBookPairKeyOrder(pairId, worst);
    if (direction === 'asc' && order >= 0) break;
    if (direction === 'desc' && order <= 0) break;
  }

  return bookPageFromCandidates(candidates, limit);
};

const loadBookDocPageAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  query?: StoragePageQuery,
  liveStateReadable = true,
): Promise<StorageBookDocPage> => {
  const normalized = normalizeEntityId(entityId);
  const limit = readPageLimit(query);
  const cursor = readBookCursor(query);
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';

  if (liveStateReadable && targetHeight === latestMaterializedHeight) {
    const page = await listBookPageFromKeyspace({
      db,
      prefix: keyLiveBookPrefix(normalized),
      cursorKey: cursor ? keyLiveBook(normalized, cursor) : undefined,
      parseKey: (key) => parseLiveBookKey(key),
      cursor,
      limit,
      direction,
    });
    if (page) return page;
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const overlay = new Map<string, BookState | null>();
  for (let height = baseSnapshotHeight + 1; height <= targetHeight; height += 1) {
    const diff = await readRequiredDiff(db, height, `books:${normalized}`);
    for (const ref of diff.dels) {
      if (ref.family === 'book' && normalizeEntityId(ref.entityId) === normalized) overlay.set(ref.pairId, null);
    }
    for (const doc of diff.puts) {
      if (doc.family === 'book' && normalizeEntityId(doc.entityId) === normalized) overlay.set(doc.pairId, doc.value);
    }
  }

  if (baseSnapshotHeight > 0) {
    const page = await listBookPageFromKeyspace({
      db,
      prefix: keySnapshotBookPrefix(baseSnapshotHeight, normalized),
      cursorKey: cursor ? keySnapshotBookCursor(baseSnapshotHeight, normalized, cursor) : undefined,
      parseKey: (key) => parseLiveBookKey(key, 9),
      cursor,
      limit,
      direction,
      overlay,
    });
    if (page) return page;
  }

  const candidates: Array<{ pairId: string; book: BookState }> = [];
  const seen = new Set<string>();
  for (const [pairId, book] of overlay.entries()) {
    if (!book || !isAfterBookCursor(pairId, cursor, direction)) continue;
    pushBookCandidate(candidates, seen, pairId, book, limit, direction);
  }
  return bookPageFromCandidates(candidates, limit);
};

export const loadEntityViewPageFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
  accountQuery?: StoragePageQuery;
  bookQuery?: StoragePageQuery;
  liveStateReadable?: boolean;
}): Promise<StorageEntityViewPage | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head) return null;
  const targetHeight = Math.min(options.height ?? head.latestHeight, head.latestHeight);
  const entityId = normalizeEntityId(options.entityId);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );

  const liveStateReadable = options.liveStateReadable !== false;
  const core = await loadEntityCoreDocAtHeight(db, entityId, targetHeight, latestMaterializedHeight, liveStateReadable);
  if (!core) return null;
  const accounts = await loadAccountDocPageAtHeight(
    db,
    entityId,
    targetHeight,
    latestMaterializedHeight,
    options.accountQuery,
    liveStateReadable,
  );
  if (!accounts) return null;
  const books = await loadBookDocPageAtHeight(
    db,
    entityId,
    targetHeight,
    latestMaterializedHeight,
    options.bookQuery,
    liveStateReadable,
  );
  return { core, accounts, books };
};

export const loadEntityAccountDocFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  counterpartyId: string;
  height?: number;
  liveStateReadable?: boolean;
}): Promise<StorageAccountDoc | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head) return null;
  const targetHeight = Math.min(options.height ?? head.latestHeight, head.latestHeight);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );
  return loadAccountDocAtHeight(
    db,
    options.entityId,
    options.counterpartyId,
    targetHeight,
    latestMaterializedHeight,
    options.liveStateReadable !== false,
  );
};

export const loadEntityStateFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
  liveStateReadable?: boolean;
}): Promise<EntityState | null> => {
  const opened = await options.tryOpenDb(options.env);
  if (!opened) return null;
  const db = options.getRuntimeDb(options.env);
  const head = await readJsonOrNull<StorageHead>(db, KEY_HEAD);
  if (!head) return null;
  const targetHeight = Math.min(options.height ?? head.latestHeight, head.latestHeight);
  const entityId = normalizeEntityId(options.entityId);
  const latestMaterializedHeight = Math.max(
    0,
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
  );

  if (options.liveStateReadable !== false && targetHeight === latestMaterializedHeight) {
    const verifyDocHashes = storageVerifyDocHashesEnabled();
    const verifyMerkleMode = storageVerifyMerkleMode();
    const entityRaw = await readRawOrNull(db, keyLiveEntity(entityId));
    if (!entityRaw) return null;
    await assertLiveDocHash({
      db,
      ref: { family: 'entity', entityId },
      raw: entityRaw,
      enabled: verifyDocHashes,
    });
    const entityCore = decodeBuffer<StorageEntityCoreDoc>(entityRaw);
    if (!entityCore) return null;
    const accounts = new Map<string, StorageAccountDoc>();
    for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix(entityId) })) {
      const parsed = parseLiveAccountKey(key);
      const raw = await db.get(key);
      await assertLiveDocHash({
        db,
        ref: { family: 'account', entityId: parsed.entityId, counterpartyId: parsed.counterpartyId },
        raw,
        enabled: verifyDocHashes,
      });
      const doc = decodeBuffer<StorageAccountDoc>(raw);
      accounts.set(parsed.counterpartyId, doc);
    }
    const books = new Map<string, BookState>();
    for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix(entityId) })) {
      const parsed = parseLiveBookKey(key);
      const raw = await db.get(key);
      await assertLiveDocHash({
        db,
        ref: { family: 'book', entityId: parsed.entityId, pairId: parsed.pairId },
        raw,
        enabled: verifyDocHashes,
      });
      books.set(parsed.pairId, decodeBuffer<BookState>(raw));
    }
    await assertLiveMerkleIntegrity(db, entityId, verifyMerkleMode);
    return hydrateEntityStateFromStorage({ core: entityCore, accounts, books });
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  const docs = baseSnapshotHeight > 0
    ? await loadSnapshotDocsForEntity(db, baseSnapshotHeight, entityId)
    : new Map<string, StorageDoc>();

  let cursor = baseSnapshotHeight + 1;
  while (cursor <= targetHeight) {
    const diff = await readRequiredDiff(db, cursor, `entity-state:${entityId}`);
    applyDocs(docs, diff.puts, diff.dels, entityId);
    cursor += 1;
  }

  const core = docs.get(`e:${entityId}`) as Extract<StorageDoc, { family: 'entity' }> | undefined;
  if (!core) return null;
  const accounts = new Map<string, StorageAccountDoc>();
  const books = new Map<string, BookState>();
  for (const doc of docs.values()) {
    if (doc.family === 'account' && normalizeEntityId(doc.entityId) === entityId) {
      accounts.set(doc.counterpartyId, doc.value);
    } else if (doc.family === 'book' && normalizeEntityId(doc.entityId) === entityId) {
      books.set(doc.pairId, doc.value);
    }
  }

  return hydrateEntityStateFromStorage({ core: core.value, accounts, books });
};
