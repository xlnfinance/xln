import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEmptyEnv } from '../../../runtime';
import { buildPreparedCrossJurisdictionRoute, buildCrossJurisdictionPullBinding } from '../../../extensions/cross-j';
import { validateProposalTransactions } from '../../../account/consensus/proposal/transactions';
import { getPullLockAdmissionError } from '../../../account/tx/handlers/settlement/pull';
import type { AccountTx } from '../../../types/account';
import { expect, test } from 'bun:test';
import { makeAccount, entity, jref, makeJurisdiction, putTestAccountDelta } from '../../helpers/cross-j';
import { createDefaultDelta } from '../../../account/state/delta';
import { buildCanonicalProofBatches } from '../../../protocol/dispute/proof-builder';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { disputeGasCharge, disputeGasAdmissionError } from '../../../account/validation/dispute-gas-budget';

const LEFT = entity('11');
const RIGHT = entity('22');

test('same-j swap admits a signable proof before the receiving token has a balance', async () => {
  const account = makeAccount(LEFT, RIGHT);
  expect(account.state.deltas.has(2)).toBe(false);
  const result = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'swap_offer',
      data: {
        offerId: 'first-receiving-token',
        giveTokenId: 1,
        giveTokenDecimals: 0,
        giveAmount: 10n,
        wantTokenId: 2,
        wantTokenDecimals: 0,
        wantAmount: 10n,
        maxFee: 0n,
        minNetReceive: 10n,
      },
    },
    true,
  );
  expect(result.ok).toBe(true);
  expect(account.state.deltas.get(2)?.offdelta).toBe(0n);
  expect(buildCanonicalProofBatches(account)).toHaveLength(1);
});

test('re-adding a existing over-budget token preserves its committed rows', async () => {
  const account = makeAccount(LEFT, RIGHT);
  for (let tokenId = 2; tokenId <= 11; tokenId++) putTestAccountDelta(account, createDefaultDelta(tokenId));
  const before = [...account.state.deltas];
  expect((await applyAccountTxToMutableReplica(account, { type: 'add_delta', data: { tokenId: 1 } }, true)).ok).toBe(
    true,
  );
  expect([...account.state.deltas]).toEqual(before);
});

test('add_delta refuses the first over-budget row atomically; the next valid payment still succeeds', async () => {
  const account = makeAccount(LEFT, RIGHT);
  for (let tokenId = 2; tokenId <= 10; tokenId++) {
    const result = await applyAccountTxToMutableReplica(account, { type: 'add_delta', data: { tokenId } }, true);
    expect(result.ok).toBe(true);
  }
  const before = account.state.deltas;
  const result = await applyAccountTxToMutableReplica(account, { type: 'add_delta', data: { tokenId: 11 } }, true);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected gas budget rejection');
  expect(result.rejection.message).toBe('ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5200000/5000000');
  expect(account.state.deltas).toBe(before);
  expect(account.state.deltas.has(11)).toBe(false);
  const payment = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        route: [RIGHT],
        deliveryMode: 'direct',
      },
    },
    true,
  );
  expect(payment.ok).toBe(true);
  expect(account.state.deltas.get(1)?.offdelta).toBe(-1n);
});

test('combined proof budget charges all dimensions, not separate lock maxima', () => {
  expect(disputeGasCharge(2, 32, 1)).toBe(3_778_000);
  expect(disputeGasCharge(2, 32, 32)).toBeGreaterThan(5_000_000);
  expect(disputeGasCharge(128, 82, 3)).toBeGreaterThan(17_000_000);
});

test('existing oversized obligations can cancel, but cannot add new work', () => {
  expect(
    disputeGasAdmissionError(6_000_000, 5_500_000, { type: 'swap_cancel_request', data: { offerId: 'old' } }),
  ).toBeUndefined();
  expect(disputeGasAdmissionError(6_000_000, 6_200_000, { type: 'add_delta', data: { tokenId: 1 } })).toContain(
    'GAS_BUDGET_EXCEEDED',
  );
  expect(disputeGasAdmissionError(6_000_000, 6_000_000, { type: 'add_delta', data: { tokenId: 1 } })).toBeUndefined();
});

