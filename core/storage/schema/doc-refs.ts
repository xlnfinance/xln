import { toEntityId } from '../../protocol/identity';
import { keyLiveAccount, keyLiveBook, keyLiveEntity } from '../keys';
import type { StorageDocRef } from '../types';

export const docRefKey = (ref: StorageDocRef): string => {
  if (ref.family === 'entity') return `e:${toEntityId(ref.entityId)}`;
  if (ref.family === 'account') return `a:${toEntityId(ref.entityId)}:${toEntityId(ref.counterpartyId)}`;
  return `b:${toEntityId(ref.entityId)}:${ref.pairId}`;
};

export const liveKeyForRef = (ref: StorageDocRef): Buffer => {
  if (ref.family === 'entity') return keyLiveEntity(ref.entityId);
  if (ref.family === 'account') return keyLiveAccount(ref.entityId, ref.counterpartyId);
  return keyLiveBook(ref.entityId, ref.pairId);
};
