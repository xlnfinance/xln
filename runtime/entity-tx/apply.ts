import type { EntityState, EntityTx, Env, EntityInput, JInput, HashType } from '../types';
import { markStorageAccountDirty, markStorageEntityDirty } from '../env-events';
// import { addToReserves, subtractFromReserves } from './financial'; // Currently unused
import {
  handleAccountInput,
  type MempoolOp,
  type SwapOfferEvent,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
} from './handlers/account';
import { handleJEvent } from './j-events';
import { shouldRethrowEntityTxError } from './invariant-errors';
import { createStructuredLogger, logError } from '../logger';
import { handleR2E } from './handlers/r2e';
import { handleHtlcPayment } from './handlers/htlc-payment';
import { handleR2C } from './handlers/r2c';
import { handleE2R } from './handlers/e2r';
import { handleR2R } from './handlers/r2r';
import {
  handleCancelPullEntityTx,
  handleCrossPullCloseEntityTx,
  handlePullLockEntityTx,
  handleResolvePullEntityTx,
} from './handlers/pull';
import {
  handleCancelSwapRequest,
  handlePlaceSwapOfferRequest,
  handleResolveSwapRequest,
} from './handlers/swap-requests';
import { handleJBroadcast } from './handlers/j-broadcast';
import { handleJRebroadcast } from './handlers/j-rebroadcast';
import { handleJAbortSentBatch } from './handlers/j-abort-sent-batch';
import { handleJClearBatch } from './handlers/j-clear-batch';
import { handleMintReserves } from './handlers/mint-reserves';
import { handleCreateSettlement } from './handlers/create-settlement';
import {
  handleSettleApprove,
  handleSettleExecute,
  handleSettlePropose,
  handleSettleReject,
  handleSettleUpdate,
} from './handlers/settle';
import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from './handlers/dispute';
import {
  handleChatEntityTx,
  handleChatMessageEntityTx,
  handleInitOrderbookExtEntityTx,
  handleProfileUpdateEntityTx,
  handleProposeEntityTx,
  handleVoteEntityTx,
} from './handlers/basic';
import { handleOpenAccountEntityTx } from './handlers/open-account';
import {
  handleHashlockPaymentEntityTx,
  handleManualHtlcLockEntityTx,
  handleProcessHtlcTimeoutsEntityTx,
  handleResolveHtlcLockEntityTx,
  handleRollbackTimedOutFramesEntityTx,
} from './handlers/htlc-direct';
import { handleDirectPaymentEntityTx } from './handlers/direct-payment';
import {
  handleExtendCreditEntityTx,
  handleReopenDisputedAccountEntityTx,
  handleRequestCollateralEntityTx,
  handleSetHubConfigEntityTx,
  handleSetRebalancePolicyEntityTx,
} from './handlers/account-admin';
import {
  handleLendingBorrowEntityTx,
  handleLendingClosePositionEntityTx,
  handleLendingOfferEntityTx,
  handleLendingRepayEntityTx,
} from './handlers/lending';
import { handleSettleDiffsEntityTx } from './handlers/settle-diffs';
import {
  handleCommitCrossJurisdictionSwapEntityTx,
  handlePrepareCrossJurisdictionSwapEntityTx,
  handleRegisterCrossJurisdictionSwapEntityTx,
  handleRequestCrossJurisdictionSwapEntityTx,
} from './handlers/cross-j-setup';
import { handleCrossJurisdictionFillNoticeEntityTx } from './handlers/cross-j-fill';
import { handleRequestCrossJurisdictionClearEntityTx } from './handlers/cross-j-clear';
import { handleCrossJurisdictionSalvageEntityTx } from './handlers/cross-j-salvage';
import { handleOrderbookSweepCrossJurisdictionEntityTx } from './handlers/cross-j-sweep';
import {
  handleApplyCrossJurisdictionBookProgressEntityTx,
  handleAdmitCrossJurisdictionBookOrderEntityTx,
  handleRemoveCrossJurisdictionBookOrderEntityTx,
} from './handlers/cross-j-book-order';

const entityTxLog = createStructuredLogger('entity.tx');

// Extended return type including pure events from handlers
export interface ApplyEntityTxResult {
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs?: JInput[];
  // Pure events for entity-level orchestration
  mempoolOps?: MempoolOp[];
  dirtyAccounts?: string[];
  swapOffersCreated?: SwapOfferEvent[];
  swapCancelRequests?: SwapCancelRequestEvent[];
  swapOffersCancelled?: SwapCancelEvent[];
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: HashType; context: string }>;
  skippedError?: string;
}

export interface ApplyEntityTxOptions {
  mutableFrameState?: boolean;
}

