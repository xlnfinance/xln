import type { AccountPeerInput, RuntimeOverlayRecord } from '../../types/account';
import type { EntityState, EntityOutput, HashType, EntityCandidateEffect } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type { JInput } from '../../jurisdiction/machine/input';
import type { EntityTx } from '../../types/entity-tx';
import type { AccountJClaimNodeStore } from '../../types/finance/account-j-claims';
import type { AccountConsensusContext } from '../../account/consensus/context';
import { createAccountConsensusContext } from '../account/account-consensus-context';
import {
  applyAccountInputToEntity,
  type AccountTxTarget,
  type SwapOfferEvent,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
} from './handlers/account';
import { applyJEvent } from './j-events';
import { shouldRethrowEntityTxError } from './processing/invariant-errors';
import { createStructuredLogger } from '../../infra/logger';
import { handleR2E } from './handlers/jurisdiction/r2e';
import { handleHtlcPayment } from './handlers/htlc/payment';
import { handleR2C } from './handlers/jurisdiction/r2c';
import { handleE2R } from './handlers/jurisdiction/e2r';
import { handleR2R } from './handlers/jurisdiction/r2r';
import { handleCrossPullCloseEntityTx } from './handlers/payments/pull';
import {
  handleCancelSwapRequest,
  handlePlaceSwapOfferRequest,
} from './handlers/payments/swap-requests';
import { handleJBroadcast } from './handlers/jurisdiction/j-broadcast';
import { handleJRebroadcast } from './handlers/jurisdiction/j-rebroadcast';
import { handleJAbortSentBatch } from './handlers/jurisdiction/j-abort-sent-batch';
import { handleJClearBatch } from './handlers/jurisdiction/j-clear-batch';
import { handleMintReserves } from './handlers/jurisdiction/mint-reserves';
import {
  handleSettleApprove,
  handleSettleExecute,
  handleSettlePropose,
  handleSettleReject,
  handleSettleUpdate,
} from './handlers/payments/settle';
import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from './handlers/dispute';
import {
  handleChatEntityTx,
  handleChatMessageEntityTx,
  handleInitOrderbookExtEntityTx,
  handleProfileUpdateEntityTx,
  handleProposeEntityTx,
  handleVoteEntityTx,
  handleReissueCertifiedOutputEntityTx,
} from './handlers/system/basic';
import { handleOpenAccountEntityTx } from './handlers/account/lifecycle/open-account';
import {
  handleProcessHtlcTimeoutsEntityTx,
  handleResolveHtlcLockEntityTx,
} from './handlers/htlc/direct';
import { handleDirectPaymentEntityTx } from './handlers/payments/direct-payment';
import {
  handleExtendCreditEntityTx,
  handleRequestCollateralEntityTx,
  handleSetHubConfigEntityTx,
  handleSetRebalancePolicyEntityTx,
} from './handlers/account/lifecycle/admin';
import {
  handleLendingBorrowEntityTx,
  handleLendingClosePositionEntityTx,
  handleLendingOfferEntityTx,
  handleLendingRepayEntityTx,
} from './handlers/payments/lending';
import {
  handleMaterializeCrossJurisdictionSwapEntityTx,
  handlePrepareCrossJurisdictionSwapEntityTx,
  handleRegisterCrossJurisdictionSwapEntityTx,
} from './handlers/cross-j/setup';
import { handleCrossJurisdictionFillNoticeEntityTx } from './handlers/cross-j/fill';
import {
  handleMaterializeCrossJurisdictionClearEntityTx,
  handleRequestCrossJurisdictionClearEntityTx,
} from './handlers/cross-j/clear';
import { handleCrossJurisdictionSalvageEntityTx } from './handlers/cross-j/salvage';
import { handleCrossJurisdictionForceSiblingDisputeEntityTx } from './handlers/cross-j/force-sibling-dispute';
import { handleOrderbookSweepCrossJurisdictionEntityTx } from './handlers/cross-j/sweep';
import {
  handleApplyCrossJurisdictionBookProgressEntityTx,
  handleAdmitCrossJurisdictionBookOrderEntityTx,
  handleCrossJurisdictionBookOrderRemovedEntityTx,
  handleRemoveCrossJurisdictionBookOrderEntityTx,
} from './handlers/cross-j/book-order';
import { handleScheduledWakeEntityTx } from './handlers/system/scheduled-wake';
import { handleCertifyProfileEntityTx } from './handlers/account/lifecycle/profile-certification';
import {
  handleEntityProviderCancelAction,
  handleEntityProviderReleaseControlShares,
  handleEntityProviderTransfer,
} from './handlers/entity-provider-action';
import type { AccountJClaimNodeChanges } from '../../types/finance/account-j-claims';
import { handleHtlcOnionAdvance } from './handlers/htlc/onion-advance';

