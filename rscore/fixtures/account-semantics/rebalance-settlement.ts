import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import type { AccountReplica, AccountTx } from '../../../core/types/account';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const LEFT = entity('11');
const RIGHT = entity('22');
const ZERO_ROOT = `0x${'00'.repeat(32)}`;

type Inputs = Readonly<{
  request: Extract<AccountTx, { type: 'request_collateral' }>;
  partialRefund: Extract<AccountTx, { type: 'rebalance_refund' }>;
  finalRefund: Extract<AccountTx, { type: 'rebalance_refund' }>;
  settlementUpsert: Extract<AccountTx, { type: 'settle_transition' }>;
}>;

const makeAccount = (): AccountReplica => {
  const delta = createDefaultDelta(1);
  delta.collateral = 1_000n;
  delta.leftCreditLimit = 1_000n;
  delta.rightCreditLimit = 1_000n;
  return {
    state: {
      leftEntity: LEFT,
      rightEntity: RIGHT,
      domain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]),
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      locks: PersistentAccountStateMap.empty('locks'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentHeight: 4,
    rollbackCount: 0,
    currentFrame: {
      height: 4, timestamp: 0, jHeight: 0, accountTxs: [], prevFrameHash: '',
      stateHash: '', accountStateRoot: ZERO_ROOT,
    },
    proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };
};

const inputs = (): Inputs => ({
  request: {
    type: 'request_collateral',
    data: { tokenId: 1, amount: 100n, feeTokenId: 1, feeAmount: 10n, policyVersion: 3 },
  },
  partialRefund: {
    type: 'rebalance_refund',
    data: { requestId: 'rebalance:left:1:5', requestTokenId: 1, amount: 3n, reason: 'timeout' },
  },
  finalRefund: {
    type: 'rebalance_refund',
    data: { requestId: 'rebalance:left:1:5', requestTokenId: 1, amount: 7n, reason: 'timeout' },
  },
  settlementUpsert: {
    type: 'settle_transition',
    data: {
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 20n }],
      executorIsLeft: true,
      memo: 'shared-semantic-vector',
    },
  },
});

const applyStep = async (
  account: AccountReplica,
  input: keyof Inputs,
  tx: AccountTx,
  byLeft: boolean,
  timestamp: number,
) => {
  const result = await applyAccountTxToMutableReplica(account, tx, byLeft, timestamp, 4);
  if (!result.ok) throw new Error(`REBALANCE_SETTLEMENT_VECTOR_REJECTED:${input}:${result.rejection.message}`);
  const delta = account.state.deltas.get(1);
  if (!delta) throw new Error('REBALANCE_SETTLEMENT_VECTOR_DELTA_MISSING');
  return {
    input,
    txType: tx.type,
    byLeft,
    timestamp,
    accountStateRoot: computeAccountStateRootCold(account.state),
    deltasRoot: account.state.deltas.coldRootHash(),
    requestedRebalanceRoot: account.state.requestedRebalance.coldRootHash(),
    requestedRebalanceFeeStateRoot: account.state.requestedRebalanceFeeState.coldRootHash(),
    requestedAmount: (account.state.requestedRebalance.get(1) ?? 0n).toString(),
    requestedCount: account.state.requestedRebalance.size,
    feeStateCount: account.state.requestedRebalanceFeeState.size,
    offdelta: delta.offdelta.toString(),
    leftHold: delta.leftHold.toString(),
    rightHold: delta.rightHold.toString(),
    workspaceHash: account.state.settlementWorkspace?.workspaceHash,
    events: result.events,
    outputCount: result.candidateEffects?.length ?? 0,
  };
};

export const executeRebalanceSettlementAccountSemanticVector = async () => {
  const txs = inputs();
  const rebalance = makeAccount();
  const settlement = makeAccount();
  return {
    version: 1,
    canonicalSource: 'TypeScript applyAccountTxToMutableReplica',
    inputs: txs,
    cases: [
      { name: 'rebalance-request-refund', steps: [
        await applyStep(rebalance, 'request', txs.request, true, 1_000),
        await applyStep(rebalance, 'partialRefund', txs.partialRefund, false, 2_000),
        await applyStep(rebalance, 'finalRefund', txs.finalRefund, false, 3_000),
      ] },
      { name: 'settlement-upsert', steps: [
        await applyStep(settlement, 'settlementUpsert', txs.settlementUpsert, true, 4_000),
      ] },
    ],
  };
};
