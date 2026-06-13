import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import { applyEntityTx } from '../entity-tx/apply';
import type { AccountMachine, ConsensusConfig, EntityState } from '../types';
import { createDefaultDelta } from '../validation-utils';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const HUB = entity('10');
const LENDER = entity('20');
const BORROWER = entity('30');
const SIGNER = `0x${'44'.repeat(20)}`;
const FRAME_HASH = `0x${'55'.repeat(32)}`;

const makeConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [SIGNER],
  shares: { [SIGNER]: 1n },
});

const makeState = (entityId: string, isHub = false): EntityState => ({
  entityId,
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
  profile: {
    name: isHub ? 'Hub' : 'User',
    isHub,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

const makeAccount = (leftEntity: string, rightEntity: string): AccountMachine => ({
  leftEntity,
  rightEntity,
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
    byLeft: true,
  },
  deltas: new Map([[1, createDefaultDelta(1)]]),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 1,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  rebalancePolicy: new Map(),
  locks: new Map(),
  swapOffers: new Map(),
  pulls: new Map(),
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map(),
  leftJObservations: [],
  rightJObservations: [],
  jEventChain: [],
  lastFinalizedJHeight: 0,
  onChainSettlementNonce: 0,
});

describe('hub lending pools', () => {
  test('offer, borrow, and repay update pool state and credit-limit ops', async () => {
    const env = createEmptyEnv('lending-unit');
    env.timestamp = 1_000;
    const state = makeState(HUB, true);
    state.accounts.set(LENDER, makeAccount(HUB, LENDER));
    state.accounts.set(BORROWER, makeAccount(HUB, BORROWER));

    const offered = await applyEntityTx(env, state, {
      type: 'lendingOffer',
      data: {
        lenderEntityId: LENDER,
        tokenId: 1,
        amount: 10_000n,
        termId: '1d',
        interestBps: 100,
      },
    });
    expect(offered.skippedError).toBeUndefined();
    const position = Array.from(offered.newState.lending?.pools.values() ?? [])[0]!;
    expect(position.availableAmount).toBe(10_000n);
    expect(position.borrowedAmount).toBe(0n);

    env.timestamp = 2_000;
    const borrowed = await applyEntityTx(env, offered.newState, {
      type: 'lendingBorrow',
      data: {
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_500n,
        termId: '1d',
        maxInterestBps: 150,
      },
    });
    expect(borrowed.skippedError).toBeUndefined();
    const loan = Array.from(borrowed.newState.lending?.loans.values() ?? [])[0]!;
    expect(loan.status).toBe('active');
    expect(loan.interestAmount).toBe(25n);
    expect(loan.repaymentAmount).toBe(2_525n);
    expect(borrowed.newState.lending?.pools.get(position.positionId)?.availableAmount).toBe(7_500n);
    expect(borrowed.newState.lending?.pools.get(position.positionId)?.borrowedAmount).toBe(2_500n);
    expect(borrowed.mempoolOps?.[0]).toEqual({
      accountId: BORROWER,
      tx: { type: 'set_credit_limit', data: { tokenId: 1, amount: 2_500n } },
    });

    borrowed.newState.accounts.get(BORROWER)!.deltas.get(1)!.rightCreditLimit = 2_500n;
    env.timestamp = 3_000;
    const repaid = await applyEntityTx(env, borrowed.newState, {
      type: 'lendingRepay',
      data: {
        borrowerEntityId: BORROWER,
        loanId: loan.loanId,
      },
    });
    expect(repaid.skippedError).toBeUndefined();
    expect(repaid.newState.lending?.loans.get(loan.loanId)?.status).toBe('repaid');
    expect(repaid.newState.lending?.pools.get(position.positionId)?.borrowedAmount).toBe(0n);
    expect(repaid.newState.lending?.pools.get(position.positionId)?.availableAmount).toBe(10_025n);
    expect(repaid.mempoolOps?.[0]).toEqual({
      accountId: BORROWER,
      tx: { type: 'set_credit_limit', data: { tokenId: 1, amount: 0n } },
    });
  });

  test('borrow returns terminal no-liquidity state without throwing', async () => {
    const env = createEmptyEnv('lending-no-liquidity');
    env.timestamp = 1_000;
    const state = makeState(HUB, true);
    state.accounts.set(BORROWER, makeAccount(HUB, BORROWER));

    const result = await applyEntityTx(env, state, {
      type: 'lendingBorrow',
      data: {
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 100n,
        termId: '1h',
      },
    });
    expect(result.skippedError).toBeUndefined();
    expect(result.newState.lending?.loans.size ?? 0).toBe(0);
    expect(result.newState.messages.at(-1)).toContain('Loan rejected');
    expect(result.mempoolOps).toBeUndefined();
  });
});
