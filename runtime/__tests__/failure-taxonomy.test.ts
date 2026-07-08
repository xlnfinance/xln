import { describe, expect, test } from 'bun:test';

import {
  buildRuntimeHealthFailures,
  classifyRuntimeHealthDegradedReason,
  classifyRuntimeImportReadinessReason,
} from '../failure-taxonomy';

describe('runtime failure taxonomy', () => {
  test('keeps runtime import readiness failures machine-readable', () => {
    expect(classifyRuntimeImportReadinessReason('NO_MANAGED_RUNTIME_IMPORTS')).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'NO_MANAGED_RUNTIME_IMPORTS',
      retryable: false,
      fatal: false,
    });
    expect(classifyRuntimeImportReadinessReason('INVALID_RUNTIME_IMPORT_MANIFEST:bad-token')).toMatchObject({
      category: 'Contradiction',
      code: 'INVALID_RUNTIME_IMPORT_MANIFEST',
      retryable: false,
      fatal: true,
    });
  });

  test('maps health degraded components to stable codes', () => {
    expect(classifyRuntimeHealthDegradedReason('bootstrapReserveTargets')).toMatchObject({
      category: 'TransientRace',
      code: 'BOOTSTRAP_RESERVE_TARGETS_NOT_READY',
      message: 'bootstrapReserveTargets',
      retryable: true,
      fatal: false,
    });
    expect(buildRuntimeHealthFailures(['storage', 'hubMesh']).map(failure => failure.code))
      .toEqual(['STORAGE_NOT_READY', 'HUB_MESH_NOT_READY']);
  });
});
