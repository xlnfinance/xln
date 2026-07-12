import { describe, expect, test } from 'bun:test';

import { applyAccountTx } from '../account/tx/apply';
import { createEntityFrameHash } from '../entity-consensus-frame';
import { applyCommittedAccountFrameFollowups, type MempoolOp } from '../entity/tx/handlers/account';
import type { AccountFrame, AccountMachine, AccountTx, ConsensusConfig, EntityState } from '../types';
import { createDefaultDelta } from '../validation-utils';

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
  messages: [],
  proposals: new Map(),
  config: makeConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `0x${'11'.repeat(32)}`,
  entityEncPrivKey: `0x${'22'.repeat(32)}`,
  profile: { name: 'Hub', isHub: true, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

const makeAccount = (counterparty: string): AccountMachine => {
  const delta = createDefaultDelta(1);
  delta.collateral = 20_000n;
  delta.leftCreditLimit = 20_000n;
  delta.rightCreditLimit = 20_000n;
  return {
    leftEntity: HUB,
    rightEntity: counterparty,
    watchSeed: `0x${'99'.repeat(32)}`,
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
    deltas: new Map([[1, delta]]),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 1,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: HUB, toEntity: counterparty, nextProofNonce: 1 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    locks: new Map(),
    swapOffers: new Map(),
    pulls: new Map(),
    swapOrderHistory: new Map(),
    swapClosedOrders: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    jNonce: 0,
  };
};

const frame = (tx: AccountTx, byLeft: boolean, timestamp: number): AccountFrame => ({
  height: 2,
  timestamp,
  jHeight: 0,
  accountTxs: [tx],
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
): Promise<MempoolOp[]> => {
  const result = await applyAccountTx(state.accounts.get(counterparty)!, tx, byLeft, timestamp, 0, false);
  expect(result.success, result.error).toBe(true);
  const followups: MempoolOp[] = [];
  applyCommittedAccountFrameFollowups(state, counterparty, frame(tx, byLeft, timestamp), followups);
  return followups;
};

describe('payer-authenticated hub lending', () => {
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
    const offdeltaAfterFirst = account.deltas.get(1)!.offdelta;
    await expect(applyAccountTx(account, tx, false)).rejects.toThrow('LENDING_INTENT_REPLAY');
    expect(account.deltas.get(1)!.offdelta).toBe(offdeltaAfterFirst);
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
