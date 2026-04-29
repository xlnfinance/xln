import type { BookState } from '../orderbook';
import type { EntityState, Env } from '../types';
import { decodeBuffer } from './codec';
import { docRefKey, docValueKey } from './doc-refs';
import {
  KEY_HEAD,
  KEY_LIVE_ENTITY,
  decodeEntityId,
  keyDiff,
  keyFrame,
  keyLiveAccountPrefix,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveReplicaMeta,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  normalizeEntityId,
  parseLiveAccountKey,
  parseLiveBookKey,
} from './keys';
import { listKeys, readJsonOrNull } from './level';
import { listSnapshotHeights } from './lifecycle';
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
  StorageReplicaMeta,
} from './types';

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

export const findStorageLatestSnapshotAtOrBelow = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  return findLatestSnapshotAtOrBelow(db, height);
};

export const listStorageLiveEntityIds = async (db: RuntimeDbLike): Promise<string[]> => {
  const keys = await listKeys(db, Buffer.from([KEY_LIVE_ENTITY]));
  return keys.map((key) => decodeEntityId(key.subarray(1, 33)));
};

export const listStorageSnapshotEntityIds = async (
  db: RuntimeDbLike,
  height: number,
): Promise<string[]> => {
  const targetHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 0;
  if (targetHeight <= 0) return [];
  const keys = await listKeys(db, keySnapshotEntityPrefix(targetHeight));
  return keys.map((key) => decodeEntityId(key.subarray(9, 41)));
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

  const accountKeys = await listKeys(db, keySnapshotAccountPrefix(snapshotHeight, entityId));
  for (const key of accountKeys) {
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

  const bookKeys = await listKeys(db, keySnapshotBookPrefix(snapshotHeight, entityId));
  for (const key of bookKeys) {
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
    Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? head.latestHeight ?? 0)),
  );

  if (targetHeight === latestMaterializedHeight) {
    const entityCore = await readJsonOrNull<StorageEntityCoreDoc>(db, keyLiveEntity(entityId));
    if (!entityCore) return null;
    const accounts = new Map<string, StorageAccountDoc>();
    for (const key of await listKeys(db, keyLiveAccountPrefix(entityId))) {
      const parsed = parseLiveAccountKey(key);
      const doc = decodeBuffer<StorageAccountDoc>(await db.get(key));
      accounts.set(parsed.counterpartyId, doc);
    }
    const books = new Map<string, BookState>();
    for (const key of await listKeys(db, keyLiveBookPrefix(entityId))) {
      const parsed = parseLiveBookKey(key);
      books.set(parsed.pairId, decodeBuffer<BookState>(await db.get(key)));
    }
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
