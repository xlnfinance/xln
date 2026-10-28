import { makeAccount, executeLendingAccountSemanticVector } from './lending';
import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { accountTxWire, accountSeedWire } from '../../../core/rscore/shadow-wire';
import { safeStringify } from '../../../core/protocol/serialization';
import {
  assertLendingCovenant,
  lendingCovenantHash,
  lendingMaximumAmount,
  LENDING_YEAR_MS,
} from '../../../core/protocol/dispute/lending-covenant';
import { buildAccountProofBody } from '../../../core/protocol/dispute/proof-builder';
import { computeLendingInterest } from '../../../core/lendbook/state';
import type { AccountTx, AccountReplica } from '../../../core/types/account';
import type { LendingTermId } from '../../../core/types/finance/lending';
const hub = `0x${'10'.repeat(32)}`,
  peer = `0x${'20'.repeat(32)}`;
const positionId = 'lend-1111111111111111',
  requestId = 'borrow-2222222222222222',
  loanId = 'loan-0327fd9035d42518';
const terms: LendingTermId[] = ['1h', '1d', '1m', 'demand'];
const periods = [3_600_000, 86_400_000, 2_592_000_000, LENDING_YEAR_MS];
const fund = (termId: LendingTermId, amount = 10000n, interestBps = 100): AccountTx => ({
  type: 'lending_fund',
  data: { positionId, hubEntityId: hub, lenderEntityId: peer, tokenId: 1, amount, termId, interestBps },
});
const borrow = (amount = 2500n, expiresAt = 5000): Extract<AccountTx, { type: 'lending_borrow_request' }> => ({
  type: 'lending_borrow_request',
  data: {
    requestId,
    hubEntityId: hub,
    borrowerEntityId: peer,
    tokenId: 1,
    amount,
    termId: '1d',
    maxInterestBps: 150,
    maxLateMs: 86400000,
    expiresAt,
  },
});
const draw = (): AccountTx => ({
  type: 'lending_disburse',
  data: { ...borrow().data, loanId, interestBps: 100, lateMs: 86400000 },
});
async function step(account: AccountReplica, tx: AccountTx, byLeft = false, timestamp = 1000) {
  const before = computeAccountStateRootCold(account.state);
  const result = await applyAccountTxToMutableReplica(account, tx, byLeft, timestamp);
  const root = computeAccountStateRootCold(account.state);
  if (!result.ok && root !== before) throw new Error('REJECT_MUTATED_STATE');
  const wire = (v: unknown): unknown =>
    v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('hex') } : Array.isArray(v) ? v.map(wire) : v;
  return {
    seed: wire(accountSeedWire(hub, peer, account.state)),
    proofBodyHash: buildAccountProofBody(account, `0x${'77'.repeat(20)}`).proofBodyHash,
    txType: tx.type,
    txWire: accountTxWire(tx),
    byLeft,
    timestamp,
    verdict: result.ok ? 'applied' : 'rejected',
    rejection: result.ok ? null : result.rejection,
    events: result.events,
    outputCount: result.ok ? (result.candidateEffects?.length ?? 0) : 0,
    accountStateRoot: root,
    deltasRoot: account.state.deltas.coldRootHash(),
    lendingIntentsRoot: account.state.lendingIntents?.coldRootHash() ?? `0x${'00'.repeat(32)}`,
    subcontractsRoot: account.state.subcontracts?.coldRootHash() ?? `0x${'00'.repeat(32)}`,
    claimEntries: [...(account.state.subcontracts ?? [])],
    intentEntries: [...(account.state.lendingIntents ?? [])].sort(([a], [b]) => a.localeCompare(b)),
  };
}
export async function executeLendingEdges() {
  const cases = [];
  for (const [index, term] of terms.entries())
    for (const offset of [-1, 0, 1]) {
      const a = makeAccount(peer),
        steps = [await step(a, fund(term))];
      if (term === 'demand') {
        const c = a.state.subcontracts?.get(positionId);
        assertLendingCovenant(c);
        steps.push(
          await step(
            a,
            {
              type: 'lending_rate',
              data: {
                positionId,
                hubEntityId: hub,
                lenderEntityId: peer,
                tokenId: 1,
                claimHash: lendingCovenantHash(c),
                interestBps: 0,
              },
            },
            true,
            2000,
          ),
        );
      }
      const time = 1000 + periods[index]! + offset;
      steps.push(
        await step(
          a,
          { type: 'lending_close_request', data: { positionId, hubEntityId: hub, lenderEntityId: peer } },
          false,
          time,
        ),
      );
      steps.push(
        await step(
          a,
          { type: 'lending_close_request', data: { positionId, hubEntityId: hub, lenderEntityId: peer } },
          false,
          time + 2,
        ),
      );
      const c = a.state.subcontracts?.get(positionId);
      assertLendingCovenant(c);
      steps.push(
        await step(
          a,
          {
            type: 'lending_close_payout',
            data: {
              positionId,
              hubEntityId: hub,
              lenderEntityId: peer,
              tokenId: 1,
              amount: term === 'demand' ? lendingMaximumAmount(c) : offset < 0 ? 10000n : 10100n,
            },
          },
          true,
          time + 2,
        ),
      );
      cases.push({ name: `${term}-close-${offset}`, steps });
    }
  for (const amount of [0n, 1n, 9999n, 10000n, 10001n])
    for (const rate of [0, 1, 10000]) {
      const a = makeAccount(peer);
      cases.push({ name: `fund-${amount}-${rate}`, steps: [await step(a, fund('1d', amount, rate))] });
    }
  for (const time of [999, 1000, 4999, 5000, 5001]) {
    const a = makeAccount(peer);
    cases.push({
      name: `expiry-${time}`,
      steps: [await step(a, borrow(), false, time), await step(a, draw(), true, time)],
    });
  }
  for (const time of [1000, 1001, 43201000, 86400999, 86401000, 86401001, 172801000, 172801001]) {
    const a = makeAccount(peer),
      steps = [await step(a, borrow()), await step(a, draw(), true)];
    const c = a.state.subcontracts?.get(loanId);
    assertLendingCovenant(c);
    const tx: AccountTx = {
      type: 'lending_repay',
      data: {
        loanId,
        hubEntityId: hub,
        borrowerEntityId: peer,
        tokenId: 1,
        amount: 1012n,
        claimHash: lendingCovenantHash(c),
      },
    };
    steps.push(await step(a, tx, false, time), await step(a, tx, false, time));
    const remainder = a.state.subcontracts?.get(loanId);
    assertLendingCovenant(remainder);
    steps.push(
      await step(
        a,
        { ...tx, data: { ...tx.data, amount: 5000n, claimHash: lendingCovenantHash(remainder) } },
        false,
        time + 1,
      ),
    );
    cases.push({ name: `repay-${time}`, steps });
  }
  for (const mode of ['role', 'peer', 'id', 'amount', 'rate', 'duplicate'] as const) {
    const a = makeAccount(peer);
    const tx = structuredClone(fund('1d')) as Extract<AccountTx, { type: 'lending_fund' }>;
    const steps = [];
    if (mode === 'role') tx.data.lenderEntityId = hub;
    if (mode === 'peer') tx.data.hubEntityId = peer;
    if (mode === 'id') tx.data.positionId = 'lend-bad';
    if (mode === 'amount') tx.data.amount = -1n;
    if (mode === 'rate') tx.data.interestBps = 10001;
    if (mode === 'duplicate') steps.push(await step(a, tx));
    steps.push(await step(a, tx));
    cases.push({ name: `fund-invalid-${mode}`, steps });
  }
  for (const mode of ['role', 'peer', 'id', 'amount', 'rate', 'duplicate', 'overflow'] as const) {
    const a = makeAccount(peer),
      tx = structuredClone(borrow()),
      steps = [];
    if (mode === 'role') tx.data.borrowerEntityId = hub;
    if (mode === 'peer') tx.data.hubEntityId = peer;
    if (mode === 'id') tx.data.requestId = 'borrow-bad';
    if (mode === 'amount') tx.data.amount = -1n;
    if (mode === 'rate') tx.data.maxInterestBps = -1;
    if (mode === 'overflow') tx.data.maxLateMs = Number.MAX_SAFE_INTEGER;
    if (mode === 'duplicate') steps.push(await step(a, tx));
    steps.push(await step(a, tx));
    cases.push({ name: `borrow-invalid-${mode}`, steps });
  }
  for (const mode of ['stale', 'same-time', 'past-expiry', 'invalid-rate', 'closed'] as const) {
    const a = makeAccount(peer),
      steps = [await step(a, fund('demand'))];
    const c = a.state.subcontracts!.get(positionId);
    assertLendingCovenant(c);
    if (mode === 'closed')
      steps.push(
        await step(
          a,
          { type: 'lending_close_request', data: { positionId, hubEntityId: hub, lenderEntityId: peer } },
          false,
          1500,
        ),
      );
    steps.push(
      await step(
        a,
        {
          type: 'lending_rate',
          data: {
            positionId,
            hubEntityId: hub,
            lenderEntityId: peer,
            tokenId: 1,
            claimHash: mode === 'stale' ? `0x${'00'.repeat(32)}` : lendingCovenantHash(c),
            interestBps: mode === 'invalid-rate' ? -1 : 100,
          },
        },
        true,
        mode === 'same-time' ? 1000 : mode === 'past-expiry' ? 1000 + LENDING_YEAR_MS + 1 : 2000,
      ),
    );
    cases.push({ name: `renewal-${mode}`, steps });
  }
  for (const mode of ['no-request','changed-amount','rate','late','replay']) {
    const a=makeAccount(peer),steps=[];if(mode!=='no-request')steps.push(await step(a,borrow()));
    const tx=structuredClone(draw()) as Extract<AccountTx,{type:'lending_disburse'}>;
    if(mode==='changed-amount')tx.data.amount+=1n;
    if(mode==='rate')tx.data.interestBps=151;
    if(mode==='late')tx.data.lateMs=86400001;
    if(mode==='replay')steps.push(await step(a,tx,true));
    steps.push(await step(a,tx,true));cases.push({name:`draw-${mode}`,steps});
  }
  for(const mode of ['no-close','wrong-amount','over-maximum','wrong-role']) {
    const a=makeAccount(peer),steps=[await step(a,fund('1d'))];
    if(mode!=='no-close')steps.push(await step(a,{type:'lending_close_request',data:{positionId,hubEntityId:hub,lenderEntityId:peer}},false,2000));
    steps.push(await step(a,{type:'lending_close_payout',data:{positionId,hubEntityId:hub,lenderEntityId:peer,tokenId:1,amount:mode==='wrong-amount'?10001n:mode==='over-maximum'?10101n:10000n}},mode!=='wrong-role',2000));
    cases.push({name:`payout-${mode}`,steps});
  }
  const ownership = [];
  for (const byLeft of [true, false])
    for (const [owned, credit, hold, amount] of [
      [0, 100, 0, 100],
      [100, 0, 0, 100],
      [40, 100, 0, 41],
      [40, 100, 0, 40],
      [100, 100, 60, 41],
      [100, 100, 60, 40],
      [-20, 100, 0, 1],
    ]) {
      const a = makeAccount(peer),
        d = a.state.deltas.get(1)!;
      a.state.deltas = a.state.deltas.updated(1, {
        ...d,
        collateral: 0n,
        ondelta: 0n,
        offdelta: BigInt(byLeft ? owned! : -owned!),
        leftCreditLimit: BigInt(byLeft ? credit! : 100),
        rightCreditLimit: BigInt(byLeft ? 100 : credit!),
        leftHold: BigInt(byLeft ? hold! : 0),
        rightHold: BigInt(byLeft ? 0 : hold!),
      });
      const tx = fund('1d', BigInt(amount!));
      if (tx.type !== 'lending_fund') throw Error('fund');
      tx.data.hubEntityId = byLeft ? peer : hub;
      tx.data.lenderEntityId = byLeft ? hub : peer;
      ownership.push({ byLeft, owned, credit, hold, amount, result: await step(a, tx, byLeft) });
    }
  const arithmetic = [];
  for (const principal of [-1n, 0n, 1n, 9999n, 10000n, 10001n])
    for (const interestBps of [0, 1, 9999, 10000])
      arithmetic.push({ principal, interestBps, interest: computeLendingInterest(principal, interestBps) });
  return {
    version: 1,
    canonicalSource: 'TypeScript production lending handlers',
    cases,
    ownership,
    arithmetic,
    lifecycle: await executeLendingAccountSemanticVector(),
  };
}
if (import.meta.main)
  process.stdout.write(safeStringify(await executeLendingEdges(), 2) + '\n');