type EntityTxDispatcher = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx,
  options?: ApplyEntityTxOptions,
) => Promise<ApplyEntityTxResult> | ApplyEntityTxResult;

const handleJEventEntityTx: EntityTxDispatcher = async (env, entityState, entityTx) => {
  if (entityTx.type !== 'j_event') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const jEventData = entityTx.data as {
    event?: { type?: string };
    events?: Array<{ type?: string }>;
    blockNumber?: number;
    transactionHash?: string;
  };
  const firstEventType =
    jEventData.event?.type ??
    (Array.isArray(jEventData.events) && jEventData.events.length > 0 ? jEventData.events[0]?.type : undefined) ??
    'unknown';
  env.emit('JEventReceived', {
    entityId: entityState.entityId,
    eventType: firstEventType,
    blockNumber: jEventData.blockNumber,
    txHash: jEventData.transactionHash,
  });
  const { newState, mempoolOps, outputs, dirtyAccounts } = await handleJEvent(entityState, entityTx.data, env);
  return { newState, outputs: outputs || [], mempoolOps: mempoolOps || [], dirtyAccounts };
};

const handleAccountInputEntityTx: EntityTxDispatcher = async (env, entityState, entityTx) => {
  if (entityTx.type !== 'accountInput') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const result = await handleAccountInput(entityState, entityTx.data, env);
  markStorageAccountDirty(env, result.newState.entityId, entityTx.data.fromEntityId);
  return {
    newState: result.newState,
    outputs: result.outputs,
    mempoolOps: result.mempoolOps,
    swapOffersCreated: result.swapOffersCreated,
    swapCancelRequests: result.swapCancelRequests,
    swapOffersCancelled: result.swapOffersCancelled,
    ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
  };
};

const handleSettleApproveEntityTx: EntityTxDispatcher = async (env, entityState, entityTx) => {
  if (entityTx.type !== 'settle_approve') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const result = await handleSettleApprove(entityState, entityTx, env);
  return {
    ...result,
    ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
  };
};

const handleJBroadcastEntityTx: EntityTxDispatcher = async (env, entityState, entityTx) => {
  if (entityTx.type !== 'j_broadcast') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const batch = entityState.jBatchState?.batch;
  entityTxLog.debug('j_broadcast.apply', batch
    ? {
        entity: entityState.entityId.slice(-4),
        r2r: batch.reserveToReserve.length,
        r2c: batch.reserveToCollateral.length,
        c2r: batch.collateralToReserve.length,
        settlements: batch.settlements.length,
        starts: batch.disputeStarts.length,
        finals: batch.disputeFinalizations.length,
      }
    : { entity: entityState.entityId.slice(-4), batch: 'missing' });
  return handleJBroadcast(entityState, entityTx, env);
};