const entityTxLog = createStructuredLogger('entity.tx');

// Extended return type including pure events from handlers
export interface ApplyEntityTxResult {
  newState: EntityState;
  outputs: EntityOutput[];
  storageChanges: RuntimeOverlayRecord[];
  candidateEffects: EntityCandidateEffect[];
  jOutputs?: JInput[];
  // Pure events for entity-level orchestration
  accountTxs?: AccountTxTarget[];
  /** Exact consensus response that the final Entity flush must preserve. */
  requiredAccountResponse?: AccountPeerInput;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  swapOffersCreated?: SwapOfferEvent[];
  swapCancelRequests?: SwapCancelRequestEvent[];
  swapOffersCancelled?: SwapCancelEvent[];
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: HashType; context: string }>;
  /** Exact action bytes released only by a real signed proposal quorum. */
  approvedEntityTxs?: EntityTx[];
  skippedError?: string;
}

export interface ApplyEntityTxOptions {
  accountConsensusContext?: AccountConsensusContext;
  mutableFrameState?: boolean;
  manualBroadcastInInput?: boolean;
  accountJClaimNodeStore?: AccountJClaimNodeStore;
  /** Reducer-local collector; interpreted only after the enclosing Entity frame commits. */
  storageChanges?: RuntimeOverlayRecord[];
  /** Notification collector bound to the same candidate frame. */
  candidateEffects?: EntityCandidateEffect[];
}

type EntityTxExecutionOptions = ApplyEntityTxOptions & {
  accountConsensusContext: AccountConsensusContext;
};

export type EntityTxReducerResult = Omit<ApplyEntityTxResult, 'storageChanges' | 'candidateEffects'> & {
  accountChanges?: string[];
  candidateEffects?: EntityCandidateEffect[];
};

type EntityTxDispatcher = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: EntityTx,
  options: EntityTxExecutionOptions,
) => Promise<EntityTxReducerResult> | EntityTxReducerResult;

type ReducibleEntityTx = Exclude<
  EntityTx,
  { type: 'entityCommand' | 'consensusOutput' | 'runtimeOutput' }
>;

const handleJEventEntityTx: EntityTxDispatcher = async (
  env,
  entityState,
  entityTx,
  options,
) => {
  if (entityTx.type !== 'j_event') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const jEventData = entityTx.data as {
    blocks?: Array<{
      blockNumber?: number;
      events?: Array<{ type?: string; transactionHash?: string; data?: Record<string, unknown> }>;
    }>;
  };
  const candidateEffects: EntityCandidateEffect[] = [];
  let emitted = false;
  for (const block of jEventData.blocks ?? []) {
    for (const event of block.events ?? []) {
      candidateEffects.push({
        kind: 'runtimeEvent',
        eventName: 'JEventReceived',
        data: {
          ...(event.data ?? {}),
          entityId: entityState.entityId,
          eventType: event.type ?? 'unknown',
          blockNumber: block.blockNumber,
          txHash: event.transactionHash,
        },
      });
      emitted = true;
    }
  }
  if (!emitted) {
    candidateEffects.push({
      kind: 'runtimeEvent',
      eventName: 'JEventReceived',
      data: { entityId: entityState.entityId, eventType: 'liveness' },
    });
  }
  const { newState, accountTxs, outputs, dirtyAccounts, hashesToSign } = await applyJEvent(
    entityState,
    entityTx.data,
    env,
    options.accountConsensusContext,
    candidateEffects,
    options?.mutableFrameState,
  );
  return {
    newState,
    outputs: outputs || [],
    candidateEffects,
    accountTxs: accountTxs || [],
    accountChanges: dirtyAccounts,
    ...(hashesToSign && hashesToSign.length > 0 ? { hashesToSign } : {}),
  };
};

