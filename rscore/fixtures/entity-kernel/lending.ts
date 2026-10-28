import { buildDefaultBankTermsTxs } from '../../../core/lendbook/default-terms';
import { state as base, executeSameJFinancialEntitySemanticVector } from './same-j-financial';
import { handleLendingPolicy } from '../../../core/entity/tx/handlers/payments/lending-policy';
import { applyCommittedLendingFollowup } from '../../../core/lendbook/committed';
import { settleOverdueLendingLoan } from '../../../core/lendbook/lifecycle';
import { summarizeLendingState } from '../../../core/lendbook/state';
import { lendingTermsKey, lendingFacilityKey } from '../../../core/lendbook/policy';
import { entitySnapshotWire } from '../../../core/rscore/entity/snapshot-wire';
import { safeStringify } from '../../../core/protocol/serialization';
import { readEntityFrameEvents } from '../../../core/entity/frame-events';
import type { EntityTx } from '../../../core/types/entity-tx';
import type { AccountTx } from '../../../core/types/account';
import type { AccountTxTarget } from '../../../core/entity/tx/handlers/account/orderbook/queue';
const hub = `0x${'11'.repeat(32)}`,
  peer = `0x${'22'.repeat(32)}`;
const terms = {
  chainId: 31337,
  depositoryAddress: `0x${'88'.repeat(20)}`,
  tokenId: 1,
  termId: '1d' as const,
  savingsInterestBps: 100,
  loanInterestBps: 100,
  loanLateMs: 86400000,
  expiresAt: 200000000,
};
export async function executeLendingBookVectors() {
  const commands: EntityTx[] = [
    { type: 'lendingSetTerms', data: terms },
    {
      type: 'lendingApprove',
      data: { borrowerEntityId: peer, tokenId: 1, termId: '1d', maxPrincipal: 10000n, expiresAt: 200000000 },
    },
  ];
  const policies = [];
  for (const isHub of [false, true])
    for (const tx of commands) {
      const s = base();
      s.profile!.isHub = isHub;
      try {
        const r = handleLendingPolicy(s, tx as Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>);
        policies.push({ isHub, tx, lending: r.newState.lending, events: readEntityFrameEvents(r.newState) });
      } catch (e) {
        policies.push({ isHub, tx, error: String(e) });
      }
    }
  const invalidPolicies = [];
  for (const mode of [
    'rate',
    'demand',
    'overflow',
    'extra',
    'negative',
    'zero',
    'facility-extra',
    'facility-demand',
    'facility-negative',
  ]) {
    const s = base();
    s.profile!.isHub = true;
    const tx = structuredClone(
      mode.startsWith('facility') || mode === 'zero' ? commands[1]! : commands[0]!,
    ) as EntityTx;
    const d = tx.data as unknown as Record<string, unknown>;
    if (mode === 'rate') d.savingsInterestBps = 10001;
    if (mode === 'demand') d.termId = 'demand';
    if (mode === 'overflow') d.expiresAt = Number.MAX_SAFE_INTEGER;
    if (mode === 'extra' || mode === 'facility-extra') d.jNonce = 9;
    if (mode === 'negative') d.loanLateMs = -1;
    if (mode === 'zero') d.maxPrincipal = 0n;
    if (mode === 'facility-demand') d.termId = 'demand';
    if (mode === 'facility-negative') d.maxPrincipal = -1n;
    try {
      const r = handleLendingPolicy(s, tx as Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>);
      invalidPolicies.push({ mode, tx, lending: r.newState.lending });
    } catch (e) {
      invalidPolicies.push({ mode, tx, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const s = base();
  s.profile!.isHub = true;
  s.config.jurisdiction = {
    chainId: 31337,
    depositoryAddress: terms.depositoryAddress,
    entityProviderAddress: `0x${'77'.repeat(20)}`,
  };
  for (const tx of commands)
    Object.assign(
      s,
      handleLendingPolicy(s, tx as Extract<EntityTx, { type: 'lendingSetTerms' | 'lendingApprove' }>).newState,
    );
  const snapshots: unknown[] = [];
  const wire = (v: unknown): unknown =>
    v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('hex') } : Array.isArray(v) ? v.map(wire) : v;
  const outputs: AccountTxTarget[] = [],
    steps = [];
  const apply = (tx: AccountTx, byLeft: boolean, time: number) => {
    s.timestamp = time;
    applyCommittedLendingFollowup(
      s,
      peer,
      tx,
      { ...s.accounts.get(peer)!.currentFrame, timestamp: time },
      byLeft,
      outputs,
    );
    steps.push({
      tx,
      byLeft,
      time,
      book: safeStringify(s.lending),
      projection: structuredClone(summarizeLendingState(s, { userEntityId: peer })),
      outputs: outputs.splice(0),
    });
    snapshots.push({ wire: wire(entitySnapshotWire(s)), accountsRoot: s.accounts.rootHash() });
  };
  apply(
    {
      type: 'lending_fund',
      data: {
        positionId: 'lend-1111111111111111',
        hubEntityId: hub,
        lenderEntityId: peer,
        tokenId: 1,
        amount: 10000n,
        termId: '1d',
        interestBps: 100,
      },
    },
    false,
    1000,
  );
  apply(
    {
      type: 'lending_borrow_request',
      data: {
        requestId: 'borrow-2222222222222222',
        hubEntityId: hub,
        borrowerEntityId: peer,
        tokenId: 1,
        amount: 2500n,
        termId: '1d',
        maxInterestBps: 150,
        maxLateMs: 86400000,
        expiresAt: 5000,
      },
    },
    false,
    1000,
  );
  const draw = steps.at(-1)!.outputs[0]!.tx;
  apply(draw, true, 2000);
  const loanId = [...s.lending!.loans.keys()][0]!;
  s.timestamp = 86402000;
  settleOverdueLendingLoan(s, loanId, outputs);
  steps.push({
    defaultAt: s.timestamp,
    book: safeStringify(s.lending),
    projection: structuredClone(summarizeLendingState(s, { userEntityId: peer })),
  });
  apply(
    {
      type: 'lending_repay',
      data: {
        loanId,
        hubEntityId: hub,
        borrowerEntityId: peer,
        tokenId: 1,
        amount: 1012n,
        claimHash: `0x${'00'.repeat(32)}`,
      },
    },
    false,
    86402001,
  );
  apply(
    {
      type: 'lending_repay',
      data: {
        loanId,
        hubEntityId: hub,
        borrowerEntityId: peer,
        tokenId: 1,
        amount: 5000n,
        claimHash: `0x${'00'.repeat(32)}`,
      },
    },
    false,
    172802000,
  );
  apply(
    {
      type: 'lending_close_request',
      data: { positionId: 'lend-1111111111111111', hubEntityId: hub, lenderEntityId: peer },
    },
    false,
    172802000,
  );
  apply(
    {
      type: 'lending_close_payout',
      data: { positionId: 'lend-1111111111111111', hubEntityId: hub, lenderEntityId: peer, tokenId: 1, amount: 10100n },
    },
    true,
    172802000,
  );
  return {
    defaults: buildDefaultBankTermsTxs({chainId:31337,depositoryAddress:terms.depositoryAddress},[1,2,3],1000),
    version: 1,
    commands: (await executeSameJFinancialEntitySemanticVector()).cases.filter(c => c.name.startsWith('lending')),
    policies,
    invalidPolicies,
    steps,
    snapshots,
    snapshot: s.lending,
  };
}
if (import.meta.main)
  process.stdout.write(safeStringify(await executeLendingBookVectors(), 2) + '\n');
