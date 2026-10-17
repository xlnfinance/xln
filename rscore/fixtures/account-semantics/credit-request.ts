import { applyAccountTxToMutableReplica } from '../../../core/account/tx/apply';
import { computeAccountStateRootCold } from '../../../core/account/commitment/state-root';
import { computeFrameHash } from '../../../core/account/consensus/frame/hash';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import type { AccountReplica, AccountTx } from '../../../core/types/account';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const HUB = entity('10');
const USER = entity('30');
const FRAME_HASH = `0x${'55'.repeat(32)}`;
const ZERO_ROOT = `0x${'00'.repeat(32)}`;

type CreditRequestStep = Readonly<{
  txType: AccountTx['type'];
  byLeft: boolean;
  accountStateRoot: string;
  deltasRoot: string;
  lendingIntentsRoot: string;
  intentEntries: readonly [string, string][];
  leftCreditLimit: string;
  rightCreditLimit: string;
  frameHash: string;
  events: readonly string[];
}>;

const makeAccount = (): AccountReplica => ({
  state: {
    leftEntity: HUB,
    rightEntity: USER,
    domain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
    watchSeed: `0x${'99'.repeat(32)}`,
    deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, createDefaultDelta(1)]]),
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
    height: 1, timestamp: 1_000, jHeight: 0, accountTxs: [], prevFrameHash: FRAME_HASH,
    deltas: [], stateHash: FRAME_HASH, accountStateRoot: ZERO_ROOT, byLeft: true,
  },
  currentHeight: 1,
  rollbackCount: 0,
  proofHeader: { fromEntity: HUB, toEntity: USER, nextProofNonce: 1 },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
  shadow: {
    rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    },
  },
});

const applyStep = async (account: AccountReplica, tx: AccountTx, byLeft: boolean): Promise<CreditRequestStep> => {
  const result = await applyAccountTxToMutableReplica(account, tx, byLeft, 1_000);
  if (!result.ok) throw new Error(`CREDIT_REQUEST_VECTOR_REJECTED:${tx.type}:${result.rejection.message}`);
  const delta = account.state.deltas.get(1);
  if (!delta) throw new Error('CREDIT_REQUEST_VECTOR_DELTA_MISSING');
  const intents = account.state.lendingIntents;
  const accountStateRoot = computeAccountStateRootCold(account.state);
  return {
    txType: tx.type,
    byLeft,
    accountStateRoot,
    deltasRoot: account.state.deltas.coldRootHash(),
    lendingIntentsRoot: intents?.coldRootHash() ?? ZERO_ROOT,
    intentEntries: [...(intents?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    leftCreditLimit: delta.leftCreditLimit.toString(),
    rightCreditLimit: delta.rightCreditLimit.toString(),
    frameHash: computeFrameHash({
      height: 2, timestamp: 1_000, jHeight: 0, accountTxs: [tx],
      prevFrameHash: FRAME_HASH, stateHash: '', accountStateRoot,
    }),
    events: result.events,
  };
};

const request = (requestId: string, amount: bigint): AccountTx => ({
  type: 'credit_request',
  data: { requestId, requesterEntityId: USER, tokenId: 1, amount },
});

const grant = (amount: bigint): AccountTx => ({ type: 'set_credit_limit', data: { tokenId: 1, amount } });

/** The wallet asks twice; the hub answers min(requested, 1,000 USDC) each time. */
const walletAskHubAnswers = async (): Promise<readonly CreditRequestStep[]> => {
  const account = makeAccount();
  return [
    await applyStep(account, request('credit-1111111111111111', 25_000_000n), false),
    await applyStep(account, grant(25_000_000n), true),
    await applyStep(account, request('credit-2222222222222222', 5_000_000_000n), false),
    await applyStep(account, grant(1_000_000_000n), true),
  ];
};

export const executeCreditRequestAccountSemanticVector = async () => ({
  version: 1,
  canonicalSource: 'TypeScript applyAccountTxToMutableReplica',
  cases: [{ name: 'wallet-ask-hub-answers', steps: await walletAskHubAnswers() }],
});
