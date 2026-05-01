import type { BookState } from '../orderbook';
import type { EntityState, Env } from '../types';
import { ethers } from 'ethers';
import { decodeBuffer } from './codec';
import { docRefKey, docValueKey, keyLiveDocHash } from './doc-refs';
import {
  KEY_HEAD,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  hexBytes,
  keyDiff,
  keyFrame,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveEntityHash,
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
} from './keys';
import { iterateKeys, readJsonOrNull, readRawOrNull } from './level';
import { listSnapshotHeights } from './lifecycle';
import {
  buildHexKeyedMerkle,
  computeRadixMerkleBranchHash,
  computeRadixMerkleLeafHash,
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

const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const storageVerifyDocHashesEnabled = (): boolean => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] ?? '' : '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

const storageVerifyMerkleMode = (): 'none' | 'shallow' | 'deep' => {
  const raw = String(typeof process !== 'undefined' ? process.env['XLN_STORAGE_VERIFY_MERKLE'] ?? '' : '')
    .trim()
    .toLowerCase();
  if (raw === 'deep') return 'deep';
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'shallow') return 'shallow';
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
  const expectedRaw = await readRawOrNull(options.db, keyLiveDocHash(options.ref));
  const key = docRefKey(options.ref);
  if (!expectedRaw) throw new Error(`STORAGE_DOC_HASH_MISSING: ${key}`);
  if (expectedRaw.byteLength !== 32) {
    throw new Error(`STORAGE_DOC_HASH_INVALID: ${key} bytes=${expectedRaw.byteLength}`);
  }
  const expected = `0x${Buffer.from(expectedRaw).toString('hex')}`;
  const actual = hashRawDocValue(options.raw);
  if (actual !== expected) {
    throw new Error(`STORAGE_DOC_HASH_MISMATCH: ${key} actual=${actual} expected=${expected}`);
  }
};

