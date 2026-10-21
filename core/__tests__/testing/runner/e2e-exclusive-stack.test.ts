import { describe, expect, test } from 'bun:test';

import { selectExclusiveE2ETask } from '../../../scripts/e2e/runners/run-e2e-parallel-isolated';

const plain = { tags: ['@functional'] };
const exclusive = { tags: ['@functional', '@exclusive-stack'] };

describe('isolated e2e exclusive stack admission', () => {
  test('an exclusive target waits for already running shared stacks to finish cleanup', () => {
    const tasks = [plain, exclusive, plain];
    const claimed = [true, false, false];
    expect(selectExclusiveE2ETask(tasks, claimed, 0, 2)).toBeNull();
    expect(selectExclusiveE2ETask(tasks, claimed, 0, 1)).toBeNull();
    expect(selectExclusiveE2ETask(tasks, claimed, 0, 0)).toBe(1);
  });

  test('an admitted exclusive target blocks all remaining work until its reservation is released', () => {
    const tasks = [exclusive, plain];
    const claimed = [true, false];
    expect(selectExclusiveE2ETask(tasks, claimed, 1, 0)).toBeNull();
    expect(selectExclusiveE2ETask(tasks, claimed, 0, 0)).toBe(-1);
  });

  test('exclusive targets preserve discovery order and cannot overlap one another', () => {
    const tasks = [plain, exclusive, exclusive];
    expect(selectExclusiveE2ETask(tasks, [false, false, false], 0, 0)).toBe(1);
    expect(selectExclusiveE2ETask(tasks, [false, true, false], 1, 0)).toBeNull();
    expect(selectExclusiveE2ETask(tasks, [false, true, false], 0, 0)).toBe(2);
  });

  test('ordinary targets retain their existing concurrent scheduler', () => {
    expect(selectExclusiveE2ETask([plain, plain], [true, false], 0, 1)).toBe(-1);
    expect(selectExclusiveE2ETask([exclusive, plain], [true, true], 0, 0)).toBe(-1);
  });
});
