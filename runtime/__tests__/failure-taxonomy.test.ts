import { describe, expect, test } from 'bun:test';

import {
  buildRuntimeHealthFailures,
  classifyRuntimeHealthDegradedReason,
  classifyRuntimeImportReadinessReason,
  classifyRuntimeFaucetFailure,
  classifyRuntimeTransportFailure,
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

  test('classifies transport failures without parsing at callers', () => {
    expect(classifyRuntimeTransportFailure('NO_HEALTHY_HUB_API_AVAILABLE')).toMatchObject({
      category: 'TransientRace',
      code: 'NO_HEALTHY_HUB_API_AVAILABLE',
      retryable: true,
      fatal: false,
    });
    expect(classifyRuntimeTransportFailure('RPC_UPSTREAM_NOT_CONFIGURED')).toMatchObject({
      category: 'Contradiction',
      code: 'RPC_UPSTREAM_NOT_CONFIGURED',
      retryable: false,
      fatal: true,
    });
  });

  test('classifies faucet failures by retry semantics', () => {
    expect(classifyRuntimeFaucetFailure('FAUCET_ACCOUNT_NOT_OPEN')).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'FAUCET_ACCOUNT_NOT_OPEN',
      retryable: false,
      fatal: false,
    });
    expect(classifyRuntimeFaucetFailure('FAUCET_RUNTIME_REQUIRED')).toMatchObject({
      category: 'TransientRace',
      code: 'FAUCET_RUNTIME_REQUIRED',
      retryable: true,
      fatal: false,
    });
    expect(classifyRuntimeFaucetFailure('FAUCET_INVALID_USER_ENTITY_ID')).toMatchObject({
      category: 'Contradiction',
      code: 'FAUCET_INVALID_USER_ENTITY_ID',
      retryable: false,
      fatal: true,
    });
    expect(classifyRuntimeFaucetFailure('FAUCET_HUB_INSUFFICIENT_RESERVES')).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'FAUCET_HUB_INSUFFICIENT_RESERVES',
      retryable: false,
      fatal: false,
    });
    expect(classifyRuntimeFaucetFailure('FAUCET_RESERVE_EVENT_MISSING')).toMatchObject({
      category: 'Contradiction',
      code: 'FAUCET_RESERVE_EVENT_MISSING',
      retryable: false,
      fatal: true,
    });
  });
});
