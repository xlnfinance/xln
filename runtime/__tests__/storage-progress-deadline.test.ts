import { expect, test } from 'bun:test';

import { evaluateStorageProgressDeadline } from '../storage/progress-deadline';

test('storage deadline measures idle time after the latest completed phase', () => {
  expect(evaluateStorageProgressDeadline(54_000, 61_000, 60_000)).toEqual({
    idleMs: 7_000,
    remainingMs: 53_000,
    stalled: false,
  });

  expect(evaluateStorageProgressDeadline(54_000, 114_000, 60_000)).toEqual({
    idleMs: 60_000,
    remainingMs: 0,
    stalled: true,
  });
});

test('storage deadline rejects invalid clocks and timeouts', () => {
  expect(() => evaluateStorageProgressDeadline(2, 1, 60_000)).toThrow(
    'STORAGE_PROGRESS_CLOCK_INVALID:last=2:now=1',
  );
  expect(() => evaluateStorageProgressDeadline(0, 0, 0)).toThrow(
    'STORAGE_PROGRESS_TIMEOUT_INVALID:0',
  );
});
