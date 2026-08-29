import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  resolveWalletBrainVaultMemoryReduction,
  resolveWalletBrainVaultShardWatchdog,
  resolveWalletBrainVaultWorkerInitRetry,
  walletBrainVaultWorkerInitFailureMessage,
} from '../../../frontend/packages/browser/src/wallet-brainvault-worker-resilience';

describe('browser wallet BrainVault worker resilience', () => {
  test('preserves the five-minute minimum shard watchdog', () => {
    expect(resolveWalletBrainVaultShardWatchdog(1_000, 2)).toEqual({
      timeoutMs: 300_000,
      message: 'Shard 3 timed out after 300s',
    });
  });

  test('preserves the ten-minute maximum shard watchdog', () => {
    expect(resolveWalletBrainVaultShardWatchdog(100_000, 0)).toEqual({
      timeoutMs: 600_000,
      message: 'Shard 1 timed out after 600s',
    });
  });

  test('reduces the active cap and requested target without mutating input', () => {
    const state = {
      activeWorkerCount: 6,
      effectiveTargetWorkerCount: 4,
      maxWorkers: 8,
      targetWorkerCount: 5,
    };
    expect(resolveWalletBrainVaultMemoryReduction(state)).toEqual({
      maxWorkers: 3,
      targetWorkerCount: 3,
      notice: 'Browser memory pressure detected. BrainVault is continuing with 3 workers.',
    });
    expect(state).toEqual({
      activeWorkerCount: 6,
      effectiveTargetWorkerCount: 4,
      maxWorkers: 8,
      targetWorkerCount: 5,
    });
  });

  test('preserves the singular one-worker memory notice', () => {
    expect(resolveWalletBrainVaultMemoryReduction({
      activeWorkerCount: 1,
      effectiveTargetWorkerCount: 1,
      maxWorkers: 8,
      targetWorkerCount: 1,
    })).toEqual({
      maxWorkers: 1,
      targetWorkerCount: 1,
      notice: 'Browser memory pressure detected. BrainVault is continuing with 1 worker.',
    });
  });

  test('halves initialization workers and increments the retry attempt', () => {
    expect(resolveWalletBrainVaultWorkerInitRetry({
      attempts: 0,
      initialWorkers: 8,
      maxWorkers: 8,
      targetWorkerCount: 6,
      message: 'WebAssembly.instantiate(): Out of memory',
    })).toEqual({
      status: 'retry',
      attempts: 1,
      initialWorkers: 4,
      maxWorkers: 4,
      targetWorkerCount: 4,
      notice: 'Browser memory pressure detected. BrainVault is retrying with 4 workers.',
    });
  });

  test('rejects non-memory, exhausted, and one-worker initialization retries', () => {
    const base = {
      attempts: 0,
      initialWorkers: 8,
      maxWorkers: 8,
      targetWorkerCount: 6,
      message: 'network disconnected',
    };
    expect(resolveWalletBrainVaultWorkerInitRetry(base)).toEqual({ status: 'failed' });
    expect(resolveWalletBrainVaultWorkerInitRetry({
      ...base,
      attempts: 4,
      message: 'Out of memory',
    })).toEqual({ status: 'failed' });
    expect(resolveWalletBrainVaultWorkerInitRetry({
      ...base,
      initialWorkers: 1,
      message: 'Out of memory',
    })).toEqual({ status: 'failed' });
  });

  test('preserves memory-specific and generic terminal initialization copy', () => {
    expect(walletBrainVaultWorkerInitFailureMessage('Cannot allocate Wasm memory')).toBe(
      'BrainVault could not allocate browser Wasm memory. Reduce other tabs or retry with 1 worker. Cannot allocate Wasm memory',
    );
    expect(walletBrainVaultWorkerInitFailureMessage('Worker init timeout')).toBe(
      'BrainVault worker initialization failed: Worker init timeout',
    );
  });

  test('keeps timers, storage, Workers, secrets, logging, and publication in Svelte', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-brainvault-worker-resilience.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('setTimeout');
    expect(boundary).not.toContain('localStorage');
    expect(boundary).not.toContain('postMessage');
    expect(boundary).not.toContain('new Worker');
    expect(boundary).not.toContain('passphrase');
    expect(view).toContain('resolveWalletBrainVaultShardWatchdog(estimatedShardTimeMs, shardIndex)');
    expect(view).toContain('resolveWalletBrainVaultMemoryReduction({');
    expect(view).toContain('resolveWalletBrainVaultWorkerInitRetry({');
    expect(view).toContain('persistWorkerCap(maxWorkers)');
    expect(view).toContain('logRuntimeCreationDiagnostic(');
  });
});
