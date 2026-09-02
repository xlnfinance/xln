import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import type { AccountReplica, AccountTx } from '../../../core/types/account';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const HUB = entity('10');
const LENDER = entity('20');
const BORROWER = entity('30');
const FRAME_HASH = `0x${'55'.repeat(32)}`;
const ZERO_ROOT = `0x${'00'.repeat(32)}`;
const POSITION_ID = 'lend-1111111111111111';
const BORROW_REQUEST_ID = 'borrow-2222222222222222';
const LOAN_ID = 'loan-0327fd9035d42518';

type LendingStep = Readonly<{
  txType: AccountTx['type'];
  byLeft: boolean;
  accountStateRoot: string;
  deltasRoot: string;
  lendingIntentsRoot: string;
  intentEntries: readonly [string, string][];
  offdelta: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  events: readonly string[];
  outputCount: number;
}>;

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
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
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
      accountStateRoot: ZERO_ROOT,
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

const applyStep = async (
  account: AccountReplica,
  tx: AccountTx,
  byLeft: boolean,
): Promise<LendingStep> => {
  const result = await applyAccountTxToMutableReplica(account, tx, byLeft, 1_000);
  if (!result.ok) throw new Error(`LENDING_VECTOR_REJECTED:${tx.type}:${result.rejection.message}`);
  const delta = account.state.deltas.get(1);
  if (!delta) throw new Error('LENDING_VECTOR_DELTA_MISSING');
  const intents = account.state.lendingIntents;
  return {
    txType: tx.type,
    byLeft,
    accountStateRoot: computeAccountStateRootCold(account.state),
    deltasRoot: account.state.deltas.coldRootHash(),
    lendingIntentsRoot: intents?.coldRootHash() ?? ZERO_ROOT,
    intentEntries: [...(intents?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    offdelta: delta.offdelta.toString(),
    leftCreditLimit: delta.leftCreditLimit.toString(),
    rightCreditLimit: delta.rightCreditLimit.toString(),
    events: result.events,
    outputCount: result.candidateEffects?.length ?? 0,
  };
};

const borrowerLifecycle = async (): Promise<readonly LendingStep[]> => {
  const account = makeAccount(BORROWER);
  return [
    await applyStep(account, {
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
    }, false),
    await applyStep(account, {
      type: 'lending_credit',
      data: {
        action: 'grant',
        loanId: LOAN_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        creditLimit: 22_500n,
      },
    }, true),
    await applyStep(account, {
      type: 'lending_repay',
      data: {
        loanId: LOAN_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_525n,
      },
    }, false),
  ];
};

const lenderLifecycle = async (): Promise<readonly LendingStep[]> => {
  const account = makeAccount(LENDER);
  return [
    await applyStep(account, {
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
    }, false),
    await applyStep(account, {
      type: 'lending_close_request',
      data: { positionId: POSITION_ID, hubEntityId: HUB, lenderEntityId: LENDER },
    }, false),
    await applyStep(account, {
      type: 'lending_close_payout',
      data: {
        positionId: POSITION_ID,
        hubEntityId: HUB,
        lenderEntityId: LENDER,
        tokenId: 1,
        amount: 10_025n,
      },
    }, true),
  ];
};

export const executeLendingAccountSemanticVector = async () => ({
  version: 1,
  canonicalSource: 'TypeScript applyAccountTxToMutableReplica',
  cases: [
    { name: 'borrower-lifecycle', steps: await borrowerLifecycle() },
    { name: 'lender-lifecycle', steps: await lenderLifecycle() },
  ],
});
