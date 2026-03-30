import { describe, expect, test } from 'bun:test';

import { handleHtlcReveal } from '../account-tx/handlers/htlc-reveal';
import { handleHtlcTimeout } from '../account-tx/handlers/htlc-timeout';
import { handleSettleRelease } from '../account-tx/handlers/settle-hold';
import { hashHtlcSecret } from '../htlc-utils';
import { createDefaultDelta } from '../validation-utils';

describe('hold underflow guards', () => {
  test('settle_release fails closed without partially mutating earlier token holds', async () => {
    const deltaA = createDefaultDelta(1);
    deltaA.leftHold = 5n;
    const deltaB = createDefaultDelta(2);
    deltaB.rightHold = 1n;

    const accountMachine = {
      deltas: new Map([
        [1, deltaA],
        [2, deltaB],
      ]),
    } as any;

    const result = await handleSettleRelease(accountMachine, {
      type: 'settle_release',
      data: {
        workspaceVersion: 1,
        diffs: [
          { tokenId: 1, leftWithdrawing: 2n, rightWithdrawing: 0n },
          { tokenId: 2, leftWithdrawing: 0n, rightWithdrawing: 2n },
        ],
      },
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('SETTLE_RELEASE_HOLD_UNDERFLOW:right');
    expect(deltaA.leftHold).toBe(5n);
    expect(deltaB.rightHold).toBe(1n);
  });

  test('htlc_reveal fails closed on hold underflow before mutating delta or deleting the lock', async () => {
    const lockId = 'lock-reveal-underflow';
    const secret = '0x' + '11'.repeat(32);
    const delta = createDefaultDelta(7);
    delta.leftHold = 5n;
    delta.offdelta = 0n;

    const accountMachine = {
      deltas: new Map([[7, delta]]),
      locks: new Map([[
        lockId,
        {
          tokenId: 7,
          amount: 7n,
          senderIsLeft: true,
          hashlock: hashHtlcSecret(secret),
          revealBeforeHeight: 100,
          timelock: BigInt(Date.now() + 60_000),
        },
      ]]),
    } as any;

    const result = await handleHtlcReveal(
      accountMachine,
      {
        type: 'htlc_reveal',
        data: { lockId, secret },
      } as any,
      1,
      Date.now(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTLC_REVEAL_HOLD_UNDERFLOW:left');
    expect(delta.leftHold).toBe(5n);
    expect(delta.offdelta).toBe(0n);
    expect(accountMachine.locks.has(lockId)).toBe(true);
  });

  test('htlc_timeout fails closed without releasing the lock on hold underflow', async () => {
    const lockId = 'lock-timeout-underflow';
    const delta = createDefaultDelta(9);
    delta.leftHold = 5n;

    const accountMachine = {
      deltas: new Map([[9, delta]]),
      locks: new Map([[
        lockId,
        {
          tokenId: 9,
          amount: 7n,
          senderIsLeft: true,
          hashlock: '0x' + '22'.repeat(32),
          revealBeforeHeight: 1,
          timelock: 0n,
        },
      ]]),
    } as any;

    const result = await handleHtlcTimeout(
      accountMachine,
      {
        type: 'htlc_timeout',
        data: { lockId },
      } as any,
      2,
      Date.now(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTLC_TIMEOUT_HOLD_UNDERFLOW:left');
    expect(delta.leftHold).toBe(5n);
    expect(accountMachine.locks.has(lockId)).toBe(true);
  });
});
