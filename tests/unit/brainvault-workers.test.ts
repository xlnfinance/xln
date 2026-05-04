import { describe, expect, test } from 'bun:test';

import {
  computeBrainVaultWorkerCap,
  isBrainVaultWasmMemoryError,
  nextBrainVaultWorkerCapAfterFailure,
} from '../../frontend/src/lib/brainvault/workers';

describe('BrainVault worker sizing', () => {
  test('does not map 32 CPU cores to 32 browser Wasm workers', () => {
    expect(computeBrainVaultWorkerCap({
      hardwareConcurrency: 32,
      deviceMemoryGB: 8,
      shardMemoryMB: 256,
      isWebKit: false,
    })).toBe(5);
  });

  test('honors a persisted lower cap after browser memory pressure', () => {
    expect(computeBrainVaultWorkerCap({
      hardwareConcurrency: 32,
      deviceMemoryGB: 64,
      shardMemoryMB: 256,
      isWebKit: false,
      storedCap: 2,
    })).toBe(2);
  });

  test('recognizes browser Wasm allocation failures', () => {
    expect(isBrainVaultWasmMemoryError('WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance')).toBe(true);
    expect(isBrainVaultWasmMemoryError('network disconnected')).toBe(false);
  });

  test('halves the cap after a memory failure', () => {
    expect(nextBrainVaultWorkerCapAfterFailure(10)).toBe(5);
    expect(nextBrainVaultWorkerCapAfterFailure(1)).toBe(1);
  });
});
