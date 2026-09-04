import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import {
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../../../core/extensions/cross-j';
import type { AccountReplica, AccountTx } from '../../../core/types/account';
import type { CrossJurisdictionSwapRoute } from '../../../core/types/cross-jurisdiction';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const address = (byte: string): string => `0x${byte.repeat(20)}`;
const SOURCE_USER = entity('11');
const SOURCE_HUB = entity('22');
const TARGET_HUB = entity('33');
const TARGET_USER = entity('44');
const ZERO_ROOT = `0x${'00'.repeat(32)}`;

type CrossJStep = Readonly<{
  input: keyof CrossJInputs;
  txType: AccountTx['type'];
  byLeft: boolean;
  timestamp: number;
  height: number;
  accountStateRoot: string;
  deltasRoot: string;
  pullsRoot: string;
  swapOffersRoot: string;
  offdelta: string;
  leftHold: string;
  rightHold: string;
  pullCount: number;
  offerCount: number;
  events: readonly string[];
  outputCount: number;
  offer?: unknown;
}>;

type CrossJInputs = Readonly<{
  sourceLock: Extract<AccountTx, { type: 'cross_pull_lock' }>;
  targetLock: Extract<AccountTx, { type: 'cross_pull_lock' }>;
  swapOffer: Extract<AccountTx, { type: 'swap_offer' }>;
  sourceClose: Extract<AccountTx, { type: 'cross_pull_close' }>;
}>;

const route = (): CrossJurisdictionSwapRoute => {
  const prepared = buildPreparedCrossJurisdictionRoute({
    orderId: 'order-1',
    makerEntityId: SOURCE_USER,
    hubEntityId: SOURCE_HUB,
    sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    source: {
      jurisdiction: `stack:31337:${address('88')}`,
      entityId: SOURCE_USER,
      counterpartyEntityId: SOURCE_HUB,
      tokenId: 1,
      amount: 100n,
    },
    target: {
      jurisdiction: `stack:31338:${address('77')}`,
      entityId: TARGET_HUB,
      counterpartyEntityId: TARGET_USER,
      tokenId: 2,
      amount: 200n,
    },
    status: 'resting',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 61_000,
  }, { runtimeSeed: 'cross-j-account-semantic-v1', now: 1_000 });
  return { ...prepared, status: 'resting' };
};

const inputs = (prepared: CrossJurisdictionSwapRoute): CrossJInputs => {
  const sourcePull = prepared.sourcePull;
  const targetPull = prepared.targetPull;
  if (!sourcePull || !targetPull) throw new Error('CROSS_J_VECTOR_PULLS_MISSING');
  const sourceLock: CrossJInputs['sourceLock'] = {
    type: 'cross_pull_lock',
    data: {
      ...sourcePull,
      amount: sourcePull.signedAmount,
      crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'source'),
      crossJurisdictionRoute: prepared,
    },
  };
  const targetLock: CrossJInputs['targetLock'] = {
    type: 'cross_pull_lock',
    data: {
      ...targetPull,
      amount: targetPull.signedAmount,
      crossJurisdiction: buildCrossJurisdictionPullBinding(prepared, 'target'),
      crossJurisdictionRoute: prepared,
    },
  };
  return {
    sourceLock,
    targetLock,
    swapOffer: {
      type: 'swap_offer',
      data: {
        offerId: prepared.orderId,
        giveTokenId: 1,
        giveTokenDecimals: 6,
        giveAmount: 100n,
        wantTokenId: 2,
        wantTokenDecimals: 6,
        wantAmount: 200n,
        maxFee: 0n,
        minNetReceive: 200n,
        priceTicks: 20_000n,
        crossJurisdiction: prepared,
      },
    },
    sourceClose: {
      type: 'cross_pull_close',
      data: {
        pullId: sourcePull.pullId,
        binary: '0x',
        proof: buildCrossJurisdictionCloseProof(prepared, '0x'),
      },
    },
  };
};

