import { describe, expect, test } from 'bun:test';

import { handleHtlcResolve } from '../account/tx/handlers/htlc-resolve';
import {
  createSettlementWorkspaceHash,
  handleSettleTransition,
} from '../account/tx/handlers/settle-transition';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { createDefaultDelta } from '../validation-utils';
import { entity, makeAccount } from './helpers/cross-j';

describe('hold underflow guards', () => {
  test('htlc timeout expires exactly at its timelock boundary', async () => {
    const lockId = 'lock-timeout-boundary';
    const accountMachine = makeAccount(entity('11'), entity('22'));
    const delta = createDefaultDelta(1);
    delta.leftHold = 7n;
    accountMachine.deltas = new Map([[1, delta]]);
    accountMachine.locks.set(lockId, {
      lockId,
      tokenId: 1,
      amount: 7n,
      senderIsLeft: true,
      hashlock: `0x${'21'.repeat(32)}`,
      revealBeforeHeight: 100,
      timelock: 1_000n,
      createdHeight: 0,
      createdTimestamp: 0,
    });

    const result = await handleHtlcResolve(
      accountMachine,
      {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'error', reason: 'timeout' },
      },
      true,
      1,
      1_000,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.locks.has(lockId)).toBe(false);
    expect(delta.leftHold).toBe(0n);
  });

  test('settle clear fails closed without partially releasing earlier token holds', async () => {
    const accountMachine = makeAccount(entity('11'), entity('22'));
    const deltaA = createDefaultDelta(1);
    deltaA.leftHold = 5n;
    const deltaB = createDefaultDelta(2);
    deltaB.rightHold = 1n;
    accountMachine.deltas = new Map([[1, deltaA], [2, deltaB]]);
    accountMachine.settlementWorkspace = {
      workspaceHash: '',
      ops: [
        { type: 'rawDiff', tokenId: 1, leftDiff: -2n, rightDiff: 2n, collateralDiff: 0n, ondeltaDiff: 0n },
        { type: 'rawDiff', tokenId: 2, leftDiff: 2n, rightDiff: -2n, collateralDiff: 0n, ondeltaDiff: 0n },
      ],
      lastModifiedByLeft: true,
      status: 'awaiting_counterparty',
      version: 1,
      createdAt: 1,
      lastUpdatedAt: 1,
      executorIsLeft: true,
    };
    accountMachine.settlementWorkspace.workspaceHash = createSettlementWorkspaceHash(
      accountMachine,
      accountMachine.settlementWorkspace,
    );

    const result = await handleSettleTransition(accountMachine, {
      type: 'settle_transition',
      data: {
        kind: 'clear',
        version: 1,
        workspaceHash: accountMachine.settlementWorkspace.workspaceHash,
      },
    }, true, 2);

    expect(result.success).toBe(false);
    expect(result.error).toContain('SETTLEMENT_HOLD_UNDERFLOW:right');
    expect(deltaA.leftHold).toBe(5n);
    expect(deltaB.rightHold).toBe(1n);
    expect(accountMachine.settlementWorkspace).toBeDefined();
  });

  test('htlc_resolve(secret) fails closed on hold underflow before mutating delta or deleting the lock', async () => {
    const lockId = 'lock-secret-underflow';
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
          timelock: 60_000n,
        },
      ]]),
    } as any;

    const result = await handleHtlcResolve(
      accountMachine,
      {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'secret', secret },
      } as any,
      true,
      1,
      1_000,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTLC_RESOLVE_HOLD_UNDERFLOW:left');
    expect(delta.leftHold).toBe(5n);
    expect(delta.offdelta).toBe(0n);
    expect(accountMachine.locks.has(lockId)).toBe(true);
  });

  test('htlc_resolve(timeout error) fails closed without releasing the lock on hold underflow', async () => {
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

    const result = await handleHtlcResolve(
      accountMachine,
      {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'error', reason: 'timeout' },
      } as any,
      true,
      2,
      1_000,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTLC_RESOLVE_HOLD_UNDERFLOW:left');
    expect(delta.leftHold).toBe(5n);
    expect(accountMachine.locks.has(lockId)).toBe(true);
  });
});
