/**
 * Idle self-termination arms on test/benchmark stands only, and fires only
 * when nothing at all happened for the whole window.
 */
import { describe, expect, test } from 'bun:test';

import { idleShutdownTimeoutMs, startIdleShutdownWatch } from '../../core/support/process/idle-shutdown';

describe('idle shutdown watch', () => {
  test('stays off in production and arms on a stand marker', () => {
    expect(idleShutdownTimeoutMs({})).toBeNull();
    expect(idleShutdownTimeoutMs({ XLN_HLT_USERS: '1000' })).toBe(300_000);
    expect(idleShutdownTimeoutMs({ E2E_BASE_URL: 'https://localhost:8080' })).toBe(300_000);
    // The operator's explicit decision wins, marker or not.
    expect(idleShutdownTimeoutMs({ XLN_NODE_IDLE_TIMEOUT_S: '30' })).toBe(30_000);
  });

  test('fires after a silent window and never while work arrives', async () => {
    const fired: number[] = [];
    const watch = startIdleShutdownWatch('test', idleMs => fired.push(idleMs), {
      timeoutMs: 60,
      checkEveryMs: 10,
    });
    for (let tick = 0; tick < 8; tick += 1) {
      await Bun.sleep(15);
      watch.noteActivity();
    }
    expect(fired).toEqual([]);
    await Bun.sleep(120);
    expect(fired.length).toBe(1);
    expect(fired[0]).toBeGreaterThanOrEqual(60);
    watch.stop();
  });

  test('a null timeout is a watch that can never fire', async () => {
    const fired: number[] = [];
    const watch = startIdleShutdownWatch('test', idleMs => fired.push(idleMs), { timeoutMs: null });
    await Bun.sleep(50);
    watch.noteActivity();
    watch.stop();
    expect(fired).toEqual([]);
  });
});