const makeAccount = (
  leftEntity: string,
  rightEntity: string,
  tokenId: number,
  chainId: number,
  depositoryAddress: string,
): AccountReplica => {
  const delta = createDefaultDelta(tokenId);
  delta.collateral = 100n;
  delta.leftCreditLimit = 1_000n;
  delta.rightCreditLimit = 1_000n;
  return {
    state: {
      leftEntity,
      rightEntity,
      domain: { chainId, depositoryAddress },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[tokenId, delta]]),
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
    status: 'active', mempool: [], currentHeight: 0, rollbackCount: 0,
    currentFrame: {
      height: 0, timestamp: 0, jHeight: 0, accountTxs: [], prevFrameHash: '',
      stateHash: '', accountStateRoot: ZERO_ROOT,
    },
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };
};

const applyStep = async (
  account: AccountReplica,
  input: keyof CrossJInputs,
  tx: AccountTx,
  byLeft: boolean,
  tokenId: number,
  timestamp: number,
  height: number,
): Promise<CrossJStep> => {
  const result = await applyAccountTxToMutableReplica(account, tx, byLeft, timestamp, height);
  if (!result.ok) throw new Error(`CROSS_J_VECTOR_REJECTED:${input}:${result.rejection.message}`);
  const delta = account.state.deltas.get(tokenId);
  if (!delta) throw new Error(`CROSS_J_VECTOR_DELTA_MISSING:${tokenId}`);
  return {
    input, txType: tx.type, byLeft, timestamp, height,
    accountStateRoot: computeAccountStateRootCold(account.state),
    deltasRoot: account.state.deltas.coldRootHash(),
    pullsRoot: account.state.pulls?.coldRootHash() ?? ZERO_ROOT,
    swapOffersRoot: account.state.swapOffers.coldRootHash(),
    offdelta: delta.offdelta.toString(),
    leftHold: delta.leftHold.toString(),
    rightHold: delta.rightHold.toString(),
    pullCount: account.state.pulls?.size ?? 0,
    offerCount: account.state.swapOffers.size,
    events: result.events,
    // Cross-j orderbook lifecycle is projected by the Entity transition. Only
    // explicit Account candidate effects belong in the cross-language outbox.
    outputCount: result.candidateEffects?.length ?? 0,
    ...(account.state.swapOffers.get('order-1')
      ? { offer: account.state.swapOffers.get('order-1') }
      : {}),
  };
};

export const executeCrossJAccountSemanticVector = async () => {
  const prepared = route();
  const txs = inputs(prepared);
  const sourceOffer = makeAccount(SOURCE_USER, SOURCE_HUB, 1, 31_337, address('88'));
  const sourceClose = makeAccount(SOURCE_USER, SOURCE_HUB, 1, 31_337, address('88'));
  const targetLock = makeAccount(TARGET_HUB, TARGET_USER, 2, 31_338, address('77'));
  return {
    version: 1,
    canonicalSource: 'TypeScript applyAccountTxToMutableReplica',
    inputs: txs,
    cases: [
      { name: 'source-offer', steps: [
        await applyStep(sourceOffer, 'sourceLock', txs.sourceLock, false, 1, 1_000, 10),
        await applyStep(sourceOffer, 'swapOffer', txs.swapOffer, true, 1, 1_000, 10),
        await applyStep(sourceOffer, 'sourceClose', txs.sourceClose, false, 1, 2_000, 20),
      ] },
      { name: 'source-zero-close', steps: [
        await applyStep(sourceClose, 'sourceLock', txs.sourceLock, false, 1, 1_000, 10),
        await applyStep(sourceClose, 'sourceClose', txs.sourceClose, false, 1, 2_000, 20),
      ] },
      { name: 'target-lock', steps: [
        await applyStep(targetLock, 'targetLock', txs.targetLock, true, 2, 1_000, 10),
      ] },
    ],
  };
};
