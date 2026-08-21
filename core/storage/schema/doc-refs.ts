import { keyLiveAccount, keyLiveBook, keyLiveEntity, normalizeEntityId } from '../keys';
import type { StorageDoc, StorageDocRef } from '../types';

export const docRefKey = (ref: StorageDocRef): string => {
  if (ref.family === 'entity') return `e:${normalizeEntityId(ref.entityId)}`;
  if (ref.family === 'account') return `a:${normalizeEntityId(ref.entityId)}:${normalizeEntityId(ref.counterpartyId)}`;
  return `b:${normalizeEntityId(ref.entityId)}:${ref.pairId}`;
};

export const liveKeyForDoc = (doc: StorageDoc): Buffer => {
  if (doc.family === 'entity') return keyLiveEntity(doc.entityId);
  if (doc.family === 'account') return keyLiveAccount(doc.entityId, doc.counterpartyId);
  return keyLiveBook(doc.entityId, doc.pairId);
};

export const liveKeyForRef = (ref: StorageDocRef): Buffer => {
  if (ref.family === 'entity') return keyLiveEntity(ref.entityId);
  if (ref.family === 'account') return keyLiveAccount(ref.entityId, ref.counterpartyId);
  return keyLiveBook(ref.entityId, ref.pairId);
};
