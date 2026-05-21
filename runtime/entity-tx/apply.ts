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
import { handleDisputeFinalize, handleDisputeStart } from './handlers/dispute';
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
import { handleRemoveCrossJurisdictionBookOrderEntityTx } from './handlers/cross-j-book-order';

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

export const applyEntityTx = async (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTx,
): Promise<ApplyEntityTxResult> => {
  if (!entityTx) {
    logError('ENTITY_TX', `❌ EntityTx is undefined!`);
    return { newState: entityState, outputs: [] };
  }

  try {
    markStorageEntityDirty(env, entityState.entityId);

    if (entityTx.type === 'chat') {
      return handleChatEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'chatMessage') {
      return handleChatMessageEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'propose') {
      return handleProposeEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'vote') {
      return handleVoteEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'profile-update') {
      return handleProfileUpdateEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'initOrderbookExt') {
      return handleInitOrderbookExtEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'j_event') {
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
    }

    if (entityTx.type === 'accountInput') {
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
    }

    if (entityTx.type === 'openAccount') {
      return handleOpenAccountEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'htlcPayment') {
      return await handleHtlcPayment(entityState, entityTx, env);
    }

    if (entityTx.type === 'hashlockPayment') {
      return handleHashlockPaymentEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'resolveHtlcLock') {
      return handleResolveHtlcLockEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'processHtlcTimeouts') {
      return handleProcessHtlcTimeoutsEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'rollbackTimedOutFrames') {
      return handleRollbackTimedOutFramesEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'manualHtlcLock') {
      return handleManualHtlcLockEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'directPayment') {
      return await handleDirectPaymentEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'r2c') {
      return await handleR2C(entityState, entityTx, env.timestamp);
    }

    if (entityTx.type === 'e2r') {
      return await handleE2R(entityState, entityTx);
    }

    if (entityTx.type === 'r2r') {
      return await handleR2R(entityState, entityTx);
    }

    if (entityTx.type === 'j_broadcast') {
      const batch = entityState.jBatchState?.batch;
      if (batch) {
        console.log(
          `🔍 APPLY j_broadcast: ${entityState.entityId.slice(-4)} batch r2r=${batch.reserveToReserve.length}, r2c=${batch.reserveToCollateral.length}, c2r=${batch.collateralToReserve.length}, settlements=${batch.settlements.length}, starts=${batch.disputeStarts.length}, finals=${batch.disputeFinalizations.length}`,
        );
      } else {
        console.log(`🔍 APPLY j_broadcast: ${entityState.entityId.slice(-4)} has no jBatchState`);
      }
      const result = await handleJBroadcast(entityState, entityTx, env);
      // j_broadcast returns jOutputs to queue to J-mempool
      return result;
    }

    if (entityTx.type === 'j_rebroadcast') {
      return await handleJRebroadcast(entityState, entityTx, env);
    }

    if (entityTx.type === 'j_abort_sent_batch') {
      return await handleJAbortSentBatch(entityState, entityTx, env);
    }

    if (entityTx.type === 'j_clear_batch') {
      return await handleJClearBatch(entityState, entityTx, env);
    }

    if (entityTx.type === 'mintReserves') {
      return await handleMintReserves(entityState, entityTx, env);
    }

    if (entityTx.type === 'createSettlement') {
      return await handleCreateSettlement(entityState, entityTx);
    }

    // === SETTLEMENT WORKSPACE HANDLERS ===
    if (entityTx.type === 'settle_propose') {
      return await handleSettlePropose(entityState, entityTx, env);
    }

    if (entityTx.type === 'settle_update') {
      return await handleSettleUpdate(entityState, entityTx, env);
    }

    if (entityTx.type === 'settle_approve') {
      const result = await handleSettleApprove(entityState, entityTx, env);
      return {
        ...result,
        ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
      };
    }

    if (entityTx.type === 'settle_execute') {
      return await handleSettleExecute(entityState, entityTx, env);
    }

    if (entityTx.type === 'settle_reject') {
      return await handleSettleReject(entityState, entityTx, env);
    }

    if (entityTx.type === 'extendCredit') {
      return handleExtendCreditEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'setHubConfig') {
      return handleSetHubConfigEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'setRebalancePolicy') {
      return handleSetRebalancePolicyEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'requestCollateral') {
      return handleRequestCollateralEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'reopenDisputedAccount') {
      return handleReopenDisputedAccountEntityTx(entityState, entityTx);
    }

    // === SWAP ENTITY HANDLERS ===
    if (entityTx.type === 'pullLock') {
      return handlePullLockEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'resolvePull') {
      return handleResolvePullEntityTx(env, entityState, entityTx);
	    }

    if (entityTx.type === 'cancelPull' || entityTx.type === 'pullCancelExpired') {
      return handleCancelPullEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'requestCrossJurisdictionSwap') {
      return handleRequestCrossJurisdictionSwapEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'prepareCrossJurisdictionSwap') {
      return handlePrepareCrossJurisdictionSwapEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'commitCrossJurisdictionSwap') {
      return handleCommitCrossJurisdictionSwapEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'registerCrossJurisdictionSwap') {
      return handleRegisterCrossJurisdictionSwapEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'crossJurisdictionFillNotice') {
      return handleCrossJurisdictionFillNoticeEntityTx(entityState, entityTx);
    }

    if (entityTx.type === 'requestCrossJurisdictionClear') {
      return handleRequestCrossJurisdictionClearEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'crossJurisdictionSalvage') {
      return handleCrossJurisdictionSalvageEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'orderbookSweepCrossJurisdiction') {
      return handleOrderbookSweepCrossJurisdictionEntityTx(env, entityState, entityTx);
    }

    if (entityTx.type === 'removeCrossJurisdictionBookOrder') {
      return handleRemoveCrossJurisdictionBookOrderEntityTx(env, entityState, entityTx);
    }

	    if (entityTx.type === 'placeSwapOffer') {
	      return handlePlaceSwapOfferRequest(env, entityState, entityTx);
	    }

    if (entityTx.type === 'resolveSwap') {
      return handleResolveSwapRequest(entityState, entityTx);
    }

    if (entityTx.type === 'cancelSwapOffer' || entityTx.type === 'cancelSwap' || entityTx.type === 'proposeCancelSwap') {
      return handleCancelSwapRequest(entityState, entityTx);
    }

    if (entityTx.type === 'r2e') {
      return handleR2E(entityState, entityTx);
    }

    if (entityTx.type === 'settleDiffs') {
      return handleSettleDiffsEntityTx(entityState, entityTx);
    }

    // === DISPUTES ===
    if (entityTx.type === 'disputeStart') {
      return await handleDisputeStart(entityState, entityTx, env);
    }

    if (entityTx.type === 'disputeFinalize') {
      return await handleDisputeFinalize(entityState, entityTx, env);
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
