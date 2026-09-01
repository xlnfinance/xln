import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STAND_LOCK_SLOTS_ENV,
  acquireStandLock,
  readStandLockHolder,
  reapStandLockSlots,
  releaseStandLock,
  standLockCapacity,
  standLockStatus,
} from '../../../../tools/stand-lock';

/**
 * The semaphore serializes heavy stands across agent worktrees on one machine.
 * Every case below pins its own root: a test that touched the real lock could
 * hand another agent's running stand away mid-measurement.
 */
describe('stand lock', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xln-stand-lock-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env[STAND_LOCK_SLOTS_ENV];
  });

  test('capacity defaults to one and rejects a nonsense override', () => {
    expect(standLockCapacity({})).toBe(1);
    expect(standLockCapacity({ [STAND_LOCK_SLOTS_ENV]: '2' })).toBe(2);
    expect(() => standLockCapacity({ [STAND_LOCK_SLOTS_ENV]: '0' })).toThrow('STAND_LOCK_SLOTS_INVALID');
    expect(() => standLockCapacity({ [STAND_LOCK_SLOTS_ENV]: '9' })).toThrow('STAND_LOCK_SLOTS_INVALID');
  });

  test('a second acquisition is refused while the slot is held, and allowed after release', async () => {
    const first = await acquireStandLock({ reason: 'first', waitMs: 0, root });
    expect(first.slot).toBe(0);
    expect(readStandLockHolder(root, 0)?.reason).toBe('first');
    await expect(acquireStandLock({ reason: 'second', waitMs: 0, root }))
      .rejects.toThrow('STAND_LOCK_BUSY:capacity=1:holders=first@');
    releaseStandLock(first);
    const second = await acquireStandLock({ reason: 'second', waitMs: 0, root });
    expect(second.slot).toBe(0);
    releaseStandLock(second);
  });

  test('capacity two admits exactly two concurrent holders', async () => {
    process.env[STAND_LOCK_SLOTS_ENV] = '2';
    const first = await acquireStandLock({ reason: 'first', waitMs: 0, root });
    const second = await acquireStandLock({ reason: 'second', waitMs: 0, root });
    expect([first.slot, second.slot].sort()).toEqual([0, 1]);
    await expect(acquireStandLock({ reason: 'third', waitMs: 0, root }))
      .rejects.toThrow('STAND_LOCK_BUSY:capacity=2');
    releaseStandLock(first);
    releaseStandLock(second);
  });

  test('a slot whose owner is gone is reclaimed instead of wedging the machine', async () => {
    mkdirSync(join(root, 'slot-0'), { recursive: true });
    writeFileSync(join(root, 'slot-0', 'holder.json'), `${JSON.stringify({
      // PID 0 is never a live user process here; `process.kill(0, 0)` targets
      // the whole process group, so a real dead pid is emulated with a value
      // that cannot own this slot.
      pid: 2_147_483_646,
      reason: 'crashed',
      worktree: root,
      startedAt: new Date().toISOString(),
      token: 'stale',
    })}\n`);
    expect(reapStandLockSlots(root)).toBe(1);
    const grant = await acquireStandLock({ reason: 'recovered', waitMs: 0, root });
    expect(grant.slot).toBe(0);
    releaseStandLock(grant);
  });

  test('release by a foreign token leaves the current holder alone', async () => {
    const held = await acquireStandLock({ reason: 'holder', waitMs: 0, root });
    releaseStandLock({ root, slot: 0, token: 'not-mine' });
    expect(readStandLockHolder(root, 0)?.reason).toBe('holder');
    releaseStandLock(held);
    expect(readStandLockHolder(root, 0)).toBeNull();
  });

  test('status names the holder so a contended measurement is explainable', async () => {
    const grant = await acquireStandLock({ reason: 'hlt-mixed', waitMs: 0, root });
    const status = standLockStatus(root);
    expect(status).toContain('slot-0 HELD');
    expect(status).toContain('reason=hlt-mixed');
    releaseStandLock(grant);
    expect(standLockStatus(root)).toContain('slot-0 free');
  });
});