const assertLiveMerkleIntegrity = async (
  db: RuntimeDbLike,
  entityId: string,
  mode: 'none' | 'shallow' | 'deep',
): Promise<void> => {
  if (mode === 'none') return;
  const normalized = normalizeEntityId(entityId);
  const root = await readJsonOrNull<StorageMerkleRootDoc>(db, keyMerkleRoot(normalized, 'runtime-roots'));
  const entityHash = await readJsonOrNull<{ hash: string; cellCount?: number; cells?: unknown[] }>(db, keyLiveEntityHash(normalized));
  if (!root) throw new Error(`STORAGE_MERKLE_ROOT_MISSING: entity=${normalized}`);
  if (!entityHash) throw new Error(`STORAGE_ENTITY_HASH_DOC_MISSING: entity=${normalized}`);
  const expectedLeafCount = Number(entityHash.cellCount ?? entityHash.cells?.length ?? 0);
  if (root.rootHash !== entityHash.hash) {
    throw new Error(`STORAGE_MERKLE_ROOT_MISMATCH: entity=${normalized} actual=${root.rootHash} expected=${entityHash.hash}`);
  }
  if (root.leafCount !== expectedLeafCount) {
    throw new Error(`STORAGE_MERKLE_LEAF_COUNT_MISMATCH: entity=${normalized} actual=${root.leafCount} expected=${expectedLeafCount}`);
  }
  if (mode !== 'deep') return;

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
  const gte = options.cursorKey ?? prefix;
  const candidates: Array<{ counterpartyId: string; doc: StorageAccountDoc }> = [];
  const seen = new Set<string>();

  for (const [counterpartyId, doc] of overlay?.entries?.() ?? []) {
    if (!doc || !isAfterAccountCursor(counterpartyId, cursor, direction)) continue;
    pushAccountCandidate(candidates, seen, counterpartyId, doc, limit, direction);
  }

  const upperBound = prefixUpperBound(prefix);
  const range = direction === 'asc'
    ? (upperBound ? { gte, lt: upperBound } : { gte })
    : { prefix };
  for await (const key of iterateKeys(db, range)) {
    const { counterpartyId } = parseKey(key);
    const normalized = normalizeEntityId(counterpartyId);
    if (!isAfterAccountCursor(normalized, cursor, direction)) continue;
    if (overlay?.has(normalized)) continue;
    const doc = decodeBuffer<StorageAccountDoc>(await db.get(key));
    pushAccountCandidate(candidates, seen, normalized, doc, limit, direction);
    const worst = candidates[candidates.length - 1]?.counterpartyId;
    if (candidates.length > limit && worst && compareAscii(normalized, worst) >= 0) break;
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
): Promise<StorageEntityCoreDoc | null> => {
  const normalized = normalizeEntityId(entityId);
  if (targetHeight === latestMaterializedHeight) {
    return readJsonOrNull<StorageEntityCoreDoc>(db, keyLiveEntity(normalized));
  }

  const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
  let core = baseSnapshotHeight > 0
    ? await readJsonOrNull<StorageEntityCoreDoc>(db, keySnapshotEntity(baseSnapshotHeight, normalized))
    : null;
  for (let cursor = baseSnapshotHeight + 1; cursor <= targetHeight; cursor += 1) {
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(cursor));
    if (!diff) continue;
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
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(height));
    if (!diff) continue;
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
): Promise<StorageAccountDocPage | null> => {
  const normalized = normalizeEntityId(entityId);
  const limit = readPageLimit(query);
  const direction = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const cursor = readAccountCursor(query);

  if (targetHeight === latestMaterializedHeight) {
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
  if (baseSnapshotHeight <= 0) return null;
  const overlay = await collectHistoricalAccountOverlay(db, normalized, baseSnapshotHeight, targetHeight);
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

const bestBidTicks = (book: BookState): bigint | null => {
  const bucketId = book.bidBucketIdsDesc[0];
  if (bucketId === undefined) return null;
  const bucket = book.bidBuckets.get(bucketId.toString());
  return bucket?.pricesAsc.at(-1) ?? null;
};

const bestAskTicks = (book: BookState): bigint | null => {
  const bucketId = book.askBucketIdsAsc[0];
  if (bucketId === undefined) return null;
  const bucket = book.askBuckets.get(bucketId.toString());
  return bucket?.pricesAsc[0] ?? null;
};

const bookSpreadSortKey = (book: BookState): bigint | null => {
  const bid = bestBidTicks(book);
  const ask = bestAskTicks(book);
  if (bid === null || ask === null) return null;
  return ask >= bid ? ask - bid : 0n;
};

const compareBooksNearSpread = (
  left: [string, BookState],
  right: [string, BookState],
): number => {
  const leftSpread = bookSpreadSortKey(left[1]);
  const rightSpread = bookSpreadSortKey(right[1]);
  if (leftSpread !== null && rightSpread !== null && leftSpread !== rightSpread) {
    return leftSpread < rightSpread ? -1 : 1;
  }
  if (leftSpread !== null && rightSpread === null) return -1;
  if (leftSpread === null && rightSpread !== null) return 1;
  return compareAscii(String(left[0]), String(right[0]));
};

const bookPageFromMap = (
  books: Map<string, BookState>,
  query?: StoragePageQuery,
): StorageBookDocPage => {
  const limit = readPageLimit(query);
  const cursor = String(query?.cursor || '').trim();
  const ordered = Array.from(books.entries()).sort(compareBooksNearSpread);
  const startIndex = cursor ? ordered.findIndex(([pairId]) => pairId === cursor) + 1 : 0;
  const offset = Math.max(0, startIndex);
  const visible = ordered.slice(offset, offset + limit);
  return {
    items: visible.map(([pairId, book]) => ({ pairId, book })),
    nextCursor: offset + limit < ordered.length ? visible[visible.length - 1]?.[0] ?? null : null,
  };
};

const loadBookDocPageAtHeight = async (
  db: RuntimeDbLike,
  entityId: string,
  targetHeight: number,
  latestMaterializedHeight: number,
  query?: StoragePageQuery,
): Promise<StorageBookDocPage> => {
  const normalized = normalizeEntityId(entityId);
  const books = new Map<string, BookState>();

  if (targetHeight === latestMaterializedHeight) {
    for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix(normalized) })) {
      const parsed = parseLiveBookKey(key);
      books.set(parsed.pairId, decodeBuffer<BookState>(await db.get(key)));
    }
  } else {
    const baseSnapshotHeight = await findLatestSnapshotAtOrBelow(db, targetHeight);
    if (baseSnapshotHeight > 0) {
      for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(baseSnapshotHeight, normalized) })) {
        const parsed = parseLiveBookKey(key, 9);
        books.set(parsed.pairId, decodeBuffer<BookState>(await db.get(key)));
      }
    }
    for (let height = baseSnapshotHeight + 1; height <= targetHeight; height += 1) {
      const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(height));
      if (!diff) continue;
      for (const ref of diff.dels) {
        if (ref.family === 'book' && normalizeEntityId(ref.entityId) === normalized) books.delete(ref.pairId);
      }
      for (const doc of diff.puts) {
        if (doc.family === 'book' && normalizeEntityId(doc.entityId) === normalized) books.set(doc.pairId, doc.value);
      }
    }
  }

  return bookPageFromMap(books, query);
};

export const loadEntityViewPageFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
  accountQuery?: StoragePageQuery;
  bookQuery?: StoragePageQuery;
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

  const core = await loadEntityCoreDocAtHeight(db, entityId, targetHeight, latestMaterializedHeight);
  if (!core) return null;
  const accounts = await loadAccountDocPageAtHeight(
    db,
    entityId,
    targetHeight,
    latestMaterializedHeight,
    options.accountQuery,
  );
  if (!accounts) return null;
  const books = await loadBookDocPageAtHeight(
    db,
    entityId,
    targetHeight,
    latestMaterializedHeight,
    options.bookQuery,
  );
  return { core, accounts, books };
};

export const loadEntityStateFromStorage = async (options: {
  env: Env;
  tryOpenDb: (env: Env) => Promise<boolean>;
  getRuntimeDb: (env: Env) => RuntimeDbLike;
  entityId: string;
  height?: number;
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

  if (targetHeight === latestMaterializedHeight) {
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
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(cursor));
    if (diff) {
      applyDocs(docs, diff.puts, diff.dels, entityId);
    }
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
