import { type RuntimeOverlayRecord } from '../../types/account';
import { type RuntimeReplica } from '../../runtime/types';
import { docRefKey } from './doc-refs';
import { normalizeEntityId } from '../keys';
import { storageOverlayRecordKey } from '../../protocol/state/overlay';
import { projectAccountDoc } from '../read/projections';
import type { EntityState } from '../../entity/types';
import { buildReplicaLookup, findReplicaForEntity } from '../replica/replicas';
import type {
  StorageAccountRef,
  StorageBookRef,
  StorageDoc,
  StorageDocRef,
  StorageOverlayRefs,
} from '../types';

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
  env: RuntimeReplica,
  records: readonly RuntimeOverlayRecord[],
): RuntimeOverlayRecord[] => {
  const overlay = env.overlay instanceof Map ? env.overlay : new Map<string, RuntimeOverlayRecord>();
  for (const record of records) overlay.set(storageOverlayRecordKey(record), { ...record });
  env.overlay = overlay;
  return Array.from(overlay.values(), record => ({ ...record }));
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
  env: RuntimeReplica,
  touched: StorageOverlayRefs,
  replicaLookup = buildReplicaLookup(env),
): StorageDoc[] => {
  const puts: StorageDoc[] = [];

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

/** Live Entity checkpoints consume the exact RAM roots, never a flat document clone. */
export const buildEntityStatePuts = (
  env: RuntimeReplica,
  touched: StorageOverlayRefs,
  replicaLookup = buildReplicaLookup(env),
): EntityState[] => [...touched.touchedEntities]
  .map(entityId => findReplicaForEntity(env, entityId, replicaLookup)?.state)
  .filter((state): state is EntityState => state !== undefined);
