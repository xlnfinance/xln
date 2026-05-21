import { formatEntityId } from '../utils';
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
import { pushCrossJurisdictionEntityOutput } from './cross-j-outputs';
import { handleJEvent } from './j-events';
import { shouldRethrowEntityTxError } from './invariant-errors';
import { cloneEntityState, addMessage } from '../state-helpers';
import { createStructuredLogger, logError } from '../logger';
import { handleR2E } from './handlers/r2e';
import { handleHtlcPayment } from './handlers/htlc-payment';
import {
	isCrossJurisdictionPullExpired,
	isCrossJurisdictionRouteExpired,
	isCrossJurisdictionTerminalStatus,
	transitionCrossJurisdictionRouteStatus,
	withCanonicalCrossJurisdictionRouteHash,
} from '../cross-jurisdiction';
import { decodeHashLadderBinary } from '../hashladder';
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
import { buildCrossJurisdictionCancelAck } from '../cross-jurisdiction-orderbook';
import { removeBookOrderById, removeCrossJurisdictionBookOrderByRouteId } from '../orderbook/cross-j';
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

const entityTxLog = createStructuredLogger('entity.tx');
import {
  accountHasCrossSwapAckQueued,
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from './cross-jurisdiction-helpers';
import { findAccountKey, normalizeEntityRef } from './account-key';

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

const deterministicEntityTimestamp = (state: EntityState, env: Env): number =>
  Number(state.timestamp || env.timestamp || 0);
const cancelOrderbookOfferIfPresent = (
  env: Env,
  state: EntityState,
  accountId: string,
  offerId: string,
): boolean => removeBookOrderById(env, state, `${accountId}:${offerId}`);

const pushCrossJOutput = (
  env: Env,
  outputs: EntityInput[],
  entityId: string,
  entityTxs: EntityTx[],
): void => {
  pushCrossJurisdictionEntityOutput(env, outputs, entityId, entityTxs);
};

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
	      const { routeId, binary, fillRatio, sourceEntityId, sourceCounterpartyEntityId, observedAt } = entityTx.data;
	      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      if (!binary || binary === '0x' || fillRatio <= 0) {
        addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: empty pull args`);
        return { newState, outputs };
      }
      try {
        const decoded = decodeHashLadderBinary(binary);
        if (decoded.fillRatio <= 0) {
          addMessage(newState, `🌉 Cross-j salvage ignored for ${routeId}: zero pull binary`);
          return { newState, outputs };
        }
      } catch (error) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} invalid pull binary: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      const route = newState.crossJurisdictionSwaps?.get(routeId);
      if (!route) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} missing local route`);
        return { newState, outputs };
      }
      if (!route.targetPull) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} missing target pull commitment`);
        return { newState, outputs };
      }
      if (isCrossJurisdictionPullExpired(route, 'target', deterministicEntityTimestamp(newState, env))) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} target pull expired`);
        return { newState, outputs };
      }
      const targetUserEntityId = normalizeEntityRef(route.target.counterpartyEntityId);
      const targetHubEntityId = normalizeEntityRef(route.target.entityId);
      if (normalizeEntityRef(newState.entityId) !== targetUserEntityId) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} routed to wrong sibling entity`);
        return { newState, outputs };
      }
      if (!newState.accounts.has(targetHubEntityId)) {
        addMessage(newState, `❌ Cross-j salvage ${routeId} blocked: no target account with ${targetHubEntityId.slice(-4)}`);
        return { newState, outputs };
      }
      const requestedAt = deterministicEntityTimestamp(newState, env);
      transitionCrossJurisdictionRouteStatus(route, 'clearing', requestedAt);
      route.pendingClearRequestedAt = requestedAt;
      newState.crossJurisdictionSwaps ||= new Map();
      newState.crossJurisdictionSwaps.set(route.orderId, route);
      const firstValidator = entityState.config.validators[0];
      outputs.push({
        entityId: newState.entityId,
        ...(firstValidator ? { signerId: firstValidator } : {}),
        entityTxs: [
          {
            type: 'resolvePull',
            data: {
              counterpartyEntityId: targetHubEntityId,
              pullId: route.targetPull.pullId,
              binary,
              description:
                `Cross-j salvage resolve ${routeId} fill=${fillRatio}/65535 ` +
                `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}`,
            },
          },
          {
            type: 'disputeStart',
            data: {
              counterpartyEntityId: targetHubEntityId,
              description:
                `Cross-j salvage ${routeId} fill=${fillRatio}/65535 ` +
                `source=${sourceEntityId.slice(-4)}:${sourceCounterpartyEntityId.slice(-4)}` +
                (observedAt ? ` observed=${observedAt}` : ''),
            },
          },
          { type: 'j_broadcast', data: {} },
        ],
      });
      addMessage(newState, `🌉 Cross-j salvage queued for ${routeId}: target dispute vs ${targetHubEntityId.slice(-4)}`);
	      return { newState, outputs };
	    }

	    if (entityTx.type === 'orderbookSweepCrossJurisdiction') {
	      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const now = deterministicEntityTimestamp(newState, env);
      let expiredRoutes = 0;
      let closedOffers = 0;
      let waitingRoutes = 0;

      for (const [orderId, storedRoute] of [...(newState.crossJurisdictionSwaps?.entries?.() ?? [])]) {
        let route = storedRoute;
        const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
        if (offerRoute) {
          try {
            route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
            newState.crossJurisdictionSwaps?.set(orderId, route);
          } catch {
            // The expiry cleanup below will still fail closed on the entity-level route.
          }
        }
        if (isCrossJurisdictionTerminalStatus(route.status)) continue;
        const routeExpired = isCrossJurisdictionRouteExpired(route, now);
        const sourceExpired = isCrossJurisdictionPullExpired(route, 'source', now);
        const targetExpired = isCrossJurisdictionPullExpired(route, 'target', now);
        if (!routeExpired && !sourceExpired && !targetExpired) {
          waitingRoutes++;
          continue;
        }

        expiredRoutes++;
        const sourceEntityId = (route.source as { entityId?: string } | undefined)?.entityId;
        if (!sourceEntityId) {
          transitionCrossJurisdictionRouteStatus(route, 'failed', now);
          newState.crossJurisdictionSwaps?.set(orderId, route);
          addMessage(newState, `🌉 Cross-j sweep ${orderId}: failed malformed route without source entity`);
          continue;
        }

        const accountId = findAccountKey(newState, sourceEntityId);
        const account = accountId ? newState.accounts.get(accountId) : undefined;
        const hasFilledAmount =
          Number(route.cumulativeFillRatio || route.claimedRatio || 0) > 0 ||
          (route.filledSourceAmount ?? route.sourceClaimed ?? 0n) > 0n ||
          (route.filledTargetAmount ?? route.targetClaimed ?? 0n) > 0n;

        if (accountId && account?.swapOffers?.has(orderId)) {
          cancelOrderbookOfferIfPresent(env, newState, accountId, orderId);
          if (!accountHasCrossSwapAckQueued(account, orderId)) {
            mempoolOps.push({
              accountId,
              tx: buildCrossJurisdictionCancelAck(orderId, route),
            });
            closedOffers++;
          }
        } else if (!accountId) {
          addMessage(newState, `🌉 Cross-j sweep ${orderId}: no source account for ${formatEntityId(sourceEntityId)}`);
        } else {
          addMessage(newState, `🌉 Cross-j sweep ${orderId}: no live source offer in ${formatEntityId(accountId)}`);
        }

        if (!hasFilledAmount) {
          if (accountId && account?.pulls?.has(route.sourcePull?.pullId || '')) {
            const sourcePullId = route.sourcePull!.pullId;
            mempoolOps.push({
              accountId,
              tx: {
                type: 'pull_cancel',
                data: {
                  pullId: sourcePullId,
                  reason: 'expired',
                },
              },
            });
          }
          if (route.targetPull && route.target?.counterpartyEntityId && route.target?.entityId) {
            pushCrossJOutput(env, outputs, route.target.counterpartyEntityId, [{
                type: 'cancelPull',
                data: {
                  counterpartyEntityId: route.target.entityId,
                  pullId: route.targetPull.pullId,
                  description: `Cross-j ${orderId} sweep cancel target pull`,
                },
              }]);
          }
          transitionCrossJurisdictionRouteStatus(route, 'expired', now);
        } else {
          if (sourceExpired) {
            throw new Error(`CROSS_J_FILLED_ROUTE_SOURCE_PULL_EXPIRED: route=${orderId}`);
          }
          transitionCrossJurisdictionRouteStatus(route, 'failed', now);
        }
        route.clearingPolicy = hasFilledAmount ? 'manual' : 'cancel_and_clear';
        newState.crossJurisdictionSwaps?.set(orderId, route);
      }

      if (expiredRoutes > 0) {
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
      }
	      addMessage(
        newState,
        `🌉 Cross-j orderbook sweep${entityTx.data?.reason ? `: ${entityTx.data.reason}` : ''} ` +
        `expired=${expiredRoutes} closedOffers=${closedOffers} waiting=${waitingRoutes}`,
      );
	      return { newState, outputs, mempoolOps };
	    }

	    if (entityTx.type === 'removeCrossJurisdictionBookOrder') {
	      const newState = cloneEntityState(entityState);
      const removed = removeCrossJurisdictionBookOrderByRouteId(
        env,
        newState,
        entityTx.data.sourceEntityId,
        entityTx.data.orderId,
      );
      addMessage(
        newState,
        `🌉 Cross-j book remove ${entityTx.data.orderId}${entityTx.data.reason ? `: ${entityTx.data.reason}` : ''} ` +
        `${removed ? 'removed' : 'not-present'}`,
      );
	      return { newState, outputs: [] };
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
