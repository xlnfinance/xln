import { expect, test } from 'bun:test';

import { createEmptyEnv, readPersistedAccountFrameHistory } from '../../../runtime';
import { requireStorageDbOpen } from '../../../storage/commit/availability';
import { loadEntityStateFromStorage } from '../../../storage/read/read';

test('storage availability distinguishes an unavailable handle from an empty database', async () => {
  await expect(requireStorageDbOpen(
    async () => false,
    'runtime-wal:test',
  )).rejects.toThrow('STORAGE_DB_UNAVAILABLE:runtime-wal:test');
});

test('authoritative Entity reads fail when storage cannot be opened', async () => {
  const env = createEmptyEnv('storage-truthfulness-entity-read');
  await expect(loadEntityStateFromStorage({
    env,
    tryOpenDb: async () => false,
    getRuntimeDb: () => {
      throw new Error('TEST_DB_HANDLE_MUST_NOT_BE_READ');
    },
    entityId: `0x${'11'.repeat(32)}`,
  })).rejects.toThrow('STORAGE_DB_UNAVAILABLE:entity-state');
});

test('Account history fails when its authoritative Runtime WAL is unavailable', async () => {
  const env = createEmptyEnv('storage-truthfulness-account-history');
  // A blocked WAL-open result belongs to Runtime infrastructure, not a query fixture.
  env.infrastructure = { ...env.infrastructure, runtimeWalDbOpenPromise: Promise.resolve(false) };
  await expect(readPersistedAccountFrameHistory(
    env,
    `0x${'22'.repeat(32)}`,
    `0x${'33'.repeat(32)}`,
  )).rejects.toThrow('STORAGE_DB_UNAVAILABLE:runtime-wal:read');
});
