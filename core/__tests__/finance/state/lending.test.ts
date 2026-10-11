import { describe, expect, test } from 'bun:test';

import { applyAccountTx, applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { createEntityFrameHash } from '../../../entity/consensus/frame';
import { applyCommittedAccountFrameFollowups, type AccountTxTarget } from '../../../entity/tx/handlers/account/index';
import { collectDerivedDeadlines } from '../../../entity/scheduler/derived-deadlines';
import { settleOverdueLendingLoan } from '../../../lendbook/lifecycle';
import type { AccountFrame, AccountReplica, AccountTx } from '../../../types/account';
import type { ConsensusConfig, EntityState } from '../../../entity/types';
import { deriveDelta } from '../../../account/utils';
import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';
import { authorizeTestLending } from '../lending/bank-policy-fixture';
import { bankSavingsAdmissionError, approvedLendingDraw, lendingFacilityKey } from '../../../lendbook/policy';
import { handleLendingPolicy } from '../../../entity/tx/handlers/payments/lending-policy';
import { lendingPositionCloseAmount, summarizeLendingState } from '../../../lendbook/state';
import { collectLendingWithdrawals } from '../../../lendbook/withdrawals';
import { assertLendingCovenant, lendingCovenantHash } from '../../../protocol/dispute/lending-covenant';
import { encodeBuffer, decodeValidatedBuffer } from '../../../storage/codec/codec';
import { projectEntityCoreDoc } from '../../../storage/read/projections';
import { validateStorageEntityCoreDocValue } from '../../../storage/schema/schema-state-docs';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
} from '../../../account/state/candidate-overlay';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const HUB = entity('10');
const LENDER = entity('20');
const BORROWER = entity('30');
const SIGNER = `0x${'44'.repeat(20)}`;
const FRAME_HASH = `0x${'55'.repeat(32)}`;
const POSITION_ID = 'lend-1111111111111111';
const BORROW_REQUEST_ID = 'borrow-2222222222222222';

const makeConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [SIGNER],
  shares: { [SIGNER]: 1n },
});

