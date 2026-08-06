import { expect, spyOn, test } from 'bun:test';

import { readStorageProgressClockMs } from '../storage/commit-deadline';
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

test('storage deadline clock is independent from adjustable wall time', async () => {
  const before = readStorageProgressClockMs();
  const wallClock = spyOn(Date, 'now').mockReturnValue(9_000_000_000_000);
  try {
    await Bun.sleep(2);
    const after = readStorageProgressClockMs();
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThan(before + 1_000);
  } finally {
    wallClock.mockRestore();
  }
});
