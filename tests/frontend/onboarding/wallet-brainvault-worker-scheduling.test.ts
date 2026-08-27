import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  hasPendingWalletBrainVaultShardWork,
  resolveWalletBrainVaultShardDispatch,
  resolveWalletBrainVaultShardRetry,
  resolveWalletBrainVaultWorkerScale,
} from '../../../frontend/packages/browser/src/wallet-brainvault-worker-scheduling';

describe('browser wallet BrainVault worker scheduling', () => {
  test('preserves the existing pending-work predicate', () => {
    expect(hasPendingWalletBrainVaultShardWork({
      retryQueue: [],
      nextShardToDispatch: 3,
      shardCount: 3,
    })).toBe(false);
    expect(hasPendingWalletBrainVaultShardWork({
      retryQueue: [1],
      nextShardToDispatch: 3,
      shardCount: 3,
    })).toBe(true);
    expect(hasPendingWalletBrainVaultShardWork({
      retryQueue: [],
      nextShardToDispatch: 2,
      shardCount: 3,
    })).toBe(true);
  });

  test('ignores a late failure for an already completed shard', () => {
    expect(resolveWalletBrainVaultShardRetry(2, 'late', {
      alreadyCompleted: true,
      currentAttempts: 1,
      retryQueue: [4],
    })).toEqual({ status: 'completed', attempts: 1, retryQueue: [4] });
  });

  test('increments and prepends a fresh retry without mutating its input', () => {
    const retryQueue = [4];
    expect(resolveWalletBrainVaultShardRetry(2, 'failed', {
      alreadyCompleted: false,
      currentAttempts: 1,
      retryQueue,
    })).toEqual({ status: 'queued', attempts: 2, retryQueue: [2, 4] });
    expect(retryQueue).toEqual([4]);
  });

  test('does not duplicate a shard already waiting to retry', () => {
    expect(resolveWalletBrainVaultShardRetry(2, 'failed', {
      alreadyCompleted: false,
      currentAttempts: 2,
      retryQueue: [2, 4],
    })).toEqual({ status: 'queued', attempts: 3, retryQueue: [2, 4] });
  });

  test('fails on the fourth shard retry with the exact existing message', () => {
    expect(resolveWalletBrainVaultShardRetry(2, 'argon failed', {
      alreadyCompleted: false,
      currentAttempts: 3,
      retryQueue: [4],
    })).toEqual({
      status: 'failed',
      attempts: 4,
      retryQueue: [4],
      message: 'BrainVault shard 3 failed repeatedly: argon failed',
    });
  });

  test('cleans completed queue heads and dispatches retries before fresh shards', () => {
    expect(resolveWalletBrainVaultShardDispatch({
      retryQueue: [2, 3],
      nextShardToDispatch: 0,
      shardCount: 4,
    }, new Set([0, 2]))).toEqual({
      status: 'dispatch',
      shardIndex: 3,
      retryQueue: [],
      nextShardToDispatch: 1,
    });
  });

  test('skips completed fresh shards and reports idle after cleanup', () => {
    expect(resolveWalletBrainVaultShardDispatch({
      retryQueue: [],
      nextShardToDispatch: 0,
      shardCount: 4,
    }, new Set([0, 1]))).toEqual({
      status: 'dispatch',
      shardIndex: 2,
      retryQueue: [],
      nextShardToDispatch: 3,
    });
    expect(resolveWalletBrainVaultShardDispatch({
      retryQueue: [2],
      nextShardToDispatch: 3,
      shardCount: 3,
    }, new Set([2]))).toEqual({
      status: 'idle',
      retryQueue: [],
      nextShardToDispatch: 3,
    });
  });

  test('resolves drain, capped add, and unchanged worker scaling', () => {
    expect(resolveWalletBrainVaultWorkerScale(4, 2, 8, true))
      .toEqual({ status: 'drain', count: 2 });
    expect(resolveWalletBrainVaultWorkerScale(4, 8, 3, true))
      .toEqual({ status: 'drain', count: 1 });
    expect(resolveWalletBrainVaultWorkerScale(1, 4, 3, true))
      .toEqual({ status: 'add', count: 2 });
    expect(resolveWalletBrainVaultWorkerScale(1, 4, 3, false))
      .toEqual({ status: 'unchanged' });
    expect(resolveWalletBrainVaultWorkerScale(3, 3, 8, true))
      .toEqual({ status: 'unchanged' });
  });

  test('keeps Worker lifecycle, secrets, timers, and mutable state in Svelte', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-brainvault-worker-scheduling.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('postMessage');
    expect(boundary).not.toContain('setTimeout');
    expect(boundary).not.toContain('passphrase');
    expect(boundary).not.toContain('new Worker');
    expect(boundary).not.toContain('worker: Worker');
    expect(view).toContain('resolveWalletBrainVaultShardRetry(shardIndex, message, {');
    expect(view).toContain('resolveWalletBrainVaultShardDispatch({');
    expect(view).toContain('resolveWalletBrainVaultWorkerScale(');
    expect(view).toContain('worker.postMessage({');
    expect(view).toContain('armWorkerShardWatchdog(worker, dispatch.shardIndex)');
    expect(view).toContain('passphrase: run.passphrase');
  });
});
