import { createHash } from 'node:crypto';

import { computeAccountStateRoot, encodeAccountStateValue } from '../../../core/account/commitment/state-root';
import { canonicalAccountTxForFrameHash } from '../../../core/account/consensus/frame/hash';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import { readEntityFrameEvents } from '../../../core/entity/frame-events';
import { createBookIntentProgram, applyBookIntentProgram } from '../../../core/entity/books/book-intents';
import { createAccountConsensusContext } from '../../../core/entity/account/account-consensus-context';
import { initCrontab } from '../../../core/entity/scheduler';
import { PersistentEntityAccountMap } from '../../../core/entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../core/entity/consensus/state-root';
import {
  handleRequestCollateralEntityTx,
  handleSetRebalancePolicyEntityTx,
} from '../../../core/entity/tx/handlers/account/lifecycle/admin';
import {
  handleLendingBorrowEntityTx,
  handleLendingClosePositionEntityTx,
  handleLendingOfferEntityTx,
  handleLendingRepayEntityTx,
} from '../../../core/entity/tx/handlers/payments/lending';
import {
  handleCancelSwapRequest,
  handlePlaceSwapOfferRequest,
} from '../../../core/entity/tx/handlers/payments/swap-requests';
import { handleHtlcPayment } from '../../../core/entity/tx/handlers/htlc/payment';
import { handleResolveHtlcLockEntityTx } from '../../../core/entity/tx/handlers/htlc/direct';
import { handleOpenAccountEntityTx } from '../../../core/entity/tx/handlers/account/lifecycle/open-account';
import { hashRawHtlcPaymentTx } from '../../../core/entity/paybook/payment-admission';
import { hashHtlcSecret } from '../../../core/protocol/htlc/utils';
import { createEmptyEnv } from '../../../core/runtime';
import type { EntityState } from '../../../core/entity/types';
import type { AccountReplica, AccountTx } from '../../../core/types/account';
import type { EntityTx } from '../../../core/types/entity-tx';

const OWNER = `0x${'11'.repeat(32)}`;
const PEER = `0x${'22'.repeat(32)}`;
const ZERO_ROOT = `0x${'00'.repeat(32)}`;
const SECRET = `0x${'55'.repeat(32)}`;
const HASHLOCK = hashHtlcSecret(SECRET);

