import { describe, expect, test } from 'bun:test';

import {
  buildRuntimeHealthFailures,
  classifyRuntimeHealthDegradedReason,
  classifyRuntimeImportReadinessReason,
  classifyRuntimeFaucetFailure,
  classifyRuntimeBootstrapStageFailure,
  classifyRuntimeJBatchFailure,
  classifyRuntimeMarketMakerFailure,
  classifyRuntimeTransportFailure,
  isRuntimeFailureSignal,
} from '../protocol/failure-taxonomy';

describe('runtime failure taxonomy', () => {
  test('validates runtime failure signal shape', () => {
    const failure = classifyRuntimeTransportFailure('NO_HEALTHY_HUB_API_AVAILABLE', 'relay not ready');
    expect(isRuntimeFailureSignal(failure)).toBe(true);
    expect(isRuntimeFailureSignal({
      category: 'TransientRace',
      code: 'MISSING_MESSAGE',
      retryable: true,
      fatal: false,
    })).toBe(false);
    expect(isRuntimeFailureSignal({
      category: 'Unknown',
      code: 'UNKNOWN_CATEGORY',
      message: 'bad category',
      retryable: false,
      fatal: false,
    })).toBe(false);
    expect(isRuntimeFailureSignal({
      category: 'Contradiction',
      code: 'INCONSISTENT_FLAGS',
      message: 'bad flags',
      retryable: true,
      fatal: false,
    })).toBe(false);
  });

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

  test('classifies bootstrap stage failures without parsing stage reason at callers', () => {
    expect(classifyRuntimeBootstrapStageFailure('hub-mesh', 'blocked', 'Hub mesh is still converging')).toMatchObject({
      category: 'TransientRace',
      code: 'BOOTSTRAP_HUB_MESH_NOT_READY',
      message: 'Hub mesh is still converging',
      retryable: true,
      fatal: false,
    });
    expect(classifyRuntimeBootstrapStageFailure('ready-hash', 'active', 'Ready hash is not available yet')).toMatchObject({
      category: 'TransientRace',
      code: 'BOOTSTRAP_READY_HASH_NOT_READY',
      retryable: true,
      fatal: false,
    });
    expect(classifyRuntimeBootstrapStageFailure('custody', 'disabled', 'Custody disabled')).toBeNull();
    expect(classifyRuntimeBootstrapStageFailure('preflight', 'done', 'clear')).toBeNull();
  });

  test('classifies market maker failures without parsing health strings at callers', () => {
    expect(classifyRuntimeMarketMakerFailure('MARKET_MAKER_CHILD_INACTIVE')).toMatchObject({
      category: 'TransientRace',
      code: 'MARKET_MAKER_CHILD_INACTIVE',
      retryable: true,
      fatal: false,
    });
    expect(classifyRuntimeMarketMakerFailure('MARKET_MAKER_DISABLED')).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'MARKET_MAKER_DISABLED',
      retryable: false,
      fatal: false,
    });
  });

  test('classifies settlement batching failures by retry semantics', () => {
    expect(classifyRuntimeJBatchFailure('J_SUBMIT_TRANSIENT', 'ECONNREFUSED')).toMatchObject({
      category: 'TransientRace',
      code: 'J_SUBMIT_TRANSIENT',
      message: 'ECONNREFUSED',
      retryable: true,
      fatal: false,
    });
    expect(classifyRuntimeJBatchFailure('J_BATCH_LIMIT_EXCEEDED')).toMatchObject({
      category: 'Contradiction',
      code: 'J_BATCH_LIMIT_EXCEEDED',
      retryable: false,
      fatal: true,
    });
    expect(classifyRuntimeJBatchFailure('J_BATCH_EMPTY')).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'J_BATCH_EMPTY',
      retryable: false,
      fatal: false,
    });
  });
});
