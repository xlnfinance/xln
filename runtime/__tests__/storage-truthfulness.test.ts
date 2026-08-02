import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import { requireStorageDbOpen } from '../storage/availability';
import { readAccountFrameHistory } from '../storage/queries/history';
import { loadEntityStateFromStorage } from '../storage/read';

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
  await expect(readAccountFrameHistory(
    {
      tryOpenRuntimeWalDb: async () => false,
      getRuntimeWalDb: () => {
        throw new Error('TEST_DB_HANDLE_MUST_NOT_BE_READ');
      },
    },
    env,
    `0x${'22'.repeat(32)}`,
    `0x${'33'.repeat(32)}`,
  )).rejects.toThrow('STORAGE_DB_UNAVAILABLE:runtime-wal:certified-account-frames');
});