const account = (lock?: AccountReplica['state']['locks'] extends { get(key: string): infer V } ? V : never): AccountReplica => {
  const deltas = [1, 2].map((tokenId) => {
    const delta = createDefaultDelta(tokenId);
    delta.collateral = 10_000n;
    delta.leftCreditLimit = 10_000n;
    delta.rightCreditLimit = 10_000n;
    return [tokenId, delta] as const;
  });
  return {
    state: {
      leftEntity: OWNER,
      rightEntity: PEER,
      domain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', deltas),
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      locks: lock
        ? PersistentAccountStateMap.fromEntries('locks', [[lock.lockId, lock]])
        : PersistentAccountStateMap.empty('locks'),
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
    proofHeader: { fromEntity: OWNER, toEntity: PEER, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };
};

const state = (lock?: Parameters<typeof account>[0]): EntityState => ({
  entityId: OWNER,
  entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based', threshold: 1n, validators: [OWNER], shares: { [OWNER]: 1n },
    jurisdiction: {
      jurisdictionId: 'fixture',
      chainId: 31_337,
      depositoryAddress: `0x${'88'.repeat(20)}`,
    },
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.fromMap(new Map([[PEER, account(lock)]]), OWNER, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'same-j-semantic', isHub: false, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  crontabState: initCrontab(),
});

const stateWithoutAccount = (): EntityState => {
  const value = state();
  value.accounts = PersistentEntityAccountMap.fromMap(new Map(), OWNER, computeEntityAccountValueHash);
  return value;
};

const runtimeContext = () => {
  const runtime = createEmptyEnv(null);
  runtime.state.timestamp = 1_000;
  runtime.quietRuntimeLogs = true;
  return runtime;
};

const digestTx = (tx: AccountTx): string =>
  `0x${createHash('sha256').update(encodeAccountStateValue(canonicalAccountTxForFrameHash(tx))).digest('hex')}`;

type ResultShape = Readonly<{
  newState: EntityState;
  outputs: readonly { entityId: string }[];
  accountTxs?: readonly { accountId: string; tx: AccountTx }[];
}>;

type ProjectionExtras = Readonly<{
  preparedTxHash?: string;
  runtimeEffects?: readonly unknown[];
  paybookEntry?: unknown;
  accountCreateStateRoot?: string;
}>;

const project = (name: string, input: EntityTx, result: ResultShape, extras: ProjectionExtras = {}) => {
  const policy = result.newState.accounts.get(PEER)?.shadow.rebalance.policy.get(1);
  return {
    name,
    input,
    accountIds: result.accountTxs?.map(row => row.accountId) ?? [],
    accountTxTypes: result.accountTxs?.map(row => row.tx.type) ?? [],
    accountTxDigests: result.accountTxs?.map(row => digestTx(row.tx)) ?? [],
    wakeTargets: result.outputs.map(output => output.entityId),
    events: readEntityFrameEvents(result.newState),
    ...(policy ? { policy } : {}),
    ...extras,
  };
};

const executeHtlcPayment = async () => {
  const input: Extract<EntityTx, { type: 'htlcPayment' }> = {
    type: 'htlcPayment',
    data: {
      targetEntityId: PEER, tokenId: 1, amount: 100n, maxSenderDebit: 120n,
      route: [OWNER, PEER], description: 'note', deliveryMode: 'instant', startedAtMs: 1_000,
      hashlock: HASHLOCK,
    },
  };
  const txHash = hashRawHtlcPaymentTx(input);
  const prepared = {
    txHash, targetEntityId: PEER, tokenId: 1, recipientAmount: 100n,
    route: [OWNER, PEER], description: 'note', deliveryMode: 'instant' as const,
    startedAtMs: 1_000, hashlock: HASHLOCK, senderLockAmount: 110n,
    maxSenderDebit: 120n, totalFee: 10n, timelock: 2_000n,
    revealBeforeHeight: 50, nextHopEntityId: PEER,
    envelope: {
      version: 'xln:htlc-opaque:aes-gcm' as const,
      ciphertext: 'RERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERE',
    },
  };
  const value = state();
  const effects: EntityCandidateEffect[] = [];
  const program = createBookIntentProgram();
  const result = await handleHtlcPayment(
    value, input, runtimeContext(), effects, true,
    { htlc: { version: 1, entries: [], originated: [prepared] } }, program.openSlot(),
  );
  applyBookIntentProgram(result.newState, program);
  return project('htlcPayment', input, result, {
    preparedTxHash: txHash,
    runtimeEffects: effects,
    paybookEntry: result.newState.paybook.entries.get(HASHLOCK),
  });
};

const executeResolveHtlc = () => {
  const value = state({
    lockId: HASHLOCK, hashlock: HASHLOCK, timelock: 100n, revealBeforeHeight: 10,
    amount: 7n, tokenId: 1, senderIsLeft: false, createdHeight: 1, createdTimestamp: 2,
  });
  const input: Extract<EntityTx, { type: 'resolveHtlcLock' }> = {
    type: 'resolveHtlcLock',
    data: { counterpartyEntityId: PEER, lockId: HASHLOCK, secret: SECRET },
  };
  const program = createBookIntentProgram();
  const result = handleResolveHtlcLockEntityTx(value, input, true, program.openSlot());
  applyBookIntentProgram(result.newState, program);
  return project('resolveHtlcLock', input, result, {
    paybookEntry: result.newState.paybook.entries.get(HASHLOCK),
  });
};

const executeOpenAccount = async () => {
  const input: Extract<EntityTx, { type: 'openAccount' }> = {
    type: 'openAccount',
    data: {
      targetEntityId: PEER,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
      accountDomain: { chainId: 31_337, depositoryAddress: `0x${'88'.repeat(20)}` },
      watchSeed: `0x${'44'.repeat(32)}`,
      creditAmount: 7n, tokenId: 1, pinPublic: true,
    },
  };
  const value = stateWithoutAccount();
  const result = await handleOpenAccountEntityTx(
    value, input, createAccountConsensusContext(runtimeContext()), [], false,
  );
  const created = result.newState.accounts.get(PEER);
  if (!created) throw new Error('SAME_J_FIXTURE_ACCOUNT_NOT_CREATED');
  return project('openAccount', input, {
    newState: result.newState,
    outputs: result.outputs,
    accountTxs: created.mempool.map(tx => ({ accountId: PEER, tx })),
  }, { accountCreateStateRoot: computeAccountStateRoot(created.state, undefined, 'sameJSemanticOpen') });
};

export const executeSameJFinancialEntitySemanticVector = async () => {
  const offer: Extract<EntityTx, { type: 'lendingOffer' }> = {
    type: 'lendingOffer',
    data: {
      positionId: 'lend-1111111111111111', hubEntityId: PEER, tokenId: 1,
      amount: 10_000n, termId: '1d', interestBps: 100,
    },
  };
  const borrow: Extract<EntityTx, { type: 'lendingBorrow' }> = {
    type: 'lendingBorrow',
    data: {
      requestId: 'borrow-2222222222222222', hubEntityId: PEER, tokenId: 1,
      amount: 2_500n, termId: '1d', maxInterestBps: 150,
    },
  };
  const repay: Extract<EntityTx, { type: 'lendingRepay' }> = {
    type: 'lendingRepay',
    data: { hubEntityId: PEER, loanId: 'loan-0327fd9035d42518', tokenId: 1, amount: 2_525n },
  };
  const close: Extract<EntityTx, { type: 'lendingClosePosition' }> = {
    type: 'lendingClosePosition',
    data: { hubEntityId: PEER, positionId: 'lend-1111111111111111' },
  };
  const place: Extract<EntityTx, { type: 'placeSwapOffer' }> = {
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: PEER, offerId: 'offer-1',
      giveTokenId: 2, giveTokenDecimals: 18, giveAmount: 1_000_000_000_000_000_000n,
      wantTokenId: 1, wantTokenDecimals: 6, wantAmount: 2_500_000n,
      maxFee: 25_000n, minNetReceive: 2_475_000n, priceTicks: 25_000n, timeInForce: 0,
    },
  };
  const cancel: Extract<EntityTx, { type: 'proposeCancelSwap' }> = {
    type: 'proposeCancelSwap', data: { counterpartyEntityId: PEER, offerId: 'offer-1' },
  };
  const request: Extract<EntityTx, { type: 'requestCollateral' }> = {
    type: 'requestCollateral',
    data: {
      counterpartyEntityId: PEER, tokenId: 1, amount: 100n,
      feeTokenId: 2, feeAmount: 3n, policyVersion: 7,
    },
  };
  const setPolicy: Extract<EntityTx, { type: 'setRebalancePolicy' }> = {
    type: 'setRebalancePolicy',
    data: {
      counterpartyEntityId: PEER, tokenId: 1,
      r2cRequestSoftLimit: 50n, hardLimit: 100n, maxAcceptableFee: 5n,
    },
  };
  const env = runtimeContext();
  return {
    version: 1,
    canonicalSource: 'TypeScript Entity production handlers',
    cases: [
      project('lendingOffer', offer, handleLendingOfferEntityTx(state(), offer)),
      project('lendingBorrow', borrow, handleLendingBorrowEntityTx(state(), borrow)),
      project('lendingRepay', repay, handleLendingRepayEntityTx(state(), repay)),
      project('lendingClosePosition', close, handleLendingClosePositionEntityTx(state(), close)),
      project('placeSwapOffer', place, handlePlaceSwapOfferRequest(state(), place)),
      project('proposeCancelSwap', cancel, handleCancelSwapRequest(state(), cancel)),
      project('requestCollateral', request, handleRequestCollateralEntityTx(state(), request)),
      project('setRebalancePolicy', setPolicy, handleSetRebalancePolicyEntityTx(env, state(), setPolicy)),
      await executeHtlcPayment(),
      executeResolveHtlc(),
      await executeOpenAccount(),
    ],
  };
};
