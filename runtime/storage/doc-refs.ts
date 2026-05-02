import { keyLiveAccount, keyLiveBook, keyLiveEntity, normalizeEntityId } from './keys';
import type { StorageDoc, StorageDocRef } from './types';

export const docRefKey = (ref: StorageDocRef): string => {
  if (ref.family === 'entity') return `e:${normalizeEntityId(ref.entityId)}`;
  if (ref.family === 'account') return `a:${normalizeEntityId(ref.entityId)}:${normalizeEntityId(ref.counterpartyId)}`;
  return `b:${normalizeEntityId(ref.entityId)}:${ref.pairId}`;
};

export const docValueKey = (doc: StorageDoc): string => {
  if (doc.family === 'entity') return `e:${normalizeEntityId(doc.entityId)}`;
  if (doc.family === 'account') return `a:${normalizeEntityId(doc.entityId)}:${normalizeEntityId(doc.counterpartyId)}`;
  return `b:${normalizeEntityId(doc.entityId)}:${doc.pairId}`;
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

export const docRefForDoc = (doc: StorageDoc): StorageDocRef => {
  if (doc.family === 'entity') return { family: 'entity', entityId: doc.entityId };
  if (doc.family === 'account') {
    return { family: 'account', entityId: doc.entityId, counterpartyId: doc.counterpartyId };
  }
  return { family: 'book', entityId: doc.entityId, pairId: doc.pairId };
};

export const docRefCellKey = (ref: StorageDocRef): string => {
  if (ref.family === 'entity') return 'entity';
  if (ref.family === 'account') return `accounts/${normalizeEntityId(ref.counterpartyId)}`;
  return `books/${ref.pairId}`;
};
