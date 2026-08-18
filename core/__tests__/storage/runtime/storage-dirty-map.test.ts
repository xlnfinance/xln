import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import {
  applyRuntimeStorageChanges,
  dropOverlay,
} from '../../../runtime/observability/env-events';
import { storageOverlayRecordKey } from '../../../protocol/state/overlay';

test('storage dirty map keeps one latest operation per key and clears exact committed keys', () => {
  const env = createEmptyEnv('storage-dirty-map');
  const entityId = `0x${'11'.repeat(32)}`;
  const otherEntityId = `0x${'22'.repeat(32)}`;
  const setBook = { family: 'book', entityId, pairId: '1/2' } as const;
  const deleteBook = { ...setBook, deleted: true } as const;
  const entity = { family: 'entity', entityId: otherEntityId } as const;

  applyRuntimeStorageChanges(env, [setBook, deleteBook, entity]);

  expect(env.overlay?.size).toBe(2);
  expect(env.overlay?.get(storageOverlayRecordKey(setBook))).toEqual(deleteBook);
  expect(env.infrastructure?.currentStorageOverlayMarks?.size).toBe(2);

  dropOverlay(env, [storageOverlayRecordKey(deleteBook)]);

  expect(env.overlay?.size).toBe(1);
  expect(env.overlay?.get(storageOverlayRecordKey(entity))).toEqual(entity);
});
