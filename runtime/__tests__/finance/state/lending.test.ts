import { describe, expect, test } from 'bun:test';

import { applyAccountTx } from '../../../account/tx/apply';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { createEntityFrameHash } from '../../../entity/consensus/frame';
import { applyCommittedAccountFrameFollowups, type AccountTxTarget } from '../../../entity/tx/handlers/account/index';
import type { AccountFrame, AccountReplica, AccountTx } from '../../../types/account';
import type { ConsensusConfig, EntityState } from '../../../entity/types';
import { createDefaultDelta } from '../../../account/state/delta';

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
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: makeConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: { name: 'Hub', isHub: true, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
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
      deltas: new Map([[1, delta]]),
      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
      disputeConfig: { leftResponseSeconds: 576, rightResponseSeconds: 576 },
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
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
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: HUB, toEntity: counterparty, nextProofNonce: 1 },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    swapOrderHistory: new Map(),
    swapClosedOrders: new Map(),
  };
};

const frame = (tx: AccountTx | AccountTx[], byLeft: boolean, timestamp: number): AccountFrame => ({
  height: 2,
  timestamp,
  jHeight: 0,
  accountTxs: Array.isArray(tx) ? tx : [tx],
  prevFrameHash: FRAME_HASH,
  deltas: [],
  stateHash: FRAME_HASH,
  accountStateRoot: `0x${'66'.repeat(32)}`,
  byLeft,
});

const commit = async (
  state: EntityState,
  counterparty: string,
  tx: AccountTx,
  byLeft: boolean,
  timestamp: number,
): Promise<AccountTxTarget[]> => {
  const result = await applyAccountTx(state.accounts.get(counterparty)!, tx, byLeft, timestamp, 0, false);
  expect(result.success, result.error).toBe(true);
  const followups: AccountTxTarget[] = [];
  applyCommittedAccountFrameFollowups(state, counterparty, frame(tx, byLeft, timestamp), followups, undefined, []);
  return followups;
};

describe('payer-authenticated hub lending', () => {
  test('projects batched grants and revokes instead of overwriting absolute credit', async () => {
    const state = makeState();
    state.accounts.set(LENDER, makeAccount(LENDER));
    state.accounts.set(BORROWER, makeAccount(BORROWER));
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
        maxInterestBps: 150,
      },
    }));
    const borrowerAccount = state.accounts.get(BORROWER)!;
    for (const tx of borrows) expect((await applyAccountTx(borrowerAccount, tx, false)).success).toBe(true);
    const grants: AccountTxTarget[] = [];
    applyCommittedAccountFrameFollowups(state, BORROWER, frame(borrows, false, 2_000), grants, undefined, []);
    expect(grants.map(output => output.tx.type === 'lending_credit' ? output.tx.data.creditLimit : 0n))
      .toEqual([20_100n, 20_300n]);

    for (const output of grants) expect((await applyAccountTx(borrowerAccount, output.tx, true)).success).toBe(true);
    applyCommittedAccountFrameFollowups(
      state,
      BORROWER,
      frame(grants.map(output => output.tx), true, 2_001),
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
      },
    }));
    for (const tx of repayments) expect((await applyAccountTx(borrowerAccount, tx, false)).success).toBe(true);
    const revokes: AccountTxTarget[] = [];
    applyCommittedAccountFrameFollowups(state, BORROWER, frame(repayments, false, 3_000), revokes, undefined, []);
    expect(revokes.map(output => output.tx.type === 'lending_credit' ? output.tx.data.creditLimit : 0n))
      .toEqual([20_200n, 20_000n]);
  });

  test('fund, borrow, grant, repay, and revoke finalize only after matching bilateral commits', async () => {
    const state = makeState();
    state.accounts.set(LENDER, makeAccount(LENDER));
    state.accounts.set(BORROWER, makeAccount(BORROWER));

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
    const pool = state.lending!.pools.get(POSITION_ID)!;
    expect(pool).toMatchObject({ status: 'open', availableAmount: 10_000n, borrowedAmount: 0n });

    const borrowTx: AccountTx = {
      type: 'lending_borrow_request',
      data: {
        requestId: BORROW_REQUEST_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_500n,
        termId: '1d',
        maxInterestBps: 150,
      },
    };
    const [grant] = await commit(state, BORROWER, borrowTx, false, 2_000);
    expect(grant?.tx.type).toBe('lending_credit');
    const loan = Array.from(state.lending!.loans.values())[0]!;
    expect(loan).toMatchObject({ status: 'opening', principalAmount: 2_500n, repaymentAmount: 2_525n });
    expect(pool).toMatchObject({ availableAmount: 7_500n, borrowedAmount: 2_500n });

    await commit(state, BORROWER, grant!.tx, true, 2_001);
    expect(loan.status).toBe('active');

    const repayTx: AccountTx = {
      type: 'lending_repay',
      data: {
        loanId: loan.loanId,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_525n,
      },
    };
    const [revoke] = await commit(state, BORROWER, repayTx, false, 3_000);
    expect(revoke?.tx).toMatchObject({ type: 'lending_credit', data: { action: 'revoke', loanId: loan.loanId } });
    expect(loan.status).toBe('closing');
    expect(pool).toMatchObject({ availableAmount: 7_500n, borrowedAmount: 2_500n });

    await commit(state, BORROWER, revoke!.tx, true, 3_001);
    expect(loan).toMatchObject({ status: 'repaid', repaidAmount: 2_525n });
    expect(pool).toMatchObject({ availableAmount: 10_025n, borrowedAmount: 0n });

    const closeTx: AccountTx = {
      type: 'lending_close_request',
      data: { positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER },
    };
    const [payout] = await commit(state, LENDER, closeTx, false, 4_000);
    expect(payout?.tx).toMatchObject({
      type: 'lending_close_payout',
      data: { positionId: POSITION_ID, amount: 10_025n },
    });
    expect(pool.status).toBe('closing');

    await commit(state, LENDER, payout!.tx, true, 4_001);
    expect(pool).toMatchObject({ status: 'closed', availableAmount: 0n, borrowedAmount: 0n });
  });

  test('rejects forged payer direction and duplicate financial intents before moving delta twice', async () => {
    const state = makeState();
    state.accounts.set(LENDER, makeAccount(LENDER));
    const account = state.accounts.get(LENDER)!;
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

    await expect(applyAccountTx(account, tx, true)).rejects.toThrow('LENDING_LENDER_NOT_PROPOSER');
    const first = await applyAccountTx(account, tx, false);
    expect(first.success).toBe(true);
    const offdeltaAfterFirst = account.state.deltas.get(1)!.offdelta;
    await expect(applyAccountTx(account, tx, false)).rejects.toThrow('LENDING_INTENT_REPLAY');
    expect(account.state.deltas.get(1)!.offdelta).toBe(offdeltaAfterFirst);
  });

  test('entity frame hash commits hub lending state', async () => {
    const state = makeState();
    const before = await createEntityFrameHash(FRAME_HASH, 1, 1_000, [], state);
    state.lending = { pools: new Map(), loans: new Map() };
    state.lending.pools.set(POSITION_ID, {
      positionId: POSITION_ID,
      hubEntityId: HUB,
      lenderEntityId: LENDER,
      tokenId: 1,
      principalAmount: 1_000n,
      availableAmount: 1_000n,
      borrowedAmount: 0n,
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
