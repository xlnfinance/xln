import { state as base } from './same-j-financial';
import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import { applyCommittedLendingFollowup } from '../../../core/lendbook/committed';
import { collectLendingWithdrawals } from '../../../core/lendbook/withdrawals';
import { demandSavingsRenewals } from '../../../core/lendbook/renewals';
import { retireDisputedLendingClaims } from '../../../core/lendbook/lifecycle';
import { accountLendingRisk } from '../../../core/account/validation/lending-risk';
import { lendingTermsKey } from '../../../core/lendbook/policy';
import { deriveDelta } from '../../../core/account/utils';
import { safeStringify } from '../../../core/protocol/serialization';
import { summarizeLendingState } from '../../../core/lendbook/state';
import type { AccountTx } from '../../../core/types/account';
const hub = `0x${'11'.repeat(32)}`,
  peer = `0x${'22'.repeat(32)}`,
  positionId = 'lend-1111111111111111';
export async function executeLendingServicingVectors() {
  const cases = [];
  for (const termId of ['1d', 'demand'] as const)
    for (const mode of ['open', 'early', 'mature', 'busy', 'rate', 'expired', 'no-capacity', 'late'] as const) {
      const s = base();
      s.profile!.isHub = true;
      let a = { ...s.accounts.get(peer)!, state: { ...s.accounts.get(peer)!.state }, mempool: [] as AccountTx[] };
      a.state.subcontracts = PersistentAccountStateMap.empty('subcontracts');
      const terms = {
        ...a.state.domain,
        tokenId: 1,
        termId,
        savingsInterestBps: 100,
        loanInterestBps: termId === 'demand' ? 0 : 100,
        loanLateMs: 0,
        expiresAt: 100_000_000_000,
      };
      s.lending = { savings: new Map(), loans: new Map(), terms: new Map([[lendingTermsKey(terms), terms]]) };
      const tx: Extract<AccountTx, { type: 'lending_fund' }> = {
        type: 'lending_fund',
        data: {
          positionId,
          hubEntityId: hub,
          lenderEntityId: peer,
          tokenId: 1,
          amount: 5000n,
          termId,
          interestBps: 100,
        },
      };
      const result = await applyAccountTxToMutableReplica(a, tx, false, 1000);
      if (!result.ok) throw Error(result.rejection.message);
      s.accounts = s.accounts.updated(peer, a);
      applyCommittedLendingFollowup(s, peer, tx, { ...a.currentFrame, timestamp: 1000 }, false, []);
      a = { ...a, state: { ...a.state }, mempool: [...a.mempool] };
      s.timestamp = mode === 'late' ? 1000 + 31_536_000_001 : mode === 'mature' ? 1000 + 86_400_000 : 2000;
      if (mode === 'early' || mode === 'mature' || mode === 'no-capacity') {
        const close: AccountTx = {
          type: 'lending_close_request',
          data: { positionId, hubEntityId: hub, lenderEntityId: peer },
        };
        const result = await applyAccountTxToMutableReplica(a, close, false, s.timestamp);
        if (!result.ok) throw Error(result.rejection.message);
        applyCommittedLendingFollowup(s, peer, close, { ...a.currentFrame, timestamp: s.timestamp }, false, []);
      }
      if (mode === 'busy') a.mempool.push({ type: 'credit_limit', data: { tokenId: 1, amount: 1n } });
      if (mode === 'rate') terms.savingsInterestBps = 200;
      if (mode === 'expired') terms.expiresAt = s.timestamp;
      if (mode === 'no-capacity') {
        const d = a.state.deltas.get(1)!;
        a.state.deltas = a.state.deltas.updated(1, { ...d, leftHold: 20000n });
      }
      s.accounts = s.accounts.updated(peer, a);
      const delta = deriveDelta(a.state.deltas.get(1)!, true),
        risk = accountLendingRisk(a).get(1)!;
      const row = {
        name: `${termId}-${mode}`,
        time: s.timestamp,
        book: s.lending,
        claims: [...a.state.subcontracts],
        outCapacity: delta.outCapacity,
        leftCoupon: risk.leftCouponCapacity,
        rightCoupon: risk.rightCouponCapacity,
        busy: a.mempool.length > 0,
        withdrawals: collectLendingWithdrawals(s),
        renewals: demandSavingsRenewals(s),
        projection: summarizeLendingState(s, { userEntityId: peer }),
        retired: undefined as unknown,
      };
      row.book = structuredClone(s.lending);
      row.projection = structuredClone(row.projection);
      retireDisputedLendingClaims(s, a);
      row.retired = s.lending;
      cases.push(row);
    }
  return { cases };
}
if (import.meta.main)
  process.stdout.write(safeStringify(await executeLendingServicingVectors(), 2) + '\n');
