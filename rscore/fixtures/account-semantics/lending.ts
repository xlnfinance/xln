import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import type { AccountReplica, AccountTx } from '../../../core/types/account';
import { assertLendingCovenant, lendingCovenantHash } from '../../../core/protocol/dispute/lending-covenant';
import { accountTxWire, type RscoreWireValue } from '../../../core/rscore/shadow-wire';

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
  txWire: readonly RscoreWireValue[];
  timestamp: number;
  byLeft: boolean;
  accountStateRoot: string;
  deltasRoot: string;
  lendingIntentsRoot: string;
  subcontractsRoot: string;
  claimEntries: readonly [string, unknown][];
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
  // Each party owns 10,000: savings must spend assets, not unused bank credit.
  delta.ondelta = 10_000n;
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
  timestamp = 1_000,
): Promise<LendingStep> => {
  const result = await applyAccountTxToMutableReplica(account, tx, byLeft, timestamp);
  if (!result.ok) throw new Error(`LENDING_VECTOR_REJECTED:${tx.type}:${result.rejection.message}`);
  const delta = account.state.deltas.get(1);
  if (!delta) throw new Error('LENDING_VECTOR_DELTA_MISSING');
  const intents = account.state.lendingIntents;
  return {
    txType: tx.type,
    txWire: accountTxWire(tx),
    timestamp,
    byLeft,
    accountStateRoot: computeAccountStateRootCold(account.state),
    deltasRoot: account.state.deltas.coldRootHash(),
    lendingIntentsRoot: intents?.coldRootHash() ?? ZERO_ROOT,
    subcontractsRoot: account.state.subcontracts?.coldRootHash() ?? ZERO_ROOT,
    claimEntries: [...account.state.subcontracts?.entries() ?? []],
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
  const steps = [
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
        maxLateMs: 86_400_000,
        expiresAt: 5_000,
      },
    }, false),
    await applyStep(account, {
      type: 'lending_disburse',
      data: {
        loanId: LOAN_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 2_500n,
        termId: '1d', interestBps: 100, requestId: BORROW_REQUEST_ID,
        maxInterestBps: 150, expiresAt: 5_000, maxLateMs: 86_400_000, lateMs: 86_400_000,
      },
    }, true),
  ];
  const claim = account.state.subcontracts?.get(LOAN_ID);
  assertLendingCovenant(claim);
  const partial: Extract<AccountTx, { type: 'lending_repay' }> = {
      type: 'lending_repay',
      data: {
        loanId: LOAN_ID,
        hubEntityId: HUB,
        borrowerEntityId: BORROWER,
        tokenId: 1,
        amount: 1_012n,
        claimHash: lendingCovenantHash(claim),
      },
  };
  steps.push(await applyStep(account, partial, false, 43_201_000));
  const beforeRetry = computeAccountStateRootCold(account.state);
  const retry = await applyAccountTxToMutableReplica(account, partial, false, 43_201_000);
  if (retry.ok || retry.rejection.message !== 'LENDING_REPAY_COVENANT_CHANGED' ||
      computeAccountStateRootCold(account.state) !== beforeRetry) throw new Error('LENDING_STALE_PARTIAL_NOT_ATOMIC');
  const remainder = account.state.subcontracts?.get(LOAN_ID);
  assertLendingCovenant(remainder);
  if (remainder.principal !== 1_500n || remainder.accruedInterest !== 0n || remainder.interestRemainder !== 432_000_000_000n) {
    throw new Error('LENDING_PARTIAL_CLOCK_INCORRECT');
  }
  steps.push(await applyStep(account, { ...partial, data: {
    ...partial.data, amount: 5_000n, claimHash: lendingCovenantHash(remainder),
  } }, false, 86_401_000));
  if (account.state.deltas.get(1)?.offdelta !== 20n || account.state.subcontracts?.size !== 0) {
    throw new Error('LENDING_FINAL_PAYMENT_NOT_CAPPED_AT_EARNED_DEBT');
  }
  return steps;
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
        amount: 10_100n,
      },
    }, true, 86_401_000),
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
