import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  advanceE2ERunFailureState,
  createE2EGlobalFailFastAbortReason,
  initialE2ERunFailureState,
  isE2EGlobalFailFastAbortSignal,
  reconcileE2EShardCleanupFailures,
  resolveE2EShardManifestStatus,
} from '../scripts/run-e2e-parallel-isolated';

test('keeps one typed primary failure while cancelled neighbors do not consume the failure budget', () => {
  const primaryCapsule = {
    version: 1 as const,
    reportPath: 'shard-2/artifacts/playwright/playwright-report.json',
    file: 'tests/e2e-lending.spec.ts',
    title: 'lending flow',
    line: 42,
    column: 7,
    project: 'chromium',
    error: 'Expected balance to equal 100',
    stack: 'tests/e2e-lending.spec.ts:42:7',
    attachments: [],
    rerunCommand: 'bun runtime/scripts/run-e2e-parallel-isolated.ts --trace=retain-on-failure',
  };
  const first = advanceE2ERunFailureState(initialE2ERunFailureState(), {
    shard: 2,
    status: 'failed',
    resultClass: 'playwright',
    error: 'playwright_exit=1',
    failureCapsule: primaryCapsule,
    failureCapsulePath: '/tmp/run/shard-2/failure-capsule.json',
  }, 1);

  expect(first.shouldAbort).toBe(true);
  expect(first.state.failedCount).toBe(1);
  expect(first.state.primaryFailure).toEqual({
    shard: 2,
    resultClass: 'playwright',
    error: 'playwright_exit=1',
    failureCapsule: primaryCapsule,
    failureCapsulePath: '/tmp/run/shard-2/failure-capsule.json',
  });

  const afterCancelledNeighbor = advanceE2ERunFailureState(first.state, {
    shard: 5,
    status: 'cancelled',
    resultClass: 'cancelled',
    error: 'E2E_CANCELLED_AFTER_PRIMARY_FAILURE:primaryShard=2',
    failureCapsule: null,
    failureCapsulePath: null,
  }, 1);
  expect(afterCancelledNeighbor).toEqual({ state: first.state, shouldAbort: false });

  const controller = new AbortController();
  controller.abort(createE2EGlobalFailFastAbortReason(first.state.primaryFailure!));
  expect(isE2EGlobalFailFastAbortSignal(controller.signal)).toBe(true);
  expect(isE2EGlobalFailFastAbortSignal(AbortSignal.abort(new Error('code drift')))).toBe(false);
});

test('runner skips HTTP forensics for fail-fast cancellations and forces trace on exact reruns', () => {
  const runner = readFileSync('runtime/scripts/run-e2e-parallel-isolated.ts', 'utf8');

  expect(runner).toContain("resultClass: 'cancelled'");
  expect(runner).toContain('isE2EGlobalFailFastAbortSignal(signal)');
  expect(runner).toContain('return finishCancelled();');
  expect(runner).toContain("!String(teardownReason || '').startsWith('E2E_FATAL_RUNTIME_LOG')");
  expect(runner).toContain("traceMode: 'retain-on-failure'");
  expect(runner).toContain('primaryFailureShard: primaryFailure?.shard ?? null');
  expect(runner).toContain('primaryFailureCapsule: primaryFailure?.failureCapsule ?? null');
});

test('preserves a product failure when shard cleanup also fails', () => {
  const result = {
    status: 'failed' as const,
    resultClass: 'playwright' as const,
    error: 'Expected balance to equal 100',
    diagnostics: ['browser screenshot captured'],
  };
  const cleanupFailure = new Error('E2E_SHARD_CLEANUP_FAILED:processes', {
    cause: new Error('api SIGTERM timed out'),
  });

  const resolution = reconcileE2EShardCleanupFailures(result, [cleanupFailure], 2);

  expect(resolution.unhandledError).toBeNull();
  expect(resolution.result).toEqual({
    status: 'failed',
    resultClass: 'playwright',
    error:
      'Expected balance to equal 100\n' +
      'E2E_SHARD_SECONDARY_FAILURE:cleanup:Error: E2E_SHARD_CLEANUP_FAILED:processes ' +
      'cause=Error: api SIGTERM timed out',
    diagnostics: [
      'browser screenshot captured',
      'E2E_SHARD_SECONDARY_FAILURE:cleanup:Error: E2E_SHARD_CLEANUP_FAILED:processes ' +
        'cause=Error: api SIGTERM timed out',
    ],
  });
});

test('makes cleanup the runner failure only when the shard had passed', () => {
  const resolution = reconcileE2EShardCleanupFailures({
    status: 'passed',
    resultClass: 'passed',
    diagnostics: [],
  }, [new Error('E2E_SHARD_CLEANUP_FAILED:api-ports')], 3);

  expect(resolution.unhandledError).toBeNull();
  expect(resolution.result).toEqual({
    status: 'failed',
    resultClass: 'runner',
    error: 'E2E_SHARD_SECONDARY_FAILURE:cleanup:Error: E2E_SHARD_CLEANUP_FAILED:api-ports',
    diagnostics: [
      'E2E_SHARD_SECONDARY_FAILURE:cleanup:Error: E2E_SHARD_CLEANUP_FAILED:api-ports',
    ],
  });
  expect(resolveE2EShardManifestStatus('failed', 'passed')).toBe('failed');
});

test('keeps a fail-fast neighbor cancelled while recording its cleanup failure', () => {
  const resolution = reconcileE2EShardCleanupFailures({
    status: 'cancelled',
    resultClass: 'cancelled',
    error: 'E2E_CANCELLED_AFTER_PRIMARY_FAILURE:primaryShard=2',
  }, [new Error('E2E_SHARD_CLEANUP_FAILED:anvil-temp')], 5);

  expect(resolution.unhandledError).toBeNull();
  expect(resolution.result).toEqual({
    status: 'cancelled',
    resultClass: 'cancelled',
    error:
      'E2E_CANCELLED_AFTER_PRIMARY_FAILURE:primaryShard=2\n' +
      'E2E_SHARD_SECONDARY_FAILURE:cleanup:Error: E2E_SHARD_CLEANUP_FAILED:anvil-temp',
    diagnostics: [
      'E2E_SHARD_SECONDARY_FAILURE:cleanup:Error: E2E_SHARD_CLEANUP_FAILED:anvil-temp',
    ],
  });
});

test('returns a loud aggregate only when cleanup has no completed shard result', () => {
  const cleanupFailure = new Error('E2E_SHARD_CLEANUP_FAILED:log-finish');
  const resolution = reconcileE2EShardCleanupFailures(null, [cleanupFailure], 7);

  expect(resolution.result).toBeNull();
  expect(resolution.unhandledError).toBeInstanceOf(AggregateError);
  expect(resolution.unhandledError?.message).toBe('E2E_SHARD_CLEANUP_FAILED:shard=7');
  expect(resolution.unhandledError?.errors).toEqual([cleanupFailure]);
});
