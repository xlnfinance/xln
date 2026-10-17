import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { parseStorageSchemaMismatch } from '../../../frontend/src/lib/utils/recovery/storageSchemaRecovery';

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

  test('old testnet schemas expose rejection and reset without a backup-rescue reader', () => {
    const vault = readFileSync('frontend/src/lib/stores/vault/vaultStore.ts', 'utf8');
    const layout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');
    expect(vault).not.toContain('recoverSchemaMismatchedRuntimesFromConfiguredBackups');
    expect(vault).toContain('VAULT_OBSOLETE_PLAINTEXT_PROFILE:');
    expect(vault).toContain('async restoreRuntimeFromRecoveryCandidate(');
    expect(layout).toContain('parseStorageSchemaMismatch($error)');
    expect(layout).toContain('Obsolete testnet data rejected');
    expect(layout).not.toContain('data-testid="storage-schema-recover"');
    expect(layout).toContain('data-testid="storage-schema-reset"');
  });
});
