import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  BRAINVAULT_SHARD_TIME_MAX_MS,
  decodeWalletBrainVaultWorkerMessage,
  normalizeWalletBrainVaultWorkerError,
  type WalletBrainVaultShardCompleteMessage,
  validateWalletBrainVaultShardCompletion,
} from '../../../frontend/packages/browser/src/wallet-brainvault-worker-validation';

const SPEC_ID = 'brainvault-v1';
const RESULT_HEX = 'ab'.repeat(32);

const decodeCompletion = (
  value: unknown,
): WalletBrainVaultShardCompleteMessage => {
  const message = decodeWalletBrainVaultWorkerMessage(value, SPEC_ID);
  if (message.kind !== 'shard-complete') throw new Error('EXPECTED_SHARD_COMPLETION');
  return message;
};

describe('browser wallet BrainVault worker validation', () => {
  test('rejects malformed and unknown worker message envelopes', () => {
    expect(decodeWalletBrainVaultWorkerMessage(null, SPEC_ID)).toEqual({
      kind: 'invalid',
      message: 'BRAINVAULT_WORKER_MESSAGE_INVALID',
    });
    expect(decodeWalletBrainVaultWorkerMessage({ type: 1 }, SPEC_ID)).toEqual({
      kind: 'invalid',
      message: 'BRAINVAULT_WORKER_MESSAGE_INVALID',
    });
    expect(decodeWalletBrainVaultWorkerMessage({ type: 'surprise' }, SPEC_ID)).toEqual({
      kind: 'invalid',
      message: 'BRAINVAULT_WORKER_MESSAGE_UNKNOWN:surprise',
    });
  });

  test('requires the exact worker spec before publishing readiness', () => {
    expect(decodeWalletBrainVaultWorkerMessage({
      type: 'ready',
      data: { specId: SPEC_ID },
    }, SPEC_ID)).toEqual({ kind: 'ready' });
    expect(decodeWalletBrainVaultWorkerMessage({
      type: 'ready',
      data: { specId: 'wrong-spec' },
    }, SPEC_ID)).toEqual({
      kind: 'invalid',
      message: 'BRAINVAULT_WORKER_SPEC_MISMATCH:wrong-spec:brainvault-v1',
    });
  });

  test('normalizes probe timing without discarding the reported sample', () => {
    expect(decodeWalletBrainVaultWorkerMessage({
      type: 'probe_result',
      data: { estimatedShardTimeMs: 50 },
    }, SPEC_ID)).toEqual({
      kind: 'probe-result',
      measuredShardTimeMs: 100,
      reportedShardTimeMs: 50,
    });
    expect(decodeWalletBrainVaultWorkerMessage({
      type: 'probe_result',
      data: { estimatedShardTimeMs: -1 },
    }, SPEC_ID)).toEqual({
      kind: 'probe-result',
      measuredShardTimeMs: null,
      reportedShardTimeMs: -1,
    });
  });

  test('preserves untrusted shard fields for contextual validation', () => {
    expect(decodeWalletBrainVaultWorkerMessage({
      type: 'shard_complete',
      data: { shardIndex: 2, resultHex: RESULT_HEX, elapsedMs: 1200 },
    }, SPEC_ID)).toEqual({
      kind: 'shard-complete',
      shardIndex: 2,
      resultHex: RESULT_HEX,
      elapsedMs: 1200,
    });
  });

  test('preserves worker-reported failures and their default', () => {
    expect(decodeWalletBrainVaultWorkerMessage({
      type: 'error',
      data: { message: 'argon failed' },
    }, SPEC_ID)).toEqual({ kind: 'failed', error: 'argon failed' });
    expect(decodeWalletBrainVaultWorkerMessage({ type: 'error' }, SPEC_ID))
      .toEqual({ kind: 'failed', error: 'Worker failed' });
  });

  test('normalizes Error, record, primitive, and empty worker failures', () => {
    expect(normalizeWalletBrainVaultWorkerError(new Error('boom'))).toBe('boom');
    expect(normalizeWalletBrainVaultWorkerError({ message: 'record boom' })).toBe('record boom');
    expect(normalizeWalletBrainVaultWorkerError(17)).toBe('17');
    expect(normalizeWalletBrainVaultWorkerError(null)).toBe('Worker failed');
  });

  test('validates completion context and clamps telemetry independently', () => {
    const completion = decodeCompletion({
      type: 'shard_complete',
      data: { shardIndex: 2, resultHex: RESULT_HEX, elapsedMs: BRAINVAULT_SHARD_TIME_MAX_MS + 1 },
    });

    expect(validateWalletBrainVaultShardCompletion(completion, {
      activeShard: 2,
      shardCount: 3,
      expectedResultHexLength: 64,
      alreadyCompleted: false,
    })).toEqual({
      shardIndex: 2,
      resultHex: RESULT_HEX,
      measuredShardTimeMs: BRAINVAULT_SHARD_TIME_MAX_MS,
    });
  });

  test('rejects invalid indices, ownership, result length, and duplicates', () => {
    const completion = (shardIndex: unknown, resultHex: unknown = RESULT_HEX) => decodeCompletion({
      type: 'shard_complete',
      data: { shardIndex, resultHex, elapsedMs: 1000 },
    });
    const context = {
      activeShard: 2,
      shardCount: 3,
      expectedResultHexLength: 64,
      alreadyCompleted: false,
    } as const;

    expect(() => validateWalletBrainVaultShardCompletion(completion('2'), context))
      .toThrow('BRAINVAULT_WORKER_SHARD_INDEX_INVALID:2');
    expect(() => validateWalletBrainVaultShardCompletion(completion(3), context))
      .toThrow('BRAINVAULT_WORKER_SHARD_INDEX_INVALID:3');
    expect(() => validateWalletBrainVaultShardCompletion(completion(1), context))
      .toThrow('BRAINVAULT_WORKER_SHARD_MISMATCH:2:1');
    expect(() => validateWalletBrainVaultShardCompletion(completion(2, 'ab'), context))
      .toThrow('BRAINVAULT_WORKER_RESULT_INVALID:2');
    expect(() => validateWalletBrainVaultShardCompletion(completion(2), {
      ...context,
      alreadyCompleted: true,
    })).toThrow('BRAINVAULT_WORKER_DUPLICATE_SHARD:2');
  });

  test('keeps Worker lifecycle, secret bytes, timers, and effects in Svelte', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-brainvault-worker-validation.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('postMessage');
    expect(boundary).not.toContain('setTimeout');
    expect(boundary).not.toContain('hexToBytes');
    expect(boundary).not.toContain('passphrase');
    expect(view).toContain('decodeWalletBrainVaultWorkerMessage(e.data, BRAINVAULT_V1_SPEC_ID)');
    expect(view).toContain('validateWalletBrainVaultShardCompletion(message, {');
    expect(view).toContain('worker.postMessage({');
    expect(view).toContain('clearWorkerShardWatchdog(worker)');
    expect(view).toContain('hexToBytes(completion.resultHex)');
  });
});