const handleAccountInputEntityTx: EntityTxDispatcher = async (env, entityState, entityTx, options) => {
  if (entityTx.type !== 'accountInput') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const result = await applyAccountInputToEntity(
    entityState,
    entityTx.data,
    env,
    options.accountConsensusContext,
    options,
  );
  return {
    newState: result.newState,
    outputs: result.outputs,
    accountTxs: result.accountTxs,
    accountChanges: [entityTx.data.fromEntityId],
    candidateEffects: result.candidateEffects,
    swapOffersCreated: result.swapOffersCreated,
    swapCancelRequests: result.swapCancelRequests,
    swapOffersCancelled: result.swapOffersCancelled,
    ...(result.requiredAccountResponse ? { requiredAccountResponse: result.requiredAccountResponse } : {}),
    ...(result.accountJClaimNodeChanges ? { accountJClaimNodeChanges: result.accountJClaimNodeChanges } : {}),
    ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
  };
};

const handleSettleApproveEntityTx: EntityTxDispatcher = async (
  env,
  entityState,
  entityTx,
  options,
) => {
  if (entityTx.type !== 'settle_approve') throw new Error(`ENTITY_TX_DISPATCH_MISMATCH: ${entityTx.type}`);
  const result = await handleSettleApprove(
    entityState,
    entityTx,
    env,
    options?.mutableFrameState,
  );
  return {
    ...result,
    ...(result.hashesToSign && result.hashesToSign.length > 0 && { hashesToSign: result.hashesToSign }),
  };
};

const handleJBroadcastEntityTx: EntityTxDispatcher = async (
  env,
  entityState,
  entityTx,
  options,
) => {
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
  return handleJBroadcast(
    entityState,
    entityTx,
    env,
    options?.mutableFrameState,
  );
};