// This table is intentionally boring: adding a new EntityTx should mean adding
// one row here and keeping domain behavior inside runtime/entity-tx/handlers.
const entityTxDispatchers: Record<string, EntityTxDispatcher> = {
  chat: (_env, state, tx) => handleChatEntityTx(state, tx as Extract<EntityTx, { type: 'chat' }>),
  chatMessage: (_env, state, tx) => handleChatMessageEntityTx(state, tx as Extract<EntityTx, { type: 'chatMessage' }>),
  propose: (_env, state, tx) => handleProposeEntityTx(state, tx as Extract<EntityTx, { type: 'propose' }>),
  vote: (_env, state, tx) => handleVoteEntityTx(state, tx as Extract<EntityTx, { type: 'vote' }>),
  'profile-update': (env, state, tx) => handleProfileUpdateEntityTx(env, state, tx as Extract<EntityTx, { type: 'profile-update' }>),
  initOrderbookExt: (_env, state, tx) => handleInitOrderbookExtEntityTx(state, tx as Extract<EntityTx, { type: 'initOrderbookExt' }>),
  j_event: handleJEventEntityTx,
  accountInput: handleAccountInputEntityTx,
  openAccount: (env, state, tx) => handleOpenAccountEntityTx(env, state, tx as Extract<EntityTx, { type: 'openAccount' }>),
  htlcPayment: (env, state, tx) => handleHtlcPayment(state, tx as Extract<EntityTx, { type: 'htlcPayment' }>, env),
  hashlockPayment: (env, state, tx) => handleHashlockPaymentEntityTx(env, state, tx as Extract<EntityTx, { type: 'hashlockPayment' }>),
  resolveHtlcLock: (_env, state, tx) => handleResolveHtlcLockEntityTx(state, tx as Extract<EntityTx, { type: 'resolveHtlcLock' }>),
  processHtlcTimeouts: (_env, state, tx) => handleProcessHtlcTimeoutsEntityTx(state, tx as Extract<EntityTx, { type: 'processHtlcTimeouts' }>),
  rollbackTimedOutFrames: (_env, state, tx) => handleRollbackTimedOutFramesEntityTx(state, tx as Extract<EntityTx, { type: 'rollbackTimedOutFrames' }>),
  manualHtlcLock: (_env, state, tx) => handleManualHtlcLockEntityTx(state, tx as Extract<EntityTx, { type: 'manualHtlcLock' }>),
  directPayment: (env, state, tx) => handleDirectPaymentEntityTx(env, state, tx as Extract<EntityTx, { type: 'directPayment' }>),
  r2c: (env, state, tx) => handleR2C(state, tx as Extract<EntityTx, { type: 'r2c' }>, env.timestamp),
  e2r: (_env, state, tx) => handleE2R(state, tx as Extract<EntityTx, { type: 'e2r' }>),
  r2r: (_env, state, tx) => handleR2R(state, tx as Extract<EntityTx, { type: 'r2r' }>),
  j_broadcast: handleJBroadcastEntityTx,
  j_rebroadcast: (env, state, tx) => handleJRebroadcast(state, tx as Extract<EntityTx, { type: 'j_rebroadcast' }>, env),
  j_abort_sent_batch: (env, state, tx) => handleJAbortSentBatch(state, tx as Extract<EntityTx, { type: 'j_abort_sent_batch' }>, env),
  j_clear_batch: (env, state, tx) => handleJClearBatch(state, tx as Extract<EntityTx, { type: 'j_clear_batch' }>, env),
  mintReserves: (env, state, tx) => handleMintReserves(state, tx as Extract<EntityTx, { type: 'mintReserves' }>, env),
  createSettlement: (_env, state, tx) => handleCreateSettlement(state, tx as Extract<EntityTx, { type: 'createSettlement' }>),
  settle_propose: (env, state, tx) => handleSettlePropose(state, tx as Extract<EntityTx, { type: 'settle_propose' }>, env),
  settle_update: (env, state, tx) => handleSettleUpdate(state, tx as Extract<EntityTx, { type: 'settle_update' }>, env),
  settle_approve: handleSettleApproveEntityTx,
  settle_execute: (env, state, tx) => handleSettleExecute(state, tx as Extract<EntityTx, { type: 'settle_execute' }>, env),
  settle_reject: (env, state, tx) => handleSettleReject(state, tx as Extract<EntityTx, { type: 'settle_reject' }>, env),
  extendCredit: (_env, state, tx) => handleExtendCreditEntityTx(state, tx as Extract<EntityTx, { type: 'extendCredit' }>),
  lendingOffer: (env, state, tx) => handleLendingOfferEntityTx(env, state, tx as Extract<EntityTx, { type: 'lendingOffer' }>),
  lendingBorrow: (env, state, tx) => handleLendingBorrowEntityTx(env, state, tx as Extract<EntityTx, { type: 'lendingBorrow' }>),
  lendingRepay: (env, state, tx) => handleLendingRepayEntityTx(env, state, tx as Extract<EntityTx, { type: 'lendingRepay' }>),
  lendingClosePosition: (env, state, tx) => handleLendingClosePositionEntityTx(env, state, tx as Extract<EntityTx, { type: 'lendingClosePosition' }>),
  setHubConfig: (env, state, tx) => handleSetHubConfigEntityTx(env, state, tx as Extract<EntityTx, { type: 'setHubConfig' }>),
  setRebalancePolicy: (_env, state, tx) => handleSetRebalancePolicyEntityTx(state, tx as Extract<EntityTx, { type: 'setRebalancePolicy' }>),
  requestCollateral: (_env, state, tx) => handleRequestCollateralEntityTx(state, tx as Extract<EntityTx, { type: 'requestCollateral' }>),
  reopenDisputedAccount: (_env, state, tx) => handleReopenDisputedAccountEntityTx(state, tx as Extract<EntityTx, { type: 'reopenDisputedAccount' }>),
  pullLock: (env, state, tx, options) => handlePullLockEntityTx(env, state, tx as Extract<EntityTx, { type: 'pullLock' }>, options),
  resolvePull: (env, state, tx, options) => handleResolvePullEntityTx(env, state, tx as Extract<EntityTx, { type: 'resolvePull' }>, options),
  crossPullClose: (env, state, tx, options) => handleCrossPullCloseEntityTx(env, state, tx as Extract<EntityTx, { type: 'crossPullClose' }>, options),
  cancelPull: (env, state, tx, options) => handleCancelPullEntityTx(env, state, tx as Extract<EntityTx, { type: 'cancelPull' }>, options),
  pullCancelExpired: (env, state, tx, options) => handleCancelPullEntityTx(env, state, tx as Extract<EntityTx, { type: 'pullCancelExpired' }>, options),
  requestCrossJurisdictionSwap: (env, state, tx, options) => handleRequestCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'requestCrossJurisdictionSwap' }>, options),
  prepareCrossJurisdictionSwap: (env, state, tx, options) => handlePrepareCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'prepareCrossJurisdictionSwap' }>, options),
  commitCrossJurisdictionSwap: (env, state, tx, options) => handleCommitCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'commitCrossJurisdictionSwap' }>, options),
  registerCrossJurisdictionSwap: (env, state, tx, options) => handleRegisterCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'registerCrossJurisdictionSwap' }>, options),
  crossJurisdictionFillNotice: (_env, state, tx) => handleCrossJurisdictionFillNoticeEntityTx(state, tx as Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>),
  requestCrossJurisdictionClear: (env, state, tx) => handleRequestCrossJurisdictionClearEntityTx(env, state, tx as Extract<EntityTx, { type: 'requestCrossJurisdictionClear' }>),
  crossJurisdictionSalvage: (env, state, tx) => handleCrossJurisdictionSalvageEntityTx(env, state, tx as Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>),
  orderbookSweepCrossJurisdiction: (env, state, tx) => handleOrderbookSweepCrossJurisdictionEntityTx(env, state, tx as Extract<EntityTx, { type: 'orderbookSweepCrossJurisdiction' }>),
  admitCrossJurisdictionBookOrder: (env, state, tx, options) => handleAdmitCrossJurisdictionBookOrderEntityTx(env, state, tx as Extract<EntityTx, { type: 'admitCrossJurisdictionBookOrder' }>, options),
  applyCrossJurisdictionBookProgress: (env, state, tx, options) => handleApplyCrossJurisdictionBookProgressEntityTx(env, state, tx as Extract<EntityTx, { type: 'applyCrossJurisdictionBookProgress' }>, options),
  removeCrossJurisdictionBookOrder: (env, state, tx, options) => handleRemoveCrossJurisdictionBookOrderEntityTx(env, state, tx as Extract<EntityTx, { type: 'removeCrossJurisdictionBookOrder' }>, options),
  placeSwapOffer: (env, state, tx, options) => handlePlaceSwapOfferRequest(env, state, tx as Extract<EntityTx, { type: 'placeSwapOffer' }>, options),
  resolveSwap: (_env, state, tx, options) => handleResolveSwapRequest(state, tx as Extract<EntityTx, { type: 'resolveSwap' }>, options),
  cancelSwapOffer: (_env, state, tx, options) => handleCancelSwapRequest(state, tx as Extract<EntityTx, { type: 'cancelSwapOffer' }>, options),
  cancelSwap: (_env, state, tx, options) => handleCancelSwapRequest(state, tx as Extract<EntityTx, { type: 'cancelSwap' }>, options),
  proposeCancelSwap: (_env, state, tx, options) => handleCancelSwapRequest(state, tx as Extract<EntityTx, { type: 'proposeCancelSwap' }>, options),
  r2e: (_env, state, tx) => handleR2E(state, tx as Extract<EntityTx, { type: 'r2e' }>),
  settleDiffs: (_env, state, tx) => handleSettleDiffsEntityTx(state, tx as Extract<EntityTx, { type: 'settleDiffs' }>),
  prepareDispute: (env, state, tx) => handlePrepareDispute(state, tx as Extract<EntityTx, { type: 'prepareDispute' }>, env),
  disputeStart: (env, state, tx) => handleDisputeStart(state, tx as Extract<EntityTx, { type: 'disputeStart' }>, env),
  disputeFinalize: (env, state, tx) => handleDisputeFinalize(state, tx as Extract<EntityTx, { type: 'disputeFinalize' }>, env),
};

export const applyEntityTx = async (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx,
  options?: ApplyEntityTxOptions,
): Promise<ApplyEntityTxResult> => {
  if (!entityTx) {
    logError('ENTITY_TX', `❌ EntityTx is undefined!`);
    return { newState: entityState, outputs: [] };
  }

  try {
    markStorageEntityDirty(env, entityState.entityId);

    const dispatcher = entityTxDispatchers[String(entityTx.type)];
    if (dispatcher) {
      return await dispatcher(env, entityState, entityTx, options);
    }

    const skippedError = `ENTITY_TX_UNHANDLED: type=${String(entityTx.type)}`;
    entityTxLog.warn('unhandled', { type: String(entityTx.type) });
    return { newState: entityState, outputs: [], jOutputs: [], skippedError };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (shouldRethrowEntityTxError(error)) {
      entityTxLog.error('failed_invariant', { type: String(entityTx.type), error: message });
      throw error;
    }
    entityTxLog.debug('skipped_error', { type: String(entityTx.type), error: message });
    return { newState: entityState, outputs: [], jOutputs: [], skippedError: message };
  }
};
