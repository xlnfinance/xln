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

  test('offers authenticated recovery before an explicit destructive reset', () => {
    const vault = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
    const layout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');
    const recoveryStart = vault.indexOf('async recoverSchemaMismatchedRuntimesFromConfiguredBackups()');
    const recoveryEnd = vault.indexOf('\n  syncRuntime(', recoveryStart);
    expect(recoveryStart).toBeGreaterThan(0);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    const recoverySource = vault.slice(recoveryStart, recoveryEnd);
    expect(recoverySource.indexOf('discoverRuntimeRecoveryCandidates('))
      .toBeLessThan(recoverySource.indexOf('restoreRuntimeFromRecoveryCandidate('));
    expect(recoverySource).not.toContain('clearDB(');
    expect(recoverySource).not.toContain('resetRuntimePersistence(');

    expect(layout).toContain('parseStorageSchemaMismatch($error)');
    expect(layout).toContain('vaultOperations.recoverSchemaMismatchedRuntimesFromConfiguredBackups()');
    expect(layout).toContain('data-testid="storage-schema-recover"');
    expect(layout).toContain('data-testid="storage-schema-reset"');
  });
});
