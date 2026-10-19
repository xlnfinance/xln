import { describe, expect, test } from 'bun:test';

import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';
import {
  createSettlementWorkspaceHash,
  handleSettleTransition,
} from '../../../account/tx/handlers/settlement/transition';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { createDefaultDelta } from '../../../account/state/delta';
import { entity, makeAccount } from '../../helpers/cross-j';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { beginAccountStateDraft } from '../../../account/state/account-state-draft';

describe('hold underflow guards', () => {
  test('htlc timeout expires exactly at its timelock boundary', async () => {
    const lockId = 'lock-timeout-boundary';
    const accountMachine = makeAccount(entity('11'), entity('22'));
    const delta = createDefaultDelta(1);
    delta.leftHold = 7n;
    accountMachine.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]);
    accountMachine.state.locks = accountMachine.state.locks.updated(lockId, {
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

    const draft = beginAccountStateDraft(accountMachine).draft;
    const result = await handleHtlcResolve(
      draft.state,
      {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'error', reason: 'timeout' },
      },
      true,
      1,
      1_000,
    );

    expect(result.ok).toBe(true);
    expect(draft.state.locks.has(lockId)).toBe(false);
    expect(draft.state.deltas.get(1)!.leftHold).toBe(0n);
    expect(accountMachine.state.locks.has(lockId)).toBe(true);
    expect(delta.leftHold).toBe(7n);
  });

  test('settle clear fails closed without partially releasing earlier token holds', async () => {
    const accountMachine = makeAccount(entity('11'), entity('22'));
    const deltaA = createDefaultDelta(1);
    deltaA.leftHold = 5n;
    const deltaB = createDefaultDelta(2);
    deltaB.rightHold = 1n;
    accountMachine.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [
      [1, deltaA],
      [2, deltaB],
    ]);
    accountMachine.state.settlementWorkspace = {
      workspaceHash: '',
      ops: [
        { type: 'rawDiff', tokenId: 1, leftDiff: 2n, rightDiff: 0n, collateralDiff: -2n, ondeltaDiff: -2n },
        { type: 'rawDiff', tokenId: 2, leftDiff: 0n, rightDiff: 2n, collateralDiff: -2n, ondeltaDiff: 0n },
      ],
      lastModifiedByLeft: true,
      status: 'awaiting_counterparty',
      revision: 1,
      createdAt: 1,
      lastUpdatedAt: 1,
      executorIsLeft: true,
    };
    accountMachine.state.settlementWorkspace.workspaceHash = createSettlementWorkspaceHash(
      accountMachine.state,
      accountMachine.state.settlementWorkspace,
    );

    const draft = beginAccountStateDraft(accountMachine).draft;
    const result = await handleSettleTransition(
      draft,
      {
        type: 'settle_transition',
        data: {
          kind: 'clear',
          revision: 1,
          workspaceHash: accountMachine.state.settlementWorkspace.workspaceHash,
        },
      },
      true,
      2,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected settlement hold underflow');
    expect(result.rejection.message).toContain('SETTLEMENT_HOLD_UNDERFLOW:right');
    expect(draft.state.deltas.get(1)!.leftHold).toBe(5n);
    expect(draft.state.deltas.get(2)!.rightHold).toBe(1n);
    expect(draft.state.settlementWorkspace).toEqual(accountMachine.state.settlementWorkspace);
  });

  test('htlc_resolve(secret) fails closed on hold underflow before mutating delta or deleting the lock', async () => {
    const lockId = 'lock-secret-underflow';
    const secret = '0x' + '11'.repeat(32);
    const delta = createDefaultDelta(7);
    delta.leftHold = 5n;
    delta.offdelta = 0n;

    const accountMachine = makeAccount(entity('11'), entity('22'));
    accountMachine.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[7, delta]]);
    accountMachine.state.locks = PersistentAccountStateMap.fromEntries('locks', [
      [
        lockId,
        {
          lockId,
          tokenId: 7,
          amount: 7n,
          senderIsLeft: true,
          hashlock: hashHtlcSecret(secret),
          revealBeforeHeight: 100,
          timelock: 60_000n,
          createdHeight: 0,
          createdTimestamp: 0,
        },
      ],
    ]);
    const draft = beginAccountStateDraft(accountMachine).draft;

    const result = await handleHtlcResolve(
      draft.state,
      {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'secret', secret },
      },
      true,
      1,
      1_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected htlc hold underflow');
    expect(result.rejection.message).toContain('HTLC_RESOLVE_HOLD_UNDERFLOW:left');
    expect(draft.state.deltas.get(7)!.leftHold).toBe(5n);
    expect(draft.state.deltas.get(7)!.offdelta).toBe(0n);
    expect(draft.state.locks.has(lockId)).toBe(true);
  });

  test('htlc_resolve(timeout error) fails closed without releasing the lock on hold underflow', async () => {
    const lockId = 'lock-timeout-underflow';
    const delta = createDefaultDelta(9);
    delta.leftHold = 5n;

    const accountMachine = makeAccount(entity('11'), entity('22'));
    accountMachine.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[9, delta]]);
    accountMachine.state.locks = PersistentAccountStateMap.fromEntries('locks', [
      [
        lockId,
        {
          lockId,
          tokenId: 9,
          amount: 7n,
          senderIsLeft: true,
          hashlock: '0x' + '22'.repeat(32),
          revealBeforeHeight: 1,
          timelock: 0n,
          createdHeight: 0,
          createdTimestamp: 0,
        },
      ],
    ]);
    const draft = beginAccountStateDraft(accountMachine).draft;

    const result = await handleHtlcResolve(
      draft.state,
      {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'error', reason: 'timeout' },
      },
      true,
      2,
      1_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected htlc hold underflow');
    expect(result.rejection.message).toContain('HTLC_RESOLVE_HOLD_UNDERFLOW:left');
    expect(draft.state.deltas.get(9)!.leftHold).toBe(5n);
    expect(draft.state.locks.has(lockId)).toBe(true);
  });
});