test('cross_pull_lock refuses before mutation and remains queued when a concurrent proposal spends its budget', async () => {
  const jurisdiction = makeJurisdiction('Testnet', 31337, 'dd', 'ee');
  const account = makeAccount(RIGHT, LEFT);
  for (let tokenId = 2; tokenId <= 10; tokenId++) {
    expect((await applyAccountTxToMutableReplica(account, { type: 'add_delta', data: { tokenId } }, false)).ok).toBe(
      true,
    );
  }
  const prepared = buildPreparedCrossJurisdictionRoute(
    {
      orderId: 'gas-budget-cohort',
      makerEntityId: LEFT,
      hubEntityId: RIGHT,
      source: {
        jurisdiction: jref(jurisdiction),
        entityId: LEFT,
        counterpartyEntityId: RIGHT,
        tokenId: 1,
        amount: 10n,
      },
      target: {
        jurisdiction: jref(makeJurisdiction('Other', 31338, 'cc', 'bb')),
        entityId: entity('33'),
        counterpartyEntityId: entity('44'),
        tokenId: 1,
        amount: 10n,
      },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      status: 'resting',
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 61000,
    },
    { runtimeSeed: 'gas-budget-cohort', now: 1000 },
  );
  const route = { ...prepared, status: 'resting' as const };
  if (!route.sourcePull) throw new Error('Expected prepared source pull');
  const pull = route.sourcePull;
  const tx: Extract<AccountTx, { type: 'cross_pull_lock' }> = {
    type: 'cross_pull_lock',
    data: {
      pullId: pull.pullId,
      tokenId: pull.tokenId,
      amount: pull.signedAmount,
      fullHash: pull.fullHash,
      partialRoot: pull.partialRoot,
      crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
      crossJurisdictionRoute: route,
    },
  };
  expect(getPullLockAdmissionError(account.state, tx)).toBe('ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5100000/5000000');
  const result = await validateProposalTransactions({
    consensusContext: createAccountConsensusContext(createEmptyEnv()),
    account,
    proposalWindow: [tx],
    frameTimestamp: 2000,
    frameJHeight: 0,
    jClaimNodeStore: new Map(),
  });
  expect(result.validTxs).toEqual([]);
  expect(result.txsToRemove).toEqual([]);
  expect(result.deferredTxCount).toBe(1);
  expect(account.state.pulls?.size ?? 0).toBe(0);
  expect(account.state.deltas.get(1)?.offdelta).toBe(0n);
});

test('htlc_lock rejects the clause-splitting boundary without reserving funds', async () => {
  const account = makeAccount(LEFT, RIGHT);
  for (let tokenId = 2; tokenId <= 8; tokenId++) {
    expect((await applyAccountTxToMutableReplica(account, { type: 'add_delta', data: { tokenId } }, true)).ok).toBe(
      true,
    );
  }
  for (let index = 1; index <= 30; index++) {
    const hashlock = `0x${index.toString(16).padStart(64, '0')}`;
    const result = await applyAccountTxToMutableReplica(
      account,
      {
        type: 'htlc_lock',
        data: { lockId: hashlock, hashlock, amount: 1n, tokenId: 1, timelock: 60_000n, revealBeforeHeight: 10 },
      },
      true,
      1000,
      0,
    );
    if (index < 30) expect(result.ok).toBe(true);
    else {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Over-budget clause split admitted');
      expect(result.rejection.message).toBe('ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5064000/5000000');
      expect(account.state.locks.has(hashlock)).toBe(false);
    }
  }
  expect(account.state.locks.size).toBe(29);
  expect(account.state.deltas.get(1)?.leftHold).toBe(29n);
});