// This table is intentionally boring: adding a new EntityTx should mean adding
// one row here and keeping domain behavior inside runtime/entity/tx/handlers.
const entityTxDispatchers = {
  scheduledWake: (env, state, tx, options) => handleScheduledWakeEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'scheduledWake' }>,
    options?.manualBroadcastInInput === true,
  ),
  chat: (_env, state, tx, options) => handleChatEntityTx(
    state,
    tx as Extract<EntityTx, { type: 'chat' }>,
    options?.mutableFrameState,
  ),
  chatMessage: (_env, state, tx, options) => handleChatMessageEntityTx(
    state,
    tx as Extract<EntityTx, { type: 'chatMessage' }>,
    options?.mutableFrameState,
  ),
  propose: (env, state, tx, options) => handleProposeEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'propose' }>,
    options?.mutableFrameState,
  ),
  vote: (env, state, tx, options) => handleVoteEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'vote' }>,
    options?.mutableFrameState,
  ),
  reissueCertifiedOutput: (env, state, tx) => handleReissueCertifiedOutputEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'reissueCertifiedOutput' }>,
  ),
  'profile-update': (env, state, tx, options) => handleProfileUpdateEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'profile-update' }>,
    options?.mutableFrameState,
  ),
  certifyProfile: (env, state, tx, options) => handleCertifyProfileEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'certifyProfile' }>,
    options?.mutableFrameState,
  ),
  initOrderbookExt: (_env, state, tx, options) => handleInitOrderbookExtEntityTx(
    state,
    tx as Extract<EntityTx, { type: 'initOrderbookExt' }>,
    options?.mutableFrameState,
  ),
  j_event: handleJEventEntityTx,
  accountInput: handleAccountInputEntityTx,
  openAccount: (_env, state, tx, options) => handleOpenAccountEntityTx(
    state,
    tx as Extract<EntityTx, { type: 'openAccount' }>,
    options.accountConsensusContext,
    options?.candidateEffects ?? [],
    options?.mutableFrameState,
  ),
  htlcPayment: (env, state, tx, options) => handleHtlcPayment(
    state,
    tx as Extract<EntityTx, { type: 'htlcPayment' }>,
    env,
    options?.candidateEffects ?? [],
    options?.mutableFrameState,
  ),
  htlcOnionAdvance: (env, state, tx, options) => handleHtlcOnionAdvance(
    env,
    state,
    tx as Extract<EntityTx, { type: 'htlcOnionAdvance' }>,
    options?.candidateEffects ?? [],
    options?.mutableFrameState,
  ),
  resolveHtlcLock: (_env, state, tx, options) => handleResolveHtlcLockEntityTx(state, tx as Extract<EntityTx, { type: 'resolveHtlcLock' }>, options?.mutableFrameState),
  processHtlcTimeouts: (_env, state, tx, options) => handleProcessHtlcTimeoutsEntityTx(state, tx as Extract<EntityTx, { type: 'processHtlcTimeouts' }>, options?.mutableFrameState),
  directPayment: (env, state, tx, options) => handleDirectPaymentEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'directPayment' }>,
    options?.candidateEffects ?? [],
    options?.mutableFrameState,
  ),
  r2c: (_env, state, tx, options) => handleR2C(
    state,
    tx as Extract<EntityTx, { type: 'r2c' }>,
    options?.mutableFrameState,
  ),
  e2r: (_env, state, tx, options) => handleE2R(
    state,
    tx as Extract<EntityTx, { type: 'e2r' }>,
    options?.mutableFrameState,
  ),
  r2r: (_env, state, tx, options) => handleR2R(
    state,
    tx as Extract<EntityTx, { type: 'r2r' }>,
    options?.mutableFrameState,
  ),
  j_broadcast: handleJBroadcastEntityTx,
  entityProviderTransfer: (env, state, tx, options) => handleEntityProviderTransfer(
    state,
    tx as Extract<EntityTx, { type: 'entityProviderTransfer' }>,
    env,
    options?.mutableFrameState,
  ),
  entityProviderReleaseControlShares: (env, state, tx, options) => handleEntityProviderReleaseControlShares(
    state,
    tx as Extract<EntityTx, { type: 'entityProviderReleaseControlShares' }>,
    env,
    options?.mutableFrameState,
  ),
  entityProviderCancelAction: (env, state, tx, options) => handleEntityProviderCancelAction(
    state,
    tx as Extract<EntityTx, { type: 'entityProviderCancelAction' }>,
    env,
    options?.mutableFrameState,
  ),
  j_rebroadcast: (env, state, tx, options) => handleJRebroadcast(
    state,
    tx as Extract<EntityTx, { type: 'j_rebroadcast' }>,
    env,
    options?.mutableFrameState,
  ),
  j_abort_sent_batch: (env, state, tx, options) => handleJAbortSentBatch(
    state,
    tx as Extract<EntityTx, { type: 'j_abort_sent_batch' }>,
    env,
    options?.mutableFrameState,
  ),
  j_clear_batch: (env, state, tx, options) => handleJClearBatch(
    state,
    tx as Extract<EntityTx, { type: 'j_clear_batch' }>,
    env,
    options?.mutableFrameState,
  ),
  mintReserves: (env, state, tx, options) => handleMintReserves(
    state,
    tx as Extract<EntityTx, { type: 'mintReserves' }>,
    env,
    options?.mutableFrameState,
  ),
  settle_propose: (env, state, tx, options) => handleSettlePropose(
    state,
    tx as Extract<EntityTx, { type: 'settle_propose' }>,
    env,
    options?.mutableFrameState,
  ),
  settle_update: (env, state, tx, options) => handleSettleUpdate(
    state,
    tx as Extract<EntityTx, { type: 'settle_update' }>,
    env,
    options?.mutableFrameState,
  ),
  settle_approve: handleSettleApproveEntityTx,
  settle_execute: (env, state, tx, options) => handleSettleExecute(
    state,
    tx as Extract<EntityTx, { type: 'settle_execute' }>,
    env,
    options?.mutableFrameState,
  ),
  settle_reject: (env, state, tx, options) => handleSettleReject(
    state,
    tx as Extract<EntityTx, { type: 'settle_reject' }>,
    env,
    options?.mutableFrameState,
  ),
  extendCredit: (_env, state, tx, options) => handleExtendCreditEntityTx(
    state,
    tx as Extract<EntityTx, { type: 'extendCredit' }>,
    options?.mutableFrameState,
  ),
  lendingOffer: (_env, state, tx, options) => handleLendingOfferEntityTx(state, tx as Extract<EntityTx, { type: 'lendingOffer' }>, options?.mutableFrameState),
  lendingBorrow: (_env, state, tx, options) => handleLendingBorrowEntityTx(state, tx as Extract<EntityTx, { type: 'lendingBorrow' }>, options?.mutableFrameState),
  lendingRepay: (_env, state, tx, options) => handleLendingRepayEntityTx(state, tx as Extract<EntityTx, { type: 'lendingRepay' }>, options?.mutableFrameState),
  lendingClosePosition: (_env, state, tx, options) => handleLendingClosePositionEntityTx(state, tx as Extract<EntityTx, { type: 'lendingClosePosition' }>, options?.mutableFrameState),
  setHubConfig: (env, state, tx, options) => handleSetHubConfigEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'setHubConfig' }>,
    options?.mutableFrameState,
  ),
  setRebalancePolicy: (env, state, tx, options) => handleSetRebalancePolicyEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'setRebalancePolicy' }>,
    options?.mutableFrameState,
  ),
  requestCollateral: (_env, state, tx, options) => handleRequestCollateralEntityTx(
    state,
    tx as Extract<EntityTx, { type: 'requestCollateral' }>,
    options?.mutableFrameState,
  ),
  crossPullClose: (env, state, tx, options) => handleCrossPullCloseEntityTx(env, state, tx as Extract<EntityTx, { type: 'crossPullClose' }>, options),
  prepareCrossJurisdictionSwap: (env, state, tx, options) => handlePrepareCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'prepareCrossJurisdictionSwap' }>, options),
  materializeCrossJurisdictionSwap: (env, state, tx, options) => handleMaterializeCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'materializeCrossJurisdictionSwap' }>, options),
  registerCrossJurisdictionSwap: (env, state, tx, options) => handleRegisterCrossJurisdictionSwapEntityTx(env, state, tx as Extract<EntityTx, { type: 'registerCrossJurisdictionSwap' }>, options),
  crossJurisdictionFillNotice: (_env, state, tx, options) => handleCrossJurisdictionFillNoticeEntityTx(state, tx as Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>, options?.mutableFrameState),
  materializeCrossJurisdictionClear: (env, state, tx, options) => handleMaterializeCrossJurisdictionClearEntityTx(env, state, tx as Extract<EntityTx, { type: 'materializeCrossJurisdictionClear' }>, options?.mutableFrameState),
  requestCrossJurisdictionClear: (env, state, tx, options) => handleRequestCrossJurisdictionClearEntityTx(env, state, tx as Extract<EntityTx, { type: 'requestCrossJurisdictionClear' }>, options?.storageChanges, options?.mutableFrameState),
  crossJurisdictionSalvage: (env, state, tx, options) => handleCrossJurisdictionSalvageEntityTx(
    env,
    state,
    tx as Extract<EntityTx, { type: 'crossJurisdictionSalvage' }>,
    options?.storageChanges,
    options?.mutableFrameState,
  ),
  crossJurisdictionForceSiblingDispute: (env, state, tx, options) =>
    handleCrossJurisdictionForceSiblingDisputeEntityTx(
      env,
      state,
      tx as Extract<EntityTx, { type: 'crossJurisdictionForceSiblingDispute' }>,
      options?.storageChanges,
      options?.mutableFrameState,
    ),
  orderbookSweepCrossJurisdiction: (env, state, tx, options) => handleOrderbookSweepCrossJurisdictionEntityTx(env, state, tx as Extract<EntityTx, { type: 'orderbookSweepCrossJurisdiction' }>, options?.storageChanges, options?.mutableFrameState),
  admitCrossJurisdictionBookOrder: (env, state, tx, options) => handleAdmitCrossJurisdictionBookOrderEntityTx(env, state, tx as Extract<EntityTx, { type: 'admitCrossJurisdictionBookOrder' }>, options),
  applyCrossJurisdictionBookProgress: (env, state, tx, options) => handleApplyCrossJurisdictionBookProgressEntityTx(env, state, tx as Extract<EntityTx, { type: 'applyCrossJurisdictionBookProgress' }>, options),
  removeCrossJurisdictionBookOrder: (env, state, tx, options) => handleRemoveCrossJurisdictionBookOrderEntityTx(env, state, tx as Extract<EntityTx, { type: 'removeCrossJurisdictionBookOrder' }>, options),
  crossJurisdictionBookOrderRemoved: (env, state, tx, options) => handleCrossJurisdictionBookOrderRemovedEntityTx(env, state, tx as Extract<EntityTx, { type: 'crossJurisdictionBookOrderRemoved' }>, options),
  placeSwapOffer: (_env, state, tx, options) => handlePlaceSwapOfferRequest(state, tx as Extract<EntityTx, { type: 'placeSwapOffer' }>, options),
  proposeCancelSwap: (_env, state, tx, options) => handleCancelSwapRequest(state, tx as Extract<EntityTx, { type: 'proposeCancelSwap' }>, options),
  r2e: (_env, state, tx, options) => handleR2E(
    state,
    tx as Extract<EntityTx, { type: 'r2e' }>,
    options?.mutableFrameState,
  ),
  prepareDispute: (env, state, tx, options) => handlePrepareDispute(state, tx as Extract<EntityTx, { type: 'prepareDispute' }>, env, options?.storageChanges, options?.mutableFrameState),
  disputeStart: (env, state, tx, options) => handleDisputeStart(state, tx as Extract<EntityTx, { type: 'disputeStart' }>, env, options?.storageChanges, options?.mutableFrameState),
  disputeFinalize: (env, state, tx, options) => handleDisputeFinalize(state, tx as Extract<EntityTx, { type: 'disputeFinalize' }>, env, options?.mutableFrameState),
} satisfies Record<ReducibleEntityTx['type'], EntityTxDispatcher>;

