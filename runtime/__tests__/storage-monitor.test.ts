import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertDiskFreeAtLeast,
  getDiskFreeShortfallBytes,
  getMinDiskFreeBytes,
  isStoragePathMissingError,
  parseStorageHistory,
} from '../orchestrator/storage-monitor';

describe('storage monitor disk guard', () => {
  test('accepts free space equal to the required floor', () => {
    expect(() => assertDiskFreeAtLeast(5, 5)).not.toThrow();
  });

  test('fails closed when free space is below the required floor', () => {
    expect(() => assertDiskFreeAtLeast(4, 5)).toThrow('INSUFFICIENT_DISK_FREE: free=4 required=5 shortfall=1');
  });

  test('exposes the runtime disk guard threshold for gate evidence', () => {
    expect(getMinDiskFreeBytes()).toBeGreaterThanOrEqual(1024 ** 3);
  });

  test('reports exact disk shortfall bytes for operator diagnostics', () => {
    expect(getDiskFreeShortfallBytes(4, 5)).toBe(1);
    expect(getDiskFreeShortfallBytes(5, 5)).toBe(0);
    expect(getDiskFreeShortfallBytes(6, 5)).toBe(0);
  });

  test('rejects corrupt history instead of silently resetting the baseline', () => {
    expect(() => parseStorageHistory('{', '/tmp/corrupt-history.json'))
      .toThrow('STORAGE_HISTORY_INVALID:path=/tmp/corrupt-history.json');
    expect(() => parseStorageHistory('[{"ts":1}]', '/tmp/incomplete-history.json'))
      .toThrow('invalid entry at index 0');
  });

  test('classifies a real lstat deletion race without hiding other filesystem failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xln-storage-monitor-'));
    try {
      let missingError: unknown;
      try {
        lstatSync(join(directory, 'already-rotated.log'));
      } catch (error) {
        missingError = error;
      }
      expect(isStoragePathMissingError(missingError)).toBe(true);
      expect(isStoragePathMissingError(new Error('permission denied'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
