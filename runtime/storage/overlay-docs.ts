import { type RuntimeOverlayRecord, type Env } from '../types';
import { docRefKey } from './doc-refs';
import { keyDiff, normalizeEntityId } from './keys';
import { readJsonOrNull } from './level';
import { mergeStorageOverlayRecords, storageOverlayRecordKey } from './overlay';
import { projectAccountDoc, projectEntityCoreDoc } from './projections';
import { buildReplicaLookup, findReplicaForEntity } from './replicas';
import type {
  RuntimeDbLike,
  StorageAccountRef,
  StorageBookRef,
  StorageDiffRecord,
  StorageDoc,
  StorageDocRef,
  StorageOverlayRefs,
} from './types';

const addAccountRef = (target: Map<string, StorageAccountRef>, entityId: string, counterpartyId: string): void => {
  if (!entityId || !counterpartyId) return;
  const ref: StorageDocRef = { family: 'account', entityId: normalizeEntityId(entityId), counterpartyId: normalizeEntityId(counterpartyId) };
  target.set(docRefKey(ref), ref);
};

const addBookRef = (target: Map<string, StorageBookRef>, entityId: string, pairId: string): void => {
  const normalizedEntityId = normalizeEntityId(entityId);
  const normalizedPairId = String(pairId || '').trim();
  if (!normalizedEntityId || !normalizedPairId) return;
  const ref: StorageBookRef = {
    family: 'book',
    entityId: normalizedEntityId,
    pairId: normalizedPairId,
  };
  target.set(docRefKey(ref), ref);
};

export const mergeOverlayRecordsIntoEnv = (
  env: Env,
  records: readonly RuntimeOverlayRecord[],
): RuntimeOverlayRecord[] => {
  env.overlay = mergeStorageOverlayRecords(env.overlay, records);
  return env.overlay.map((record) => ({ ...record }));
};

export const overlayRecordsFromDocs = (
  puts: readonly StorageDoc[] | undefined,
  dels: readonly StorageDocRef[] | undefined,
): RuntimeOverlayRecord[] => {
  const records = new Map<string, RuntimeOverlayRecord>();
  for (const doc of puts ?? []) {
    const entityId = normalizeEntityId(doc.entityId);
    if (!entityId) continue;
    const record: RuntimeOverlayRecord = doc.family === 'account'
      ? { family: 'account', entityId, counterpartyId: normalizeEntityId(doc.counterpartyId) }
      : doc.family === 'book'
        ? { family: 'book', entityId, pairId: String(doc.pairId || '').trim() }
        : { family: 'entity', entityId };
    records.set(storageOverlayRecordKey(record), record);
  }
  for (const ref of dels ?? []) {
    if (ref.family !== 'book') {
      throw new Error(`STORAGE_OVERLAY_DELETE_UNSUPPORTED: family=${ref.family}`);
    }
    const entityId = normalizeEntityId(ref.entityId);
    if (!entityId) continue;
    const record: RuntimeOverlayRecord = { family: 'book', entityId, pairId: String(ref.pairId || '').trim(), deleted: true };
    records.set(storageOverlayRecordKey(record), record);
  }
  return Array.from(records.values());
};

export const readStorageOverlayRecordsFromDiffs = async (
  db: RuntimeDbLike,
  startHeight: number,
  targetHeight: number,
): Promise<RuntimeOverlayRecord[]> => {
  let records: RuntimeOverlayRecord[] = [];
  const start = Math.max(1, Math.floor(startHeight));
  const end = Math.floor(targetHeight);
  for (let height = start; height <= end; height += 1) {
    const diff = await readJsonOrNull<StorageDiffRecord>(db, keyDiff(height));
    if (!diff) throw new Error(`STORAGE_DIFF_MISSING: height=${height} scope=overlay`);
    records = mergeStorageOverlayRecords(records, overlayRecordsFromDocs(diff.puts, diff.dels));
  }
  return records;
};

export const buildBookDeletionsFromOverlay = (
  records: readonly RuntimeOverlayRecord[] | undefined,
): StorageDocRef[] => {
  const dels = new Map<string, StorageBookRef>();
  for (const record of records ?? []) {
    if (record.family !== 'book' || record.deleted !== true) continue;
    const entityId = normalizeEntityId(record.entityId);
    const pairId = String(record.pairId || '').trim();
    if (!entityId || !pairId) continue;
    const ref: StorageBookRef = { family: 'book', entityId, pairId };
    dels.set(docRefKey(ref), ref);
  }
  return Array.from(dels.values());
};

export const storageRefsFromOverlay = (
  records: readonly RuntimeOverlayRecord[] | undefined,
): StorageOverlayRefs => {
  const touchedEntities = new Set<string>();
  const touchedAccounts = new Map<string, StorageAccountRef>();
  const touchedBooks = new Map<string, StorageBookRef>();
  const touchedBookEntities = new Set<string>();

  for (const record of records ?? []) {
    if (record.family === 'entity') {
      const entityId = normalizeEntityId(record.entityId);
      if (entityId) touchedEntities.add(entityId);
      continue;
    }

    if (record.family === 'account') {
      const entityId = normalizeEntityId(record.entityId);
      const counterpartyId = normalizeEntityId(record.counterpartyId);
      if (!entityId || !counterpartyId) continue;
      touchedEntities.add(entityId);
      addAccountRef(touchedAccounts, entityId, counterpartyId);
      continue;
    }

    if (record.family === 'book') {
      const entityId = normalizeEntityId(record.entityId);
      const pairId = String(record.pairId || '').trim();
      if (!entityId || !pairId) continue;
      touchedEntities.add(entityId);
      touchedBookEntities.add(entityId);
      if (record.deleted === true) continue;
      addBookRef(touchedBooks, entityId, pairId);
    }
  }

  return { touchedEntities, touchedAccounts, touchedBooks, touchedBookEntities };
};

export const buildDocPuts = (
  env: Env,
  touched: StorageOverlayRefs,
  replicaLookup = buildReplicaLookup(env),
): StorageDoc[] => {
  const puts: StorageDoc[] = [];

  for (const entityId of touched.touchedEntities) {
    const replica = findReplicaForEntity(env, entityId, replicaLookup);
    if (!replica) continue;
    puts.push({
      family: 'entity',
      entityId,
      value: projectEntityCoreDoc(replica.state, replica.replica),
    });
  }

  for (const ref of touched.touchedAccounts.values()) {
    const replica = findReplicaForEntity(env, ref.entityId, replicaLookup);
    const account = replica?.state.accounts.get(ref.counterpartyId);
    if (!replica || !account) continue;
    puts.push({
      family: 'account',
      entityId: ref.entityId,
      counterpartyId: ref.counterpartyId,
      value: projectAccountDoc(account),
    });
  }

  for (const ref of touched.touchedBooks.values()) {
    const replica = findReplicaForEntity(env, ref.entityId, replicaLookup);
    const book = replica?.state.orderbookExt?.books?.get(ref.pairId);
    if (!book) continue;
    puts.push({ family: 'book', entityId: ref.entityId, pairId: ref.pairId, value: book });
  }

  return puts;
};
