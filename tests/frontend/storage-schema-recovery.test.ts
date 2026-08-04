import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { parseStorageSchemaMismatch } from '../../frontend/src/lib/utils/storageSchemaRecovery';

describe('storage schema recovery UX', () => {
  test('recognizes a wrapped durable storage schema mismatch', () => {
    expect(parseStorageSchemaMismatch(
      '[VaultStore] Strict restore failed for 0x1234567890: ' +
        'StorageSchemaMismatchError: STORAGE_SCHEMA_MISMATCH:' +
        'stored=1:current=2:boundary=storage-head',
    )).toEqual({ storedVersion: 1, currentVersion: 2 });
  });

  test('does not offer schema recovery for unrelated runtime failures', () => {
    expect(parseStorageSchemaMismatch('RUNTIME_INPUT_QUARANTINED')).toBeNull();
    expect(parseStorageSchemaMismatch(new Error('STORAGE_SCHEMA_INVALID:stored=oops'))).toBeNull();
  });

});
