import { requireUsableContractAddress } from '../contract-address';
import { isLeftEntity } from '../entity-id-utils';
import { formatEntityId } from '../utils';
import type { EntityState, EntityTx, Env, AccountTx, EntityInput, JInput, HashType, CrossJurisdictionSwapRoute } from '../types';
import { DEFAULT_SOFT_LIMIT } from '../types';
import { safeStringify } from '../serialization-utils';
import { announceLocalEntityProfile } from '../networking/gossip-helper';
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
import { normalizeRebalanceMatchingStrategy } from '../rebalance-policy';
import { initJBatch, batchAddSettlement } from '../j-batch';
import { handleR2E } from './handlers/r2e';
import { handleHtlcPayment } from './handlers/htlc-payment';
import { requireRuntimeJurisdictionDisputeDelayMs } from '../j-height';
import {
	buildCrossJurisdictionPullReveal,
	buildPreparedCrossJurisdictionRoute,
	getCrossJurisdictionPrivateSeed,
	isCrossJurisdictionPullExpired,
	isCrossJurisdictionRouteExpired,
	isCrossJurisdictionTerminalStatus,
	cloneCrossJurisdictionRoute,
	transitionCrossJurisdictionRouteStatus,
	validateCrossJurisdictionFillProgress,
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

const entityTxLog = createStructuredLogger('entity.tx');
import {
  accountHasCrossSwapAckQueued,
  accountHasPullResolveQueued,
  canonicalizeCrossJurisdictionRouteForKnownEntities,
  findCrossJurisdictionOfferRoute,
  isCrossJurisdictionRouteParticipant,
  mergeCrossJurisdictionRoute,
  validateCrossJurisdictionLocalBinding,
  validateCrossJurisdictionRouteTransition,
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
      console.log(
        `💳 EXTEND-CREDIT: ${entityState.entityId.slice(-4)} extending credit to ${entityTx.data.counterpartyEntityId.slice(-4)}`,
      );

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, tokenId, amount } = entityTx.data;

      // Get account machine (use canonical key)
      // Account keyed by counterparty ID
      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for credit extension`);
        return { newState: entityState, outputs: [] };
      }

      // Create set_credit_limit account transaction
      // Side auto-detected by handler from frame proposer (no explicit side needed)
      const accountTx: AccountTx = {
        type: 'set_credit_limit',
        data: { tokenId, amount },
      };

      // Pure: return mempoolOp instead of mutating directly
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
      console.log(
        `💳 Added set_credit_limit to mempoolOps for account with ${counterpartyEntityId.slice(-4)} amount=${amount}`,
      );

      addMessage(newState, `💳 Extended credit of ${amount} to ${counterpartyEntityId.slice(-4)}`);

      // Trigger processing (same pattern as directPayment)
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({
          entityId: entityState.entityId,
          signerId: firstValidator,
          entityTxs: [], // Empty - triggers processing
        });
      }

      console.log(`💸 DIRECT-PAYMENT RETURN: outputs.length=${outputs.length}`);

      return { newState, outputs, mempoolOps };
    }

    // === HUB CONFIG (declare entity as hub, enable rebalance crontab) ===
    if (entityTx.type === 'setHubConfig') {
      const newState = cloneEntityState(entityState);
      const {
        matchingStrategy: matchingStrategyRaw = 'amount',
        policyVersion: policyVersionRaw,
        routingFeePPM = 1,
        baseFee = 0n,
        swapTakerFeeBps = 0,
        disputeAutoFinalizeMode = 'auto',
        minCollateralThreshold = 0n,
        c2rWithdrawSoftLimit = DEFAULT_SOFT_LIMIT,
        minFeeBps = 1n,
        rebalanceBaseFee = 10n ** 17n, // $0.10
        rebalanceLiquidityFeeBps = 1n, // 0.01%
        rebalanceGasFee = 0n,
        rebalanceTimeoutMs = 10 * 60 * 1000,
      } = entityTx.data;
      const matchingStrategy = normalizeRebalanceMatchingStrategy(matchingStrategyRaw);
      const previousConfig = entityState.hubRebalanceConfig;
      const previousVersion = previousConfig?.policyVersion ?? 0;
      const feePolicyChanged = !previousConfig ||
        (previousConfig.rebalanceBaseFee ?? 10n ** 17n) !== rebalanceBaseFee ||
        (previousConfig.rebalanceLiquidityFeeBps ?? previousConfig.minFeeBps ?? 1n) !== rebalanceLiquidityFeeBps ||
        (previousConfig.rebalanceGasFee ?? 0n) !== rebalanceGasFee;
      const requestedPolicyVersion = Number.isFinite(policyVersionRaw as number) && Number(policyVersionRaw) > 0
        ? Number(policyVersionRaw)
        : undefined;
      let policyVersion: number;
      if (requestedPolicyVersion !== undefined) {
        if (requestedPolicyVersion < previousVersion) {
          console.warn(
            `⚠️ setHubConfig policyVersion downgrade blocked: requested=${requestedPolicyVersion} < current=${previousVersion}`,
          );
          policyVersion = previousVersion;
        } else {
          policyVersion = requestedPolicyVersion;
        }
      } else if (previousVersion <= 0) {
        policyVersion = 1;
      } else {
        policyVersion = feePolicyChanged ? previousVersion + 1 : previousVersion;
      }
      const effectiveC2RWithdrawSoftLimit =
        c2rWithdrawSoftLimit < DEFAULT_SOFT_LIMIT ? DEFAULT_SOFT_LIMIT : c2rWithdrawSoftLimit;
      const normalizedSwapTakerFeeBps = Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBps) || 0)));

      newState.hubRebalanceConfig = {
        matchingStrategy,
        policyVersion,
        routingFeePPM,
        baseFee,
        swapTakerFeeBps: normalizedSwapTakerFeeBps,
        disputeAutoFinalizeMode,
        minCollateralThreshold,
        c2rWithdrawSoftLimit: effectiveC2RWithdrawSoftLimit,
        minFeeBps,
        rebalanceBaseFee,
        rebalanceLiquidityFeeBps,
        rebalanceGasFee,
        rebalanceTimeoutMs,
      };
      newState.profile = {
        ...newState.profile,
        isHub: true,
      };
      console.log(
        `🏦 Hub config set: strategy=${matchingStrategy}, policyVersion=${policyVersion}, routingFee=${routingFeePPM}ppm, ` +
        `swapTakerFee=${normalizedSwapTakerFeeBps}bps, ` +
        `rebalance(base=${rebalanceBaseFee},liqBps=${rebalanceLiquidityFeeBps},gas=${rebalanceGasFee},timeoutMs=${rebalanceTimeoutMs},c2rWithdrawSoftLimit=${effectiveC2RWithdrawSoftLimit})` +
        `${feePolicyChanged ? ' [fee-policy-updated]' : ''}`,
      );

      // Announce updated profile with isHub: true
      if (env?.gossip) {
        const profile = announceLocalEntityProfile(env, newState, env.timestamp);
        console.log(`📡 Hub profile announced: ${newState.entityId.slice(-4)} isHub=${profile.metadata.isHub}`);
      }

      addMessage(
        newState,
        `🏦 Hub config activated: ${matchingStrategy} strategy v${policyVersion}, ${routingFeePPM}ppm routing fee, ` +
        `swapTakerFee=${normalizedSwapTakerFeeBps}bps, ` +
        `rebalance(base=${rebalanceBaseFee}, liqBps=${rebalanceLiquidityFeeBps}, gas=${rebalanceGasFee}, c2rWithdrawSoftLimit=${effectiveC2RWithdrawSoftLimit})`,
      );
      return { newState, outputs: [] };
    }

    if (entityTx.type === 'setRebalancePolicy') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for rebalance policy`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'set_rebalance_policy',
        data: { tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee },
      };
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'requestCollateral') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId, tokenId, amount, feeTokenId, feeAmount, policyVersion } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for collateral request`);
        return { newState: entityState, outputs: [] };
      }

      const accountTx: AccountTx = {
        type: 'request_collateral',
        data: {
          tokenId,
          amount,
          ...(feeTokenId !== undefined ? { feeTokenId } : {}),
          feeAmount,
          policyVersion,
        },
      };
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }

      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'reopenDisputedAccount') {
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      const { counterpartyEntityId } = entityTx.data;

      const accountMachine = newState.accounts.get(counterpartyEntityId);
      if (!accountMachine) {
        console.error(`❌ No account with ${counterpartyEntityId.slice(-4)} for reopen`);
        return { newState: entityState, outputs: [] };
      }

      const onChainNonce = Number(entityTx.data.onChainNonce ?? accountMachine.onChainSettlementNonce ?? 0);

      const accountTx: AccountTx = {
        type: 'reopen_disputed',
        data: { onChainNonce },
      };
      mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({ entityId: entityState.entityId, signerId: firstValidator, entityTxs: [] });
      }
      addMessage(newState, `🔓 Reopen requested with ${counterpartyEntityId.slice(-4)} at nonce=${onChainNonce}`);

      return { newState, outputs, mempoolOps };
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
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      try {
        route = withCanonicalCrossJurisdictionRouteHash(
          canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
        );
      } catch (error) {
        addMessage(newState, `❌ Cross-j request invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      const now = deterministicEntityTimestamp(newState, env);
      if (isCrossJurisdictionRouteExpired(route, now)) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} expired`);
        return { newState, outputs };
      }
      const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
      if (bindingError) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} blocked: ${bindingError}`);
        return { newState, outputs };
      }
      if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.entityId)) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} routed to wrong source entity`);
        return { newState, outputs };
      }
      if (!newState.accounts.has(normalizeEntityRef(route.source.counterpartyEntityId))) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} blocked: no source account with ${formatEntityId(route.source.counterpartyEntityId)}`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(route.orderId);
      if (existing) {
        addMessage(newState, `❌ Cross-j request ${route.orderId} already exists (${existing.status})`);
        return { newState, outputs };
      }
      const intentRoute = {
        ...route,
        status: 'intent' as const,
        updatedAt: newState.timestamp || env.timestamp,
      };
      newState.crossJurisdictionSwaps.set(intentRoute.orderId, intentRoute);
      pushCrossJOutput(env, outputs, intentRoute.source.counterpartyEntityId, [{
          type: 'prepareCrossJurisdictionSwap',
          data: { route: intentRoute },
        }]);
      addMessage(newState, `🌉 Cross-j swap ${intentRoute.orderId} requested`);
      return { newState, outputs };
    }

    if (entityTx.type === 'prepareCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      try {
        route = withCanonicalCrossJurisdictionRouteHash(
          canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
        );
      } catch (error) {
        addMessage(newState, `❌ Cross-j prepare invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} wrong source hub`);
        return { newState, outputs };
      }
      const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
      if (bindingError) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} blocked: ${bindingError}`);
        return { newState, outputs };
      }
      const preparedRoute = buildPreparedCrossJurisdictionRoute(route, {
        runtimeSeed: (env as { runtimeSeed?: string }).runtimeSeed,
        sourceDisputeDelayMs: requireRuntimeJurisdictionDisputeDelayMs(env, route.source.jurisdiction),
        now: newState.timestamp || env.timestamp,
      });
      if (!preparedRoute.targetPull || !preparedRoute.sourcePull) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} failed: pull commitments missing`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(preparedRoute.orderId);
      const transitionError = validateCrossJurisdictionRouteTransition(existing, preparedRoute);
      if (transitionError) {
        addMessage(newState, `❌ Cross-j prepare ${route.orderId} blocked: ${transitionError}`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps.set(preparedRoute.orderId, mergeCrossJurisdictionRoute(existing, preparedRoute));
      const publicPreparedRoute = cloneCrossJurisdictionRoute(preparedRoute);

      pushCrossJOutput(env, outputs, publicPreparedRoute.target.entityId, [
          { type: 'registerCrossJurisdictionSwap', data: { route: publicPreparedRoute } },
          {
            type: 'pullLock',
            data: {
              counterpartyEntityId: publicPreparedRoute.target.counterpartyEntityId,
              pullId: publicPreparedRoute.targetPull!.pullId,
              tokenId: publicPreparedRoute.targetPull!.tokenId,
              amount: publicPreparedRoute.targetPull!.signedAmount,
              revealedUntilTimestamp: publicPreparedRoute.targetPull!.revealedUntilTimestamp,
              fullHash: publicPreparedRoute.targetPull!.fullHash,
              partialRoot: publicPreparedRoute.targetPull!.partialRoot,
              description: publicPreparedRoute.memo || `Cross-j target pull ${publicPreparedRoute.orderId}`,
            },
          },
        ]);
      pushCrossJOutput(env, outputs, publicPreparedRoute.target.counterpartyEntityId, [
        { type: 'registerCrossJurisdictionSwap', data: { route: publicPreparedRoute } },
      ]);
      pushCrossJOutput(env, outputs, publicPreparedRoute.source.entityId, [
        { type: 'commitCrossJurisdictionSwap', data: { route: publicPreparedRoute } },
      ]);
      addMessage(newState, `🌉 Cross-j swap ${preparedRoute.orderId} prepared by hub`);
      return { newState, outputs };
    }

    if (entityTx.type === 'commitCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      try {
        route = withCanonicalCrossJurisdictionRouteHash(
          canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
        );
      } catch (error) {
        addMessage(newState, `❌ Cross-j commit invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs };
      }
      const now = deterministicEntityTimestamp(newState, env);
      if (isCrossJurisdictionRouteExpired(route, now) || isCrossJurisdictionPullExpired(route, 'source', now)) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} expired`);
        return { newState, outputs };
      }
      if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.entityId)) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} routed to wrong source entity`);
        return { newState, outputs };
      }
      const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
      if (bindingError) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${bindingError}`);
        return { newState, outputs };
      }
      if (!route.sourcePull || !route.targetPull) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} missing pull commitments`);
        return { newState, outputs };
      }
      const sourcePull = route.sourcePull;
      const targetPull = route.targetPull;
      const restingRoute = {
        ...cloneCrossJurisdictionRoute(route),
        sourcePull,
        targetPull,
        status: 'resting' as const,
        updatedAt: newState.timestamp || env.timestamp,
      };
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(restingRoute.orderId);
      const transitionError = validateCrossJurisdictionRouteTransition(existing, restingRoute);
      if (transitionError) {
        addMessage(newState, `❌ Cross-j commit ${route.orderId} blocked: ${transitionError}`);
        return { newState, outputs };
      }
      newState.crossJurisdictionSwaps.set(restingRoute.orderId, mergeCrossJurisdictionRoute(existing, restingRoute));
      const firstValidator = entityState.config.validators[0];
      outputs.push({
        entityId: newState.entityId,
        ...(firstValidator ? { signerId: firstValidator } : {}),
        entityTxs: [
          {
            type: 'pullLock',
            data: {
              counterpartyEntityId: restingRoute.source.counterpartyEntityId,
              pullId: sourcePull.pullId,
              tokenId: sourcePull.tokenId,
              amount: sourcePull.signedAmount,
              revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
              fullHash: sourcePull.fullHash,
              partialRoot: sourcePull.partialRoot,
              description: restingRoute.memo || `Cross-j source pull ${restingRoute.orderId}`,
            },
          },
          {
            type: 'placeSwapOffer',
            data: {
              counterpartyEntityId: restingRoute.source.counterpartyEntityId,
              offerId: restingRoute.orderId,
              giveTokenId: restingRoute.source.tokenId,
              giveAmount: restingRoute.source.amount,
              wantTokenId: restingRoute.target.tokenId,
              wantAmount: restingRoute.target.amount,
              ...(restingRoute.priceTicks !== undefined ? { priceTicks: restingRoute.priceTicks } : {}),
              timeInForce: 0,
              minFillRatio: 0,
              crossJurisdiction: cloneCrossJurisdictionRoute(restingRoute),
            },
          },
        ],
      });
      addMessage(newState, `🌉 Cross-j swap ${restingRoute.orderId} committed by source`);
      return { newState, outputs };
    }

    if (entityTx.type === 'registerCrossJurisdictionSwap') {
      let route: CrossJurisdictionSwapRoute;
      const newState = cloneEntityState(entityState);
      try {
        route = withCanonicalCrossJurisdictionRouteHash(
          canonicalizeCrossJurisdictionRouteForKnownEntities(env, newState, entityTx.data.route),
        );
      } catch (error) {
        addMessage(newState, `❌ Cross-j register invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs: [] };
      }
      if (!isCrossJurisdictionRouteParticipant(newState.entityId, route)) {
        addMessage(newState, `❌ Cross-j register ${route.orderId} routed to non-participant entity`);
        return { newState, outputs: [] };
      }
      const bindingError = validateCrossJurisdictionLocalBinding(env, newState, route);
      if (bindingError) {
        addMessage(newState, `❌ Cross-j register ${route.orderId} blocked: ${bindingError}`);
        return { newState, outputs: [] };
      }
      newState.crossJurisdictionSwaps ||= new Map();
      const existing = newState.crossJurisdictionSwaps.get(route.orderId);
      const transitionError = validateCrossJurisdictionRouteTransition(existing, route);
      if (transitionError) {
        addMessage(newState, `❌ Cross-j swap ${route.orderId} register blocked: ${transitionError}`);
        return { newState, outputs: [] };
      }
      newState.crossJurisdictionSwaps.set(route.orderId, mergeCrossJurisdictionRoute(existing, route));
      addMessage(newState, `🌉 Cross-j swap ${route.orderId} registered`);
      return { newState, outputs: [] };
    }

    if (entityTx.type === 'crossJurisdictionFillNotice') {
      const {
        orderId,
        fillSeq,
        incrementalSourceAmount,
        incrementalTargetAmount,
        cumulativeSourceAmount,
        cumulativeTargetAmount,
        cumulativeFillRatio,
        priceImprovementMode,
        priceImprovementAmount,
        priceImprovementTokenId,
        priceTicks,
        pairId,
      } = entityTx.data;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      let route = newState.crossJurisdictionSwaps?.get(orderId);
      if (!route) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} missing entity-level route`);
        return { newState, outputs, mempoolOps };
      }
      const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
      if (offerRoute) {
        try {
          route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
          newState.crossJurisdictionSwaps ||= new Map();
          newState.crossJurisdictionSwaps.set(orderId, route);
        } catch {
          // Keep the entity-level route; validation below will reject if it is unusable.
        }
      }
      const currentEntityId = normalizeEntityRef(newState.entityId);
      const routeBookOwner = normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);
      const routeSourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
      if (routeBookOwner !== currentEntityId && routeSourceHub !== currentEntityId) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} routed to wrong book owner/source hub`);
        return { newState, outputs, mempoolOps };
      }
      const allowed = route.status === 'resting' || route.status === 'partially_filled';
      if (!allowed) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked in status ${route.status}`);
        return { newState, outputs, mempoolOps };
      }
      const validatedFill = validateCrossJurisdictionFillProgress(route, {
        fillSeq,
        cumulativeFillRatio,
        incrementalSourceAmount,
        incrementalTargetAmount,
        cumulativeSourceAmount,
        cumulativeTargetAmount,
      });
      if (!validatedFill.ok) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked: ${validatedFill.error}`);
        return { newState, outputs, mempoolOps };
      }
      const fill = validatedFill.value;
      const accountId = findAccountKey(newState, route.source.entityId);
      if (!accountId) {
        addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked: no source account`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId,
        tx: {
          type: 'cross_swap_fill_ack',
          data: {
            offerId: orderId,
            fillSeq: fill.fillSeq,
            incrementalSourceAmount: fill.incrementalSourceAmount,
            incrementalTargetAmount: fill.incrementalTargetAmount,
            cumulativeSourceAmount: fill.cumulativeSourceAmount,
            cumulativeTargetAmount: fill.cumulativeTargetAmount,
            cumulativeFillRatio: fill.nextRatio,
            executionSourceAmount: priceImprovementMode === 'source_savings' && (priceImprovementAmount ?? 0n) > 0n
              ? fill.incrementalSourceAmount - (priceImprovementAmount ?? 0n)
              : fill.incrementalSourceAmount,
            executionTargetAmount: priceImprovementMode === 'target_bonus' && (priceImprovementAmount ?? 0n) > 0n
              ? fill.incrementalTargetAmount + (priceImprovementAmount ?? 0n)
              : fill.incrementalTargetAmount,
            ...(priceImprovementMode ? { priceImprovementMode } : {}),
            ...(priceImprovementAmount !== undefined ? { priceImprovementAmount } : {}),
            ...(priceImprovementTokenId !== undefined ? { priceImprovementTokenId } : {}),
            cancelRemainder: fill.nextRatio >= 65_535,
            ...(priceTicks !== undefined ? { priceTicks } : {}),
            pairId,
            comment: `cross-j-fill-notice:${fill.nextRatio}`,
          },
        },
      });
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
      addMessage(newState, `🌉 Cross-j fill notice ${orderId} queued account ack ${fill.nextRatio}/65535`);
      return { newState, outputs, mempoolOps };
    }

    if (entityTx.type === 'requestCrossJurisdictionClear') {
      const { orderId, cancelRemainder = false } = entityTx.data;
      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const mempoolOps: MempoolOp[] = [];
      let route = newState.crossJurisdictionSwaps?.get(orderId);
      if (!route) {
        addMessage(newState, `❌ Cross-j clear ${orderId} missing route`);
        return { newState, outputs, mempoolOps };
      }
      const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
      if (offerRoute) {
        try {
          route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
          newState.crossJurisdictionSwaps ||= new Map();
          newState.crossJurisdictionSwaps.set(orderId, route);
        } catch {
          // Keep the entity-level route; validation below will reject if it is unusable.
        }
      }
      const sourceHubId = normalizeEntityRef(route.source.counterpartyEntityId);
      if (normalizeEntityRef(newState.entityId) !== sourceHubId) {
        pushCrossJOutput(env, outputs, route.source.counterpartyEntityId, [{
            type: 'requestCrossJurisdictionClear',
            data: { orderId, cancelRemainder, route: cloneCrossJurisdictionRoute(route) },
          }]);
        const requestedAt = deterministicEntityTimestamp(newState, env);
        transitionCrossJurisdictionRouteStatus(route, 'clear_requested', requestedAt);
        route.pendingClearRequestedAt = requestedAt;
        route.clearingPolicy = cancelRemainder ? 'cancel_and_clear' : 'manual';
        newState.crossJurisdictionSwaps?.set(orderId, route);
        addMessage(newState, `🌉 Cross-j clear ${orderId} requested from source hub`);
        return { newState, outputs, mempoolOps };
      }

      let canonicalRoute: CrossJurisdictionSwapRoute;
      try {
        canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
      } catch (error) {
        addMessage(newState, `❌ Cross-j clear ${orderId} invalid route: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs, mempoolOps };
      }
      if (!canonicalRoute.sourcePull || !canonicalRoute.targetPull) {
        addMessage(newState, `❌ Cross-j clear ${orderId} blocked: pull commitments missing`);
        return { newState, outputs, mempoolOps };
      }
      const ratio = Math.max(
        0,
        Math.min(65_535, Math.floor(Number(canonicalRoute.cumulativeFillRatio ?? canonicalRoute.claimedRatio ?? 0) || 0)),
      );
      const accountId = findAccountKey(newState, canonicalRoute.source.entityId);
      const account = accountId ? newState.accounts.get(accountId) : undefined;
      const liveOffer = account?.swapOffers?.get(orderId);
      if (liveOffer?.crossJurisdiction && (cancelRemainder || ratio > 0)) {
        if (!accountId || !account) {
          addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${formatEntityId(canonicalRoute.source.entityId)}`);
          return { newState, outputs, mempoolOps };
        }
        if (accountHasCrossSwapAckQueued(account, orderId)) {
          addMessage(newState, `🌉 Cross-j clear ${orderId} waiting for account offer close ack`);
          return { newState, outputs, mempoolOps };
        }
        const removedFromBook = cancelOrderbookOfferIfPresent(env, newState, accountId, orderId);
        mempoolOps.push({
          accountId,
          tx: buildCrossJurisdictionCancelAck(orderId, canonicalRoute),
        });
        const requestedAt = deterministicEntityTimestamp(newState, env);
        transitionCrossJurisdictionRouteStatus(canonicalRoute, 'clear_requested', requestedAt);
        canonicalRoute.pendingClearRequestedAt = requestedAt;
        canonicalRoute.clearingPolicy = 'cancel_and_clear';
        newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
        addMessage(
          newState,
          removedFromBook
            ? `🌉 Cross-j clear ${orderId} removed live book order and queued account offer close before pull reveal`
            : `🌉 Cross-j clear ${orderId} queued account offer close before pull reveal`,
        );
        return { newState, outputs, mempoolOps };
      }
      if (ratio <= 0) {
        if (!cancelRemainder) {
          addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: no pending fill`);
          return { newState, outputs, mempoolOps };
        }
        if (accountId && account?.pulls?.has(canonicalRoute.sourcePull.pullId)) {
          mempoolOps.push({
            accountId,
            tx: {
              type: 'pull_cancel',
              data: {
                pullId: canonicalRoute.sourcePull.pullId,
                reason: 'cross_j_cancel_no_fill',
              },
            },
          });
        }
        pushCrossJOutput(env, outputs, canonicalRoute.target.counterpartyEntityId, [{
            type: 'cancelPull',
            data: {
              counterpartyEntityId: canonicalRoute.target.entityId,
              pullId: canonicalRoute.targetPull.pullId,
              description: `Cross-j ${orderId} cancel target pull without fill`,
            },
          }]);
        const requestedAt = deterministicEntityTimestamp(newState, env);
        transitionCrossJurisdictionRouteStatus(canonicalRoute, 'cancelled', requestedAt);
        canonicalRoute.pendingClearRequestedAt = requestedAt;
        canonicalRoute.clearingPolicy = 'cancel_and_clear';
        newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
        addMessage(newState, `🌉 Cross-j clear ${orderId} cancelled without fill`);
        return { newState, outputs, mempoolOps };
      }
      if (!accountId || !account) {
        addMessage(newState, `❌ Cross-j clear ${orderId} blocked: no source account with ${formatEntityId(canonicalRoute.source.entityId)}`);
        return { newState, outputs, mempoolOps };
      }
      if (!account.pulls?.has(canonicalRoute.sourcePull.pullId)) {
        addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull already closed`);
        return { newState, outputs, mempoolOps };
      }
      if (accountHasPullResolveQueued(account, canonicalRoute.sourcePull.pullId)) {
        addMessage(newState, `🌉 Cross-j clear ${orderId} ignored: source pull resolve already queued`);
        return { newState, outputs, mempoolOps };
      }
      let reveal;
      try {
        reveal = buildCrossJurisdictionPullReveal(
          canonicalRoute,
          ratio,
          getCrossJurisdictionPrivateSeed(env, canonicalRoute),
        );
      } catch (error) {
        addMessage(newState, `❌ Cross-j clear ${orderId} reveal failed: ${error instanceof Error ? error.message : String(error)}`);
        return { newState, outputs, mempoolOps };
      }
      mempoolOps.push({
        accountId,
        tx: {
          type: 'pull_resolve',
          data: {
            pullId: canonicalRoute.sourcePull.pullId,
            binary: reveal.binary,
          },
        },
      });
      const sourceSavingsAmount = canonicalRoute.priceImprovementSourceAmount ?? 0n;
      if (sourceSavingsAmount > 0n) {
        mempoolOps.push({
          accountId,
          tx: {
            type: 'direct_payment',
            data: {
              tokenId: Number(canonicalRoute.source.tokenId),
              amount: sourceSavingsAmount,
              route: [],
              description: `cross-j-source-savings:${orderId}`,
              fromEntityId: canonicalRoute.source.counterpartyEntityId,
              toEntityId: canonicalRoute.source.entityId,
            },
          },
        });
      }
      const closeRemainder = cancelRemainder || ratio < 65_535;
      const requestedAt = deterministicEntityTimestamp(newState, env);
      transitionCrossJurisdictionRouteStatus(canonicalRoute, 'clearing', requestedAt);
      canonicalRoute.pendingClearRequestedAt = requestedAt;
      canonicalRoute.clearingPolicy = closeRemainder ? 'cancel_and_clear' : ratio >= 65_535 ? 'full_fill' : 'manual';
      newState.crossJurisdictionSwaps?.set(orderId, canonicalRoute);
      const firstValidator = entityState.config.validators[0];
      if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
      addMessage(newState, `🌉 Cross-j clear ${orderId} queued ratio=${ratio}/65535`);
      return { newState, outputs, mempoolOps };
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
      console.log(`🏦 SETTLE-DIFFS: Processing settlement with ${entityTx.data.counterpartyEntityId}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];
      const { counterpartyEntityId, diffs, description, sig } = entityTx.data;

      // Step 1: Validate invariant for all diffs
      for (const diff of diffs) {
        const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
        if (sum !== 0n) {
          logError('ENTITY_TX', `❌ INVARIANT-VIOLATION: leftDiff + rightDiff + collateralDiff = ${sum} (must be 0)`);
          throw new Error(`Settlement invariant violation: ${sum} !== 0`);
        }
      }

      // Step 2: Validate account exists (keyed by counterparty ID)
      if (!newState.accounts.has(counterpartyEntityId)) {
        logError('ENTITY_TX', `❌ No account exists with ${formatEntityId(counterpartyEntityId)}`);
        throw new Error(`No account with ${counterpartyEntityId}`);
      }

      // Step 3: Determine canonical left/right order
      const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);
      const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
      const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

      console.log(`🏦 Canonical order: left=${leftEntity.slice(0, 10)}..., right=${rightEntity.slice(0, 10)}...`);
      console.log(`🏦 We are: ${isLeft ? 'LEFT' : 'RIGHT'}`);

      // Step 4: Get jurisdiction config
      const jurisdiction = entityState.config.jurisdiction;
      if (!jurisdiction) {
        throw new Error('No jurisdiction configured for this entity');
      }

      // Step 5: Convert diffs to contract format (keep as bigint - ethers handles conversion)
      const contractDiffs = diffs.map(d => ({
        tokenId: d.tokenId,
        leftDiff: d.leftDiff,
        rightDiff: d.rightDiff,
        collateralDiff: d.collateralDiff,
        ondeltaDiff: d.ondeltaDiff || 0n,
      }));

      console.log(`🏦 Queueing settlement diff batch:`, safeStringify(contractDiffs, 2));

      // Step 6: Add settlement to jBatch and trigger j_broadcast.
      if (!sig || sig === '0x') {
        throw new Error(
          `Settlement ${entityState.entityId.slice(-4)}↔${counterpartyEntityId.slice(-4)} missing hanko signature`,
        );
      }

      if (!newState.jBatchState) {
        newState.jBatchState = initJBatch();
      }
      const entityProviderAddress = requireUsableContractAddress(
        'entity_provider',
        jurisdiction.entityProviderAddress,
      );
      batchAddSettlement(
        newState.jBatchState,
        leftEntity,
        rightEntity,
        contractDiffs,
        [],
        sig,
        entityProviderAddress,
        '0x',
        0,
        entityState.entityId,
      );

      const firstValidator = entityState.config.validators[0];
      if (firstValidator) {
        outputs.push({
          entityId: entityState.entityId,
          signerId: firstValidator,
          entityTxs: [{
            type: 'j_broadcast',
            data: {},
          }],
        });
      }

      addMessage(
        newState,
        `🏦 ${description || 'Settlement'} queued to jBatch`,
      );

      return { newState, outputs };
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
