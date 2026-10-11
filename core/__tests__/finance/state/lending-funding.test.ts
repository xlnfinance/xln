import { expect, test } from 'bun:test';
import { makeAccount } from '../../helpers/cross-j';
import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { computeAccountStateRootCold } from '../../../account/commitment/state-root';

const left = `0x${'10'.repeat(32)}`;
const right = `0x${'20'.repeat(32)}`;
const cases = [
  { name: 'zero owned with unused credit', owned: 0n, credit: 100n, hold: 0n, amount: 100n, ok: false },
  { name: 'owned only', owned: 100n, credit: 0n, hold: 0n, amount: 100n, ok: true },
  { name: 'mixed cannot borrow remainder', owned: 40n, credit: 100n, hold: 0n, amount: 41n, ok: false },
  { name: 'mixed spends exact owned balance', owned: 40n, credit: 100n, hold: 0n, amount: 40n, ok: true },
  { name: 'held owned funds unavailable', owned: 100n, credit: 100n, hold: 60n, amount: 41n, ok: false },
  { name: 'unheld owned funds available', owned: 100n, credit: 100n, hold: 60n, amount: 40n, ok: true },
  { name: 'negative owned balance cannot borrow', owned: -20n, credit: 100n, hold: 0n, amount: 1n, ok: false },
];

for (const byLeft of [true, false]) for (const vector of cases) {
  test(`lending_fund ${byLeft ? 'left' : 'right'} ${vector.name}`, async () => {
    const account = makeAccount(left, right);
    const delta = createDefaultDelta(1);
    delta.offdelta = byLeft ? vector.owned : -vector.owned;
    // These vectors isolate the saver-owned principal check. The bank already
    // owes up to 100 and needs one explicitly permitted unit for the coupon.
    delta.leftCreditLimit = byLeft ? vector.credit : 101n;
    delta.rightCreditLimit = byLeft ? 101n : vector.credit;
    delta.leftHold = byLeft ? vector.hold : 0n;
    delta.rightHold = byLeft ? 0n : vector.hold;
    account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]);
    const before = computeAccountStateRootCold(account.state);
    const result = await applyAccountTxToMutableReplica(account, {
      type: 'lending_fund',
      data: {
        positionId: 'lend-1111111111111111', hubEntityId: byLeft ? right : left,
        lenderEntityId: byLeft ? left : right, tokenId: 1, amount: vector.amount,
        termId: '1d', interestBps: 100,
      },
    }, byLeft, 1_000);
    expect(result.ok).toBe(vector.ok);
    if (!result.ok) {
      expect(result.rejection.message).toBe('LENDING_FUND_OWNED_BALANCE_INSUFFICIENT');
      expect(computeAccountStateRootCold(account.state)).toBe(before);
      expect(account.state.lendingIntents?.size ?? 0).toBe(0);
    } else {
      expect(account.state.deltas.get(1)!.offdelta).toBe(delta.offdelta + (byLeft ? -vector.amount : vector.amount));
      expect(account.state.lendingIntents?.get('fund:lend-1111111111111111')).toBe('fund');
    }
  });
}
