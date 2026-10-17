import { describe, expect, test } from 'bun:test';

import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { createDefaultDelta } from '../../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import type { AccountReplica, AccountTx, Delta, SettlementOp } from '../../../../types/account';
import { entity, makeAccount } from '../../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const CLOCK = { timestamp: 1_000, jHeight: 0 };

const accountWith = (delta: Partial<Delta>): AccountReplica => {
  const account = makeAccount(LEFT, RIGHT);
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, { ...createDefaultDelta(1), ...delta }]]);
  return account;
};

const upsert = (account: AccountReplica, byLeft: boolean, ops: SettlementOp[]) =>
  applyAccountTxToMutableReplica(
    account,
    {
      type: 'settle_transition',
      data: { kind: 'upsert', revision: 1, ops, executorIsLeft: false },
    },
    byLeft,
    1_000,
    0,
    false,
    undefined,
    undefined,
    undefined,
    CLOCK,
  );

const clear = (account: AccountReplica, byLeft: boolean) =>
  applyAccountTxToMutableReplica(
    account,
    {
      type: 'settle_transition',
      data: { kind: 'clear', revision: 1, workspaceHash: account.state.settlementWorkspace!.workspaceHash },
    },
    byLeft,
    1_001,
    0,
    false,
    undefined,
    undefined,
    undefined,
    CLOCK,
  );

const pay = (account: AccountReplica, byLeft: boolean, amount: bigint) => {
  const tx: AccountTx = {
    type: 'direct_payment',
    data: {
      tokenId: 1,
      amount,
      route: [byLeft ? RIGHT : LEFT],
      fromEntityId: byLeft ? LEFT : RIGHT,
      toEntityId: byLeft ? RIGHT : LEFT,
      deliveryMode: 'direct',
    },
  };
  return applyAccountTxToMutableReplica(account, tx, byLeft, 1_002, 0, false, undefined, undefined, undefined, CLOCK);
};

const holds = (account: AccountReplica) => {
  const delta = account.state.deltas.get(1)!;
  return { left: delta.leftHold, right: delta.rightHold };
};

describe('settlement hold plan', () => {
  test('settlement.c2r_holds_proposer_channel_share', async () => {
    // LEFT owns all 100 of collateral (ondelta = 100) and has no credit.
    const account = accountWith({ collateral: 100n, ondelta: 100n });

    expect((await upsert(account, true, [{ type: 'c2r', tokenId: 1, amount: 100n }])).ok).toBe(true);
    expect(holds(account)).toEqual({ left: 100n, right: 0n });

    // The withdrawn share is reserved: LEFT cannot also spend it off-chain.
    const blocked = await pay(account, true, 100n);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('expected capacity rejection');
    expect(blocked.rejection.message).toContain('Insufficient capacity');
    expect(account.state.deltas.get(1)?.offdelta).toBe(0n);

    expect((await clear(account, true)).ok).toBe(true);
    expect(holds(account)).toEqual({ left: 0n, right: 0n });
    expect((await pay(account, true, 100n)).ok).toBe(true);
    expect(account.state.deltas.get(1)?.offdelta).toBe(-100n);
  });

  test('settlement.c2r_by_right_holds_right_channel_share', async () => {
    // collateral 100, LEFT share 60 => RIGHT share 40.
    const account = accountWith({ collateral: 100n, ondelta: 60n });
    expect((await upsert(account, false, [{ type: 'c2r', tokenId: 1, amount: 40n }])).ok).toBe(true);
    expect(holds(account)).toEqual({ left: 0n, right: 40n });
    expect((await pay(account, false, 1n)).ok).toBe(false);
  });

  test('settlement.c2r_above_channel_share_capacity_is_rejected', async () => {
    const account = accountWith({ collateral: 100n, ondelta: 100n });
    const result = await upsert(account, true, [{ type: 'c2r', tokenId: 1, amount: 150n }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected hold capacity rejection');
    expect(result.rejection.message).toBe('SETTLEMENT_PROJECTED_COLLATERAL_RANGE:token=1');
    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(holds(account)).toEqual({ left: 0n, right: 0n });
  });

  test('settlement.r2c_places_no_channel_hold', async () => {
    const account = accountWith({ collateral: 100n, ondelta: 100n });
    expect((await upsert(account, true, [{ type: 'r2c', tokenId: 1, amount: 50n }])).ok).toBe(true);
    expect(account.state.settlementWorkspace?.revision).toBe(1);
    expect(holds(account)).toEqual({ left: 0n, right: 0n });
    // The deposit does not reduce what LEFT can spend now.
    expect((await pay(account, true, 100n)).ok).toBe(true);
  });

  test('settlement.r2r_places_no_channel_hold_and_no_capacity_check', async () => {
    // No collateral, no credit: LEFT has zero channel capacity.
    const account = accountWith({});
    expect((await upsert(account, true, [{ type: 'r2r', tokenId: 1, amount: 10n ** 30n }])).ok).toBe(true);
    expect(holds(account)).toEqual({ left: 0n, right: 0n });
    expect((await clear(account, true)).ok).toBe(true);
    expect(holds(account)).toEqual({ left: 0n, right: 0n });
  });

  test('settlement.raw_share_transfer_holds_only_the_losing_side', async () => {
    const account = accountWith({ collateral: 100n, ondelta: 100n });
    // Pure ownership transfer: collateral unchanged, LEFT loses 30 of share.
    expect(
      (
        await upsert(account, true, [
          {
            type: 'rawDiff',
            tokenId: 1,
            leftDiff: 0n,
            rightDiff: 0n,
            collateralDiff: 0n,
            ondeltaDiff: -30n,
          },
        ])
      ).ok,
    ).toBe(true);
    expect(holds(account)).toEqual({ left: 30n, right: 0n });
  });
});