const makeState = (): EntityState => ({
  entityId: HUB,
  entityEncryptionPublicKey: `0x${'77'.repeat(32)}`,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: makeConfig(),
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(HUB, computeEntityAccountValueHash),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: { name: 'Hub', isHub: true, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
});

const makeAccount = (counterparty: string): AccountReplica => {
  const delta = createDefaultDelta(1);
  delta.collateral = 20_000n;
  delta.leftCreditLimit = 20_000n;
  delta.rightCreditLimit = 20_000n;
  return {
    state: {
      leftEntity: HUB,
      rightEntity: counterparty,
      domain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]),
      disputeConfig: { leftResponseSeconds: 576, rightResponseSeconds: 576 },
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1,
      timestamp: 1_000,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: FRAME_HASH,
      deltas: [],
      stateHash: FRAME_HASH,
      accountStateRoot: `0x${'66'.repeat(32)}`,
      byLeft: true,
    },
    currentHeight: 1,
    rollbackCount: 0,
    proofHeader: { fromEntity: HUB, toEntity: counterparty, nextProofNonce: 1 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const frame = (tx: AccountTx | AccountTx[], timestamp: number): AccountFrame => ({
  height: 2,
  timestamp,
  jHeight: 0,
  accountTxs: Array.isArray(tx) ? tx : [tx],
  prevFrameHash: FRAME_HASH,
  stateHash: FRAME_HASH,
  accountStateRoot: `0x${'66'.repeat(32)}`,
});

const commit = async (
  state: EntityState,
  counterparty: string,
  tx: AccountTx,
  byLeft: boolean,
  timestamp: number,
): Promise<AccountTxTarget[]> => {
  const base = state.accounts.get(counterparty)!;
  const transition = beginAccountTransition(base);
  const result = await applyAccountTx(
    accountTransitionView(transition),
    tx,
    byLeft,
    timestamp,
    0,
    false,
  );
  expect(result.ok, result.ok ? undefined : result.rejection.message).toBe(true);
  state.accounts = state.accounts.updated(counterparty, {
    ...commitAccountTransition(transition).account, mempool: base.mempool.filter(queued => queued !== tx),
  });
  const followups: AccountTxTarget[] = [];
  applyCommittedAccountFrameFollowups(
    state,
    counterparty,
    frame(tx, timestamp),
    byLeft,
    followups,
    undefined,
    [],
  );
  const withdrawals = collectLendingWithdrawals(state);
  // Model the production post-book local admission; subsequent calls observe
  // the existing Account envelope until this exact payout commits.
  for (const { accountId, tx: payout } of withdrawals) {
    const account = state.accounts.get(accountId);
    if (!account) throw new Error('Withdrawal Account missing');
    state.accounts = state.accounts.updated(accountId, { ...account, mempool: [...account.mempool, payout] });
  }
  return [...followups, ...withdrawals];
};

const applyOnly = async (
  state: EntityState,
  counterparty: string,
  tx: AccountTx,
  byLeft: boolean,
  timestamp: number,
): Promise<Awaited<ReturnType<typeof applyAccountTx>>> => {
  const base = state.accounts.get(counterparty)!;
  const transition = beginAccountTransition(base);
  const result = await applyAccountTx(accountTransitionView(transition), tx, byLeft, timestamp);
  if (!result.ok) {
    discardAccountTransition(transition);
    return result;
  }
  state.accounts = state.accounts.updated(counterparty, commitAccountTransition(transition).account);
  return result;
};

const currentClaimHash = (state: EntityState, loanId: string): string => {
  const claim = state.accounts.get(BORROWER)!.state.subcontracts!.get(loanId);
  assertLendingCovenant(claim);
  return lendingCovenantHash(claim);
};

describe('payer-authenticated hub lending', () => {
  test('partial repayment reduces bank exposure, restores its signed facility and survives book recovery', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER, { loanInterestBps: 200, maxPrincipal: 2_500n });
    const request = { requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: BORROWER,
      tokenId: 1, amount: 2_500n, termId: '1d' as const, maxInterestBps: 200,
      maxLateMs: 0, expiresAt: 9_000_000_000_000 };
    const [draw] = await commit(state, BORROWER, { type: 'lending_borrow_request', data: request }, false, 2_000);
    await commit(state, BORROWER, draw!.tx, true, 2_001);
    const loan = [...state.lending!.loans.values()][0]!;
    const at = loan.openedAt + loan.termMs / 2 + 1;
    const partial: AccountTx = { type: 'lending_repay', data: {
      loanId: loan.loanId, hubEntityId: HUB, borrowerEntityId: BORROWER, tokenId: 1,
      amount: 1_025n, claimHash: currentClaimHash(state, loan.loanId),
    } };
    await commit(state, BORROWER, partial, false, at);
    expect(loan).toMatchObject({ status: 'active', principalAmount: 1_500n, repaidAmount: 1_025n,
      accruedAt: at, accruedInterest: 0n, interestRemainder: 500_000n });
    const restored = decodeValidatedBuffer(encodeBuffer(projectEntityCoreDoc(state)), validateStorageEntityCoreDocValue);
    expect(restored.lending).toEqual(state.lending);
    state.lending = restored.lending!;
    expect(summarizeLendingState(state).totals.loanPrincipalAmount).toBe('1500');
    const approval = (amount: bigint) => approvedLendingDraw(state, state.accounts.get(BORROWER)!, BORROWER,
      { ...request, requestId: 'borrow-3333333333333333', amount }, at);
    expect(approval(1_000n).ok).toBe(true);
    expect(approval(1_001n)).toEqual({ ok: false, reason: 'approved facility exhausted' });
    expect((await applyOnly(state, BORROWER, partial, false, at + 1)).ok).toBe(false);
    await commit(state, BORROWER, { type: 'lending_repay', data: {
      ...partial.data, amount: 2_000n, claimHash: currentClaimHash(state, loan.loanId),
    } }, false, loan.dueAt);
    expect(state.lending.loans.get(loan.loanId)).toMatchObject({ status: 'repaid', principalAmount: 0n,
      repaidAmount: 2_540n, repaymentAmount: 2_540n, accruedInterest: 0n, interestRemainder: 0n });
  });
  test.each([100n, 150n])('bank liquidity combines two saver deposits without assigning either saver to the loan: %s', async amount => {
    const state = makeState();
    const otherSaver = entity('40');
    for (const party of [LENDER, otherSaver, BORROWER]) {
      state.accounts = state.accounts.updated(party, makeAccount(party));
    }
    authorizeTestLending(state, BORROWER, { maxPrincipal: amount });
    for (const [lenderEntityId, positionId] of [
      [LENDER, POSITION_ID], [otherSaver, 'lend-3333333333333333'],
    ] as const) {
      await commit(state, lenderEntityId, { type: 'lending_fund', data: {
        positionId, hubEntityId: HUB, lenderEntityId, tokenId: 1,
        amount: 60n, termId: '1d', interestBps: 100,
      } }, false, 1_000);
    }
    expect(summarizeLendingState(state).totals.savingsPrincipalAmount).toBe('120');
    const [draw] = await commit(state, BORROWER, { type: 'lending_borrow_request', data: {
      requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: BORROWER,
      tokenId: 1, amount, termId: '1d', maxInterestBps: 100,
      maxLateMs: 0, expiresAt: 9_000,
    } }, false, 2_000);
    expect(draw?.tx).toMatchObject({ type: 'lending_disburse', data: { amount } });
    const loan = [...state.lending!.loans.values()][0]!;
    expect(loan).not.toHaveProperty('lenderEntityId');
    expect(loan).not.toHaveProperty('positionId');
    await commit(state, BORROWER, draw!.tx, true, 2_001);
    expect(loan.status).toBe('active');
    expect(summarizeLendingState(state).totals).toMatchObject({ savingsPrincipalAmount: '120', loanPrincipalAmount: String(amount) });
    expect(summarizeLendingState(state, { userEntityId: LENDER }).loans).toEqual([]);
    const restored = decodeValidatedBuffer(encodeBuffer(projectEntityCoreDoc(state)), validateStorageEntityCoreDocValue);
    expect(restored.lending).toEqual(state.lending);
    const loanWithOldAllocation = { ...loan, positionId: POSITION_ID };
    restored.lending!.loans.set(loan.loanId, loanWithOldAllocation);
    expect(() => validateStorageEntityCoreDocValue(restored)).toThrow('LENDING_ALLOCATION_MIGRATION_REQUIRED');
  });

  test('bank pricing and approval survive recovery; concurrent draws cannot exceed the facility', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER, { savingsInterestBps: 100, loanInterestBps: 200, maxPrincipal: 2_500n });
    const fund: AccountTx = { type: 'lending_fund', data: {
      positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
      tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
    } };
    expect(bankSavingsAdmissionError(state, state.accounts.get(LENDER)!, fund, 1_000)).toBeUndefined();
    expect(bankSavingsAdmissionError(state, state.accounts.get(LENDER)!, { ...fund, data: { ...fund.data, interestBps: 101 } }, 1_000)).toBe('LENDING_SAVINGS_RATE_NOT_APPROVED');
    await commit(state, LENDER, fund, false, 1_000);
    const request = (requestId: string): AccountTx => ({ type: 'lending_borrow_request', data: {
      requestId, hubEntityId: HUB, borrowerEntityId: BORROWER,
      tokenId: 1, amount: 1_500n, termId: '1d', maxInterestBps: 200, maxLateMs: 0, expiresAt: 9_000_000_000_000,
    } });
    const [draw] = await commit(state, BORROWER, request(BORROW_REQUEST_ID), false, 2_000);
    expect(draw!.tx).toMatchObject({ type: 'lending_disburse', data: { interestBps: 200 } });
    expect(await commit(state, BORROWER, request('borrow-3333333333333333'), false, 2_001)).toEqual([]);
    expect(state.lending!.savings.get(POSITION_ID)).toMatchObject({ principalAmount: 10_000n, interestBps: 100 });
    const loan = [...state.lending!.loans.values()][0]!;
    expect(loan).toMatchObject({ status: 'opening', accruedInterest: 0n, repaymentAmount: 1_530n, approval: { maxPrincipal: 2_500n, jNonce: 0 } });
    const wire = encodeBuffer(projectEntityCoreDoc(state));
    const restored = decodeValidatedBuffer(wire, validateStorageEntityCoreDocValue);
    expect(restored.lending).toEqual(state.lending);
    const forged = decodeValidatedBuffer(wire, validateStorageEntityCoreDocValue);
    const facilityKey = lendingFacilityKey(BORROWER, 1, '1d');
    forged.lending!.facilities!.set(facilityKey, { ...forged.lending!.facilities!.get(facilityKey)!, borrowerEntityId: LENDER });
    expect(() => validateStorageEntityCoreDocValue(forged)).toThrow('LENDING_FACILITY_KEY_INVALID');
    expect(approvedLendingDraw({ ...state, lending: restored.lending! }, state.accounts.get(BORROWER)!, BORROWER,
      { requestId: 'borrow-4444444444444444', hubEntityId: HUB, borrowerEntityId: BORROWER, tokenId: 1, amount: 1_500n, termId: '1d', maxInterestBps: 200, maxLateMs: 0, expiresAt: 9_000_000_000_000 }, 2_002)).toEqual({ ok: false, reason: 'approved facility exhausted' });
    handleLendingPolicy(state, { type: 'lendingApprove', data: { borrowerEntityId: BORROWER, tokenId: 1, termId: '1d', maxPrincipal: 0n, expiresAt: 9_000 } }, true);
    expect(loan.approval?.maxPrincipal).toBe(2_500n);
    // Revocation stops new draws; it cannot retract a signed pending funding
    // commitment or change the loan's terms when its Account ACK arrives.
    await commit(state, BORROWER, draw!.tx, true, 2_003);
    expect(loan).toMatchObject({ status: 'active', repaymentAmount: 1_530n });
    expect(await commit(state, BORROWER, request('borrow-5555555555555555'), false, 2_004)).toEqual([]);
  });

  for (const constraint of ['absent', 'expired', 'revoked', 'wrong-epoch', 'rate'] as const) {
    test(`a bank declines a draw with ${constraint} authority without allocating saver capital`, async () => {
      const state = makeState();
      state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
      state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
      authorizeTestLending(state, BORROWER, { expiresAt: constraint === 'expired' ? 1_999 : 9_000, maxPrincipal: constraint === 'revoked' ? 0n : 20_000n });
      if (constraint === 'absent') state.lending!.facilities!.clear();
      if (constraint === 'wrong-epoch') {
        const key = lendingFacilityKey(BORROWER, 1, '1d');
        state.lending!.facilities!.set(key, { ...state.lending!.facilities!.get(key)!, jNonce: 1 });
      }
      await commit(state, LENDER, { type: 'lending_fund', data: {
        positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
        tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
      } }, false, 1_000);
      expect(await commit(state, BORROWER, { type: 'lending_borrow_request', data: {
        requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: BORROWER,
        tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: constraint === 'rate' ? 99 : 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
      } }, false, 2_000)).toEqual([]);
      expect(state.lending!.savings.get(POSITION_ID)).toMatchObject({ principalAmount: 10_000n });
      expect(state.lending!.loans.size).toBe(0);
      expect(summarizeLendingState(state, { userEntityId: BORROWER, tokenId: 1, requestId: BORROW_REQUEST_ID }).requestStatus).toBe('not-funded');
      expect(summarizeLendingState(state, { userEntityId: LENDER, tokenId: 1, requestId: BORROW_REQUEST_ID }).requestStatus).toBe('unseen');
    });
  }

  test('a close request without a saver covenant rejects before consuming its id', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    const before = state.accounts.get(LENDER);
    const result = await applyOnly(state, LENDER, { type: 'lending_close_request', data: {
      positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
    } }, false, 2_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Unfunded withdrawal unexpectedly accepted');
    expect(result.rejection.message).toBe('LENDING_CLOSE_COVENANT_MISMATCH');
    expect(state.accounts.get(LENDER)).toBe(before);
  });

  test('a queued saver withdrawal survives restore and pays after capacity returns without another close request', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    await commit(state, LENDER, { type: 'lending_fund', data: {
      positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
      tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
    } }, false, 1_000);
    await commit(state, LENDER, { type: 'set_credit_limit', data: { tokenId: 1, amount: 0n } }, false, 2_000);
    state.timestamp = 86_401_000;
    expect(await commit(state, LENDER, { type: 'lending_close_request', data: {
      positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
    } }, false, state.timestamp)).toEqual([]);
    expect(state.lending!.savings.get(POSITION_ID)?.status).toBe('queued');
    authorizeTestLending(state, LENDER);
    expect(await commit(state, LENDER, { type: 'lending_borrow_request', data: {
      requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: LENDER,
      tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
    } }, false, state.timestamp)).toEqual([]);
    expect(state.lending!.loans.size).toBe(0);
    expect(readEntityFrameEventMessages(state)).toContain(`Lending request ${BORROW_REQUEST_ID} declined: pending withdrawal takes priority on this Account`);
    const restored = decodeValidatedBuffer(encodeBuffer(projectEntityCoreDoc(state)), validateStorageEntityCoreDocValue);
    expect(restored.lending).toEqual(state.lending);
    state.lending = restored.lending!;
    const [payout] = await commit(state, LENDER, { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } }, false, state.timestamp + 1);
    expect(payout?.tx).toMatchObject({ type: 'lending_close_payout', data: { amount: 10_100n } });
    await commit(state, LENDER, payout!.tx, true, state.timestamp + 2);
    expect(state.lending.savings.get(POSITION_ID)?.status).toBe('closed');
  });

  test('restored withdrawals use maturity then request admission, never map order or creditor id', async () => {
    const state = makeState();
    const third = entity('40');
    const positions = [
      { peer: LENDER, id: 'lend-1111111111111111', opened: 1_000 },
      { peer: BORROWER, id: 'lend-2222222222222222', opened: 2_000 },
      { peer: third, id: 'lend-3333333333333333', opened: 1_000 },
    ];
    for (const position of positions) {
      state.accounts = state.accounts.updated(position.peer, makeAccount(position.peer));
      await commit(state, position.peer, { type: 'lending_fund', data: {
        positionId: position.id, hubEntityId: HUB, lenderEntityId: position.peer,
        tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
      } }, false, position.opened);
      await commit(state, position.peer, { type: 'set_credit_limit', data: { tokenId: 1, amount: 0n } }, false, 3_000);
    }
    state.timestamp = 86_410_000;
    for (const peer of [BORROWER, third, LENDER]) {
      const position = positions.find(value => value.peer === peer);
      if (!position) throw new Error('Position missing');
      expect(await commit(state, peer, { type: 'lending_close_request', data: {
        positionId: position.id, hubEntityId: HUB, lenderEntityId: peer,
      } }, false, state.timestamp)).toEqual([]);
    }
    const restored = decodeValidatedBuffer(encodeBuffer(projectEntityCoreDoc(state)), validateStorageEntityCoreDocValue);
    if (!restored.lending) throw new Error('Restored book missing');
    state.lending = { ...restored.lending, savings: new Map([...restored.lending.savings].reverse()) };
    for (const { peer } of positions) await applyOnly(state, peer, {
      type: 'set_credit_limit', data: { tokenId: 1, amount: 100n },
    }, false, state.timestamp + 1);
    expect(collectLendingWithdrawals(state).map(value => value.accountId)).toEqual([third, LENDER, BORROWER]);
    const position = state.lending.savings.get(POSITION_ID);
    if (!position) throw new Error('Queued position missing');
    const before = await createEntityFrameHash(FRAME_HASH, 1, state.timestamp, [], state);
    position.closeOrder = 4;
    expect(await createEntityFrameHash(FRAME_HASH, 1, state.timestamp, [], state)).not.toBe(before);
    position.closeOrder = 1;
    expect(() => decodeValidatedBuffer(encodeBuffer(projectEntityCoreDoc(state)), validateStorageEntityCoreDocValue))
      .toThrow('LENDING_WITHDRAWAL_ORDER_INVALID');
  });

  for (const blockedBy of ['active-loan', 'payout-capacity'] as const) {
    test(`independent savings payout with ${blockedBy} and no duplicate payment`, async () => {
      const state = makeState();
      state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
      state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER);
      await commit(state, LENDER, { type: 'lending_fund', data: {
        positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
        tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
      } }, false, 1_000);
      if (blockedBy === 'active-loan') {
        const [draw] = await commit(state, BORROWER, { type: 'lending_borrow_request', data: {
          requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: BORROWER,
          tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
        } }, false, 2_000);
        await commit(state, BORROWER, draw!.tx, true, 2_001);
        state.timestamp = 3_000;
      } else {
        await commit(state, LENDER, { type: 'set_credit_limit', data: { tokenId: 1, amount: 0n } }, false, 2_000);
        state.timestamp = 1_000 + 86_400_000;
      }
      const pool = state.lending!.savings.get(POSITION_ID)!;
      const close: AccountTx = { type: 'lending_close_request', data: {
        positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
      } };
      let [payout] = await commit(state, LENDER, close, false, state.timestamp);
      if (blockedBy === 'payout-capacity') {
        expect(payout).toBeUndefined();
        expect(pool).toMatchObject({ status: 'queued', closeOrder: 1 });
        [payout] = await commit(state, LENDER, { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } }, false, state.timestamp + 1);
      } else {
        expect([...state.lending!.loans.values()][0]!.status).toBe('active');
      }
      expect(payout!.tx).toMatchObject({ type: 'lending_close_payout', data: { amount: blockedBy === 'active-loan' ? 10_000n : 10_100n } });
      expect(await commit(state, LENDER, close, false, state.timestamp + 3)).toEqual([]);
      await commit(state, LENDER, payout!.tx, true, state.timestamp + 4);
      expect(pool).toMatchObject({ status: 'closed', principalAmount: 10_000n });
      expect((await applyOnly(state, LENDER, close, false, state.timestamp + 5)).ok).toBe(false);
    });
  }

  test('an unapproved signed borrow request declines without halting or reserving money', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER, { maxPrincipal: 0n });
    const delta = state.accounts.get(BORROWER)!.state.deltas.get(1);
    const outputs = await commit(state, BORROWER, { type: 'lending_borrow_request', data: {
      requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: BORROWER,
      tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
    } }, false, 2_000);
    expect(outputs).toEqual([]);
    expect(state.accounts.get(BORROWER)!.state.deltas.get(1)).toEqual(delta);
    expect(state.accounts.get(BORROWER)!.state.lendingIntents?.get(`borrow:${BORROW_REQUEST_ID}`)).toBe('borrow');
    expect(state.lending?.loans.size).toBe(0);
    expect(state.lending?.savings.size).toBe(0);
    expect(readEntityFrameEventMessages(state)).toContain(`Lending request ${BORROW_REQUEST_ID} declined: no active bank approval`);
  });
  for (const mature of [false, true]) test(`saver claim has its own term interest, matured=${mature}`, async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    await commit(state, LENDER, { type: 'lending_fund', data: {
      positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
      tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
    } }, false, 1_000);
    state.timestamp = 1_000 + 86_400_000 - (mature ? 0 : 1);
    const [payout] = await commit(state, LENDER, { type: 'lending_close_request', data: {
      positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
    } }, false, state.timestamp);
    expect(payout?.tx).toMatchObject({ type: 'lending_close_payout', data: { amount: mature ? 10_100n : 10_000n } });
    await commit(state, LENDER, payout!.tx, true, state.timestamp + 1);
    expect(state.lending!.savings.get(POSITION_ID)).toMatchObject({ status: 'closed', principalAmount: 10_000n });
    expect(state.lending!.loans.size).toBe(0);
  });

  for (const mature of [false, true])
    test(`delayed savings close preserves the signed Account quote across restore, matured=${mature}`, async () => {
      const state = makeState();
      state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
      await commit(
        state,
        LENDER,
        {
          type: 'lending_fund',
          data: {
            positionId: POSITION_ID,
            hubEntityId: HUB,
            lenderEntityId: LENDER,
            tokenId: 1,
            amount: 10_000n,
            termId: '1d',
            interestBps: 100,
          },
        },
        false,
        1_000,
      );
      const signedAt = 86_401_000 - (mature ? 0 : 1);
      state.timestamp = signedAt + 60_000;
      const close: AccountTx = {
        type: 'lending_close_request',
        data: {
          positionId: POSITION_ID,
          hubEntityId: HUB,
          lenderEntityId: LENDER,
        },
      };
      const [payout] = await commit(state, LENDER, close, false, signedAt);
      expect(payout?.tx).toMatchObject({ type: 'lending_close_payout', data: { amount: mature ? 10_100n : 10_000n } });
      expect(state.lending!.savings.get(POSITION_ID)).toMatchObject({ updatedAt: signedAt, closeOrder: 1 });
      const restored = decodeValidatedBuffer(
        encodeBuffer(projectEntityCoreDoc(state)),
        validateStorageEntityCoreDocValue,
      );
      state.lending = restored.lending!;
      // A later retry cannot reprice the already-signed withdrawal or move it back in the queue.
      expect(await commit(state, LENDER, close, false, state.timestamp)).toEqual([]);
      expect(state.lending.savings.get(POSITION_ID)).toMatchObject({ updatedAt: signedAt, closeOrder: 1 });
      await commit(state, LENDER, payout!.tx, true, state.timestamp + 1);
      expect(state.lending.savings.get(POSITION_ID)?.status).toBe('closed');
      expect(state.accounts.get(LENDER)!.state.subcontracts?.has(POSITION_ID)).toBe(false);
    });

  for (const recovery of ['before-payout', 'after-payout', 'default-after-payout']) {
    test(`mature saver payout is independent of borrower recovery: ${recovery}`, async () => {
      const state = makeState();
      state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
      state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER);
      await commit(state, LENDER, { type: 'lending_fund', data: {
        positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
        tokenId: 1, amount: 10_000n, termId: '1d', interestBps: 100,
      } }, false, 1_000);
      const [draw] = await commit(state, BORROWER, { type: 'lending_borrow_request', data: {
        requestId: BORROW_REQUEST_ID, hubEntityId: HUB, borrowerEntityId: BORROWER,
        tokenId: 1, amount: 2_500n, termId: '1d', maxInterestBps: 100, maxLateMs: 0, expiresAt: 9_000_000_000_000,
      } }, false, 2_000);
      await commit(state, BORROWER, draw!.tx, true, 2_001);
      const loan = [...state.lending!.loans.values()][0]!;
      const pool = state.lending!.savings.get(POSITION_ID)!;
      state.timestamp = 1_000 + 86_400_000;
      expect(loan.dueAt).toBeGreaterThan(state.timestamp);
      const [payout] = await commit(state, LENDER, { type: 'lending_close_request', data: {
        positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER,
      } }, false, state.timestamp);
      expect(payout!.tx).toMatchObject({ type: 'lending_close_payout', data: { amount: 10_100n } });
      const repay: AccountTx = { type: 'lending_repay', data: {
        loanId: loan.loanId, hubEntityId: HUB, borrowerEntityId: BORROWER, tokenId: 1, amount: 2_525n,
        claimHash: currentClaimHash(state, loan.loanId),
      } };
      if (recovery === 'before-payout') await commit(state, BORROWER, repay, false, state.timestamp + 1);
      expect(lendingPositionCloseAmount(pool, state.timestamp)).toBe(10_100n);
      await commit(state, LENDER, payout!.tx, true, state.timestamp + 2);
      if (recovery === 'default-after-payout') {
        state.timestamp = loan.dueAt;
        settleOverdueLendingLoan(state, loan.loanId, []);
        expect(loan.status).toBe('defaulted');
        expect(lendingPositionCloseAmount(pool, state.timestamp)).toBe(0n);
      }
      if (recovery !== 'before-payout') await commit(state, BORROWER, repay, false, state.timestamp + 3);
      expect(loan).toMatchObject({ status: 'repaid', repaidAmount: recovery === 'default-after-payout' ? 2_525n : 2_524n });
      expect(pool).toMatchObject({ status: 'closed', principalAmount: 10_000n });
    });
  }

  test('batched loans transfer each principal and settle each repayment exactly once', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER);
    await commit(state, LENDER, {
      type: 'lending_fund',
      data: {
        positionId: POSITION_ID,
        hubEntityId: HUB,
        lenderEntityId: LENDER,
        tokenId: 1,
        amount: 1_000n,
        termId: '1d',
        interestBps: 100,
      },
    }, false, 1_000);

    const requestIds = ['borrow-aaaaaaaaaaaaaaaa', 'borrow-bbbbbbbbbbbbbbbb'];
    const borrows: AccountTx[] = [100n, 200n].map((amount, index) => ({
      type: 'lending_borrow_request',
      data: {
        requestId: requestIds[index]!,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount,
        termId: '1d',
        maxInterestBps: 150, maxLateMs: 0, expiresAt: 9_000_000_000_000,
      },
    }));
    for (const tx of borrows) expect((await applyOnly(state, BORROWER, tx, false, 2_000)).ok).toBe(true);
    const grants: AccountTxTarget[] = [];
    applyCommittedAccountFrameFollowups(
      state,
      BORROWER,
      frame(borrows, 2_000),
      false,
      grants,
      undefined,
      [],
    );
    expect(grants.map(output => output.tx.type === 'lending_disburse' ? output.tx.data.amount : 0n))
      .toEqual([100n, 200n]);

    for (const output of grants) {
      expect((await applyOnly(state, BORROWER, output.tx, true, 2_001)).ok).toBe(true);
    }
    applyCommittedAccountFrameFollowups(
      state,
      BORROWER,
      frame(grants.map(output => output.tx), 2_001),
      true,
      [],
      undefined,
      [],
    );
    const loans = [...state.lending!.loans.values()];
    const repayments: AccountTx[] = loans.map(loan => ({
      type: 'lending_repay',
      data: {
        loanId: loan.loanId,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: loan.repaymentAmount,
        claimHash: currentClaimHash(state, loan.loanId),
      },
    }));
    for (const tx of repayments) expect((await applyOnly(state, BORROWER, tx, false, 3_000)).ok).toBe(true);
    const revokes: AccountTxTarget[] = [];
    applyCommittedAccountFrameFollowups(
      state,
      BORROWER,
      frame(repayments, 3_000),
      false,
      revokes,
      undefined,
      [],
    );
    expect(revokes).toEqual([]);
    expect(loans.map(loan => loan.status)).toEqual(['repaid', 'repaid']);
    expect(deriveDelta(state.accounts.get(BORROWER)!.state.deltas.get(1)!, false).ownCreditLimit).toBe(20_000n);
  });

  test('fund, disburse, repay and withdraw conserve principal and interest', async () => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER);

    const fundTx: AccountTx = {
      type: 'lending_fund',
      data: {
        positionId: POSITION_ID,
        hubEntityId: HUB,
        lenderEntityId: LENDER,
        tokenId: 1,
        amount: 10_000n,
        termId: '1d',
        interestBps: 100,
      },
    };
    expect(await commit(state, LENDER, fundTx, false, 1_000)).toEqual([]);
    const pool = state.lending!.savings.get(POSITION_ID)!;
    expect(pool).toMatchObject({ status: 'open', principalAmount: 10_000n });

    const borrowTx: AccountTx = {
      type: 'lending_borrow_request',
      data: {
        requestId: BORROW_REQUEST_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_500n,
        termId: '1d',
        maxInterestBps: 150, maxLateMs: 0, expiresAt: 9_000_000_000_000,
      },
    };
    const [grant] = await commit(state, BORROWER, borrowTx, false, 2_000);
    expect(grant?.tx.type).toBe('lending_disburse');
    const loan = Array.from(state.lending!.loans.values())[0]!;
    expect(loan).toMatchObject({ status: 'opening', principalAmount: 2_500n, repaymentAmount: 2_525n });
    expect(summarizeLendingState(state, { userEntityId: BORROWER, requestId: BORROW_REQUEST_ID }).requestStatus).toBe('opening');
    expect(pool).toMatchObject({ principalAmount: 10_000n });

    const beforeDisbursement = deriveDelta(state.accounts.get(BORROWER)!.state.deltas.get(1)!, false);
    await commit(state, BORROWER, grant!.tx, true, 2_001);
    const afterDisbursement = deriveDelta(state.accounts.get(BORROWER)!.state.deltas.get(1)!, false);
    expect(afterDisbursement.ownCreditLimit).toBe(beforeDisbursement.ownCreditLimit);
    expect(afterDisbursement.outCollateral + afterDisbursement.outPeerCredit - afterDisbursement.inOwnCredit)
      .toBe(beforeDisbursement.outCollateral + beforeDisbursement.outPeerCredit - beforeDisbursement.inOwnCredit + 2_500n);
    expect(loan.status).toBe('active');
    expect(summarizeLendingState(state, { userEntityId: BORROWER, requestId: BORROW_REQUEST_ID }).requestStatus).toBe('active');
    const principalDelta = state.accounts.get(BORROWER)!.state.deltas.get(1)!.offdelta;
    await expect(applyOnly(state, BORROWER, grant!.tx, true, 2_002)).rejects.toThrow('LENDING_INTENT_REPLAY');
    expect(state.accounts.get(BORROWER)!.state.deltas.get(1)!.offdelta).toBe(principalDelta);


    const repayTx: AccountTx = {
      type: 'lending_repay',
      data: {
        loanId: loan.loanId,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_525n,
        claimHash: currentClaimHash(state, loan.loanId),
      },
    };
    const repaymentAt = loan.openedAt + loan.termMs / 2;
    expect(await commit(state, BORROWER, repayTx, false, repaymentAt)).toEqual([]);
    const afterRepayment = deriveDelta(state.accounts.get(BORROWER)!.state.deltas.get(1)!, false);
    expect(afterRepayment.ownCreditLimit).toBe(beforeDisbursement.ownCreditLimit);
    expect(afterRepayment.outCollateral + afterRepayment.outPeerCredit - afterRepayment.inOwnCredit)
      .toBe(beforeDisbursement.outCollateral + beforeDisbursement.outPeerCredit - beforeDisbursement.inOwnCredit - 12n);
    expect(loan).toMatchObject({ status: 'repaid', repaidAmount: 2_512n });
    // The bank collected half-term interest rounded down. Early saver cancellation does not earn
    // the separate one-day deposit return or receive that borrower's payment.
    expect(pool).toMatchObject({ principalAmount: 10_000n });

    const closeTx: AccountTx = {
      type: 'lending_close_request',
      data: { positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER },
    };
    const [payout] = await commit(state, LENDER, closeTx, false, repaymentAt + 1);
    expect(payout?.tx).toMatchObject({
      type: 'lending_close_payout',
      data: { positionId: POSITION_ID, amount: 10_000n },
    });
    expect(pool.status).toBe('queued');

    await commit(state, LENDER, payout!.tx, true, repaymentAt + 2);
    expect(pool).toMatchObject({ status: 'closed', principalAmount: 10_000n });
  });

  test.each([[false, 0], [true, 0], [false, 86_400_000], [true, 86_400_000]] as const)('overdue repayment: saver withdrawn=%s, late window=%s', async (withdraw, lateMs) => {
    const state = makeState();
    state.accounts = state.accounts.updated(LENDER, makeAccount(LENDER));
    state.accounts = state.accounts.updated(BORROWER, makeAccount(BORROWER));
    authorizeTestLending(state, BORROWER, { loanLateMs: lateMs });
    await commit(state, LENDER, {
      type: 'lending_fund',
      data: {
        positionId: POSITION_ID,
        hubEntityId: HUB,
        lenderEntityId: LENDER,
        tokenId: 1,
        amount: 10_000n,
        termId: '1d',
        interestBps: 100,
      },
    }, false, 1_000);
    const [grant] = await commit(state, BORROWER, {
      type: 'lending_borrow_request',
      data: {
        requestId: BORROW_REQUEST_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_500n,
        termId: '1d',
        maxInterestBps: 150, maxLateMs: lateMs, expiresAt: 9_000_000_000_000,
      },
    }, false, 2_000);
    await commit(state, BORROWER, grant!.tx, true, 2_001);
    const loan = Array.from(state.lending!.loans.values())[0]!;
    const pool = state.lending!.savings.get(POSITION_ID)!;
    // The committed disbursement starts the signed term, not the earlier request.
    expect(loan).toMatchObject({ status: 'active', openedAt: 2_001, dueAt: 2_001 + 86_400_000 });
    expect(pool).toMatchObject({ principalAmount: 10_000n });

    // Nothing fires before the term ends; the deadline is the loan's own dueAt.
    state.timestamp = loan.dueAt - 1;
    expect(collectDerivedDeadlines(state, state.timestamp)).toEqual([]);
    state.timestamp = loan.dueAt;
    expect(collectDerivedDeadlines(state, state.timestamp).map(deadline => deadline.id))
      .toEqual([`lending-overdue:${loan.loanId}`]);

    const settlement: AccountTxTarget[] = [];
    settleOverdueLendingLoan(state, loan.loanId, settlement);
    // The lender's principal is released; the interest is never earned.
    expect(loan).toMatchObject({ status: 'defaulted', repaidAmount: 0n, repaymentAmount: 2_525n });
    expect(pool).toMatchObject({ principalAmount: 10_000n });
    expect(settlement).toEqual([]);
    expect(collectDerivedDeadlines(state, state.timestamp)).toEqual([]);
    settleOverdueLendingLoan(state, loan.loanId, settlement);
    expect(settlement).toEqual([]);
    expect(deriveDelta(state.accounts.get(BORROWER)!.state.deltas.get(1)!, false).ownCreditLimit).toBe(20_000n);

    if (withdraw) {
      // The bank pays its own depositor liability; its borrower still owes it.
      const [payout] = await commit(state, LENDER, {
        type: 'lending_close_request',
        data: { positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER },
      }, false, loan.dueAt + 2);
      expect(payout?.tx).toMatchObject({
        type: 'lending_close_payout',
        data: { positionId: POSITION_ID, amount: 10_100n },
      });
      await commit(state, LENDER, payout!.tx, true, loan.dueAt + 3);
      expect(pool).toMatchObject({ status: 'closed', principalAmount: 10_000n });
    }
    const restored = decodeValidatedBuffer(encodeBuffer(projectEntityCoreDoc(state)), validateStorageEntityCoreDocValue);
    expect(restored.lending?.loans.get(loan.loanId)?.lateMs).toBe(lateMs);
    // A newer Entity clock cannot charge more than the certified Account clock.
    state.timestamp = loan.dueAt + 86_400_000;
    expect(summarizeLendingState(state).loans[0]?.repaymentAmount).toBe(lateMs ? 2_550n : 2_525n);
    const repaymentAt = loan.dueAt + 43_200_000;
    const actualPaid = lateMs ? 2_537n : 2_525n;
    const poolBeforeRecovery = { ...pool };
    const beforeRepay = state.accounts.get(BORROWER)!.state.deltas.get(1)!.offdelta;
    const repayment: AccountTx = {
      type: 'lending_repay',
      data: { loanId: loan.loanId, hubEntityId: HUB, borrowerEntityId: BORROWER, tokenId: 1, amount: lateMs ? 2_550n : 2_525n, claimHash: currentClaimHash(state, loan.loanId) },
    };
    expect(await commit(state, BORROWER, repayment, false, repaymentAt)).toEqual([]);
    expect(loan).toMatchObject({ status: 'repaid', repaidAmount: actualPaid, repaymentAmount: actualPaid });
    // Default already released the depositor principal. Recovery belongs to
    // the bank: adding it to that position again would create a second claim.
    expect(pool).toEqual(poolBeforeRecovery);
    const afterRepay = state.accounts.get(BORROWER)!.state.deltas.get(1)!.offdelta;
    expect(afterRepay).toBe(beforeRepay + actualPaid);
    await expect(applyOnly(state, BORROWER, repayment, false, repaymentAt + 1))
      .rejects.toThrow('LENDING_INTENT_REPLAY');
    expect(state.accounts.get(BORROWER)!.state.deltas.get(1)!.offdelta).toBe(afterRepay);
  });

  test('rejects forged payer direction and duplicate financial intents before moving delta twice', async () => {
    const account = makeAccount(LENDER);
    const tx: AccountTx = {
      type: 'lending_fund',
      data: {
        positionId: POSITION_ID,
        hubEntityId: HUB,
        lenderEntityId: LENDER,
        tokenId: 1,
        amount: 1_000n,
        termId: '1d',
        interestBps: 100,
      },
    };

    await expect(applyAccountTxToMutableReplica(account, tx, true)).rejects.toThrow('LENDING_LENDER_NOT_PROPOSER');
    const first = await applyAccountTxToMutableReplica(account, tx, false);
    expect(first.ok).toBe(true);
    const offdeltaAfterFirst = account.state.deltas.get(1)!.offdelta;
    await expect(applyAccountTxToMutableReplica(account, tx, false)).rejects.toThrow('LENDING_INTENT_REPLAY');
    expect(account.state.deltas.get(1)!.offdelta).toBe(offdeltaAfterFirst);
  });

  test('entity frame hash commits hub lending state', async () => {
    const state = makeState();
    const before = await createEntityFrameHash(FRAME_HASH, 1, 1_000, [], state);
    state.lending = { savings: new Map(), loans: new Map() };
    state.lending.savings.set(POSITION_ID, {
      positionId: POSITION_ID,
      hubEntityId: HUB,
      lenderEntityId: LENDER,
      tokenId: 1,
      principalAmount: 1_000n,
      interestBps: 100,
      termId: '1d',
      termMs: 86_400_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      status: 'open',
    });
    const after = await createEntityFrameHash(FRAME_HASH, 1, 1_000, [], state);
    expect(after).not.toBe(before);
  });
});