export const applyEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: EntityTx,
  options?: ApplyEntityTxOptions,
): Promise<ApplyEntityTxResult> => {
  if (!entityTx) {
    throw new TypeError('ENTITY_TX_UNDEFINED');
  }
  if (
    entityTx.type === 'entityCommand' ||
    entityTx.type === 'consensusOutput' ||
    entityTx.type === 'runtimeOutput'
  ) {
    throw new TypeError(`ENTITY_TX_WRAPPER_REACHED_REDUCER:${entityTx.type}`);
  }

  try {
    const dispatcher: EntityTxDispatcher | undefined = entityTxDispatchers[entityTx.type];
    if (!dispatcher) {
      const skippedError = `ENTITY_TX_UNHANDLED: type=${String(entityTx.type)}`;
      entityTxLog.warn('unhandled', { type: String(entityTx.type) });
      return {
        newState: entityState,
        outputs: [],
        storageChanges: [],
        candidateEffects: [],
        jOutputs: [],
        skippedError,
      };
    }
    const reducerStorageChanges: RuntimeOverlayRecord[] = [];
    const reducerCandidateEffects: EntityCandidateEffect[] = [];
    const { accountChanges = [], ...result } = await dispatcher(env, entityState, entityTx, {
      ...options,
      accountConsensusContext: options?.accountConsensusContext ?? createAccountConsensusContext(env),
      storageChanges: reducerStorageChanges,
      candidateEffects: reducerCandidateEffects,
    });
    const entityId = result.newState.entityId.toLowerCase();
    return {
      ...result,
      candidateEffects: [...reducerCandidateEffects, ...(result.candidateEffects ?? [])],
      storageChanges: [
        { family: 'entity', entityId },
        ...Array.from(new Set(accountChanges.map(accountId => accountId.toLowerCase())))
          .sort()
          .map(counterpartyId => ({ family: 'account' as const, entityId, counterpartyId })),
        ...reducerStorageChanges,
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A TypeError is a programming fault, not an invalid user transaction.
    // Converting it to skippedError destroys the source stack and mislabels a
    // deterministic reducer bug as malformed ingress. Halt with the original
    // error so the Runtime can preserve state and report the exact fault.
    if (error instanceof TypeError) {
      entityTxLog.error('local_bug', {
        type: String(entityTx.type),
        error: message,
        stack: error.stack,
      });
      throw error;
    }
    if (shouldRethrowEntityTxError(error)) {
      entityTxLog.error('failed_invariant', { type: String(entityTx.type), error: message });
      throw error;
    }
    // warn, not debug: a silently skipped tx is indistinguishable from a lost
    // one from every caller's perspective (ingress receipts still report
    // "observed"), and that blindness has already cost timeout-only failures.
    entityTxLog.warn('skipped_error', { type: String(entityTx.type), error: message });
    return {
      newState: entityState,
      outputs: [],
      storageChanges: [],
      candidateEffects: [],
      jOutputs: [],
      skippedError: message,
    };
  }
};
