import type {
  AccountInput,
  EntityState,
  Env,
  EntityInput,
  EntityCandidateEffect,
} from '../../../types';
import { applyAccountInput } from '../../../account/consensus/index';
import { addMessage } from '../../../state-helpers';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import { processSettleAction } from './settle';
import type { MempoolOp } from './account/orderbook-queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';
import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from '../../../account/consensus/flush';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/board-registry';
import type { AccountJClaimNodeChanges } from '../../../types/account-j-claims';
import type { ApplyEntityTxOptions } from '../apply';
import { cumulativeMarksToPhases } from '../../../infra/perf-profile';
import { getPerfMs } from '../../../utils';
import { resolveInboundAccount } from './account/inbound-account';
import {
  rejectFrozenAccountInput,
} from './account/frozen-input';
import {
  applySuccessfulAccountInput,
  type CommittedAccountEffects,
} from './account/committed-input';
import { handleUnsafeAccountFrame } from './account/dispute-input';

export {
  canProcessFrozenAccountInput,
  frozenAccountInputLogLevel,
} from './account/frozen-input';

export type { MempoolOp } from './account/orderbook-queue';
export {
  compareSwapOffersForOrderbook,
  normalizeSwapOfferForOrderbook,
  sortSwapOffersForOrderbook,
} from './account/orderbook-offers';
export {
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
} from './account/orderbook-cancels';
export { processOrderbookSwaps } from './account/orderbook-matching';
export type {
  MatchResult,
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';

const accountHandlerLog = createStructuredLogger('account.handler');
const ACCOUNT_INPUT_PROFILE = typeof process !== 'undefined' && (
  process.env?.['XLN_ACCOUNT_INPUT_PROFILE'] === '1' ||
  process.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1'
);
const ACCOUNT_INPUT_SLOW_MS = Math.max(
  0,
  Number(typeof process !== 'undefined' ? process.env?.['XLN_ACCOUNT_INPUT_SLOW_MS'] || '250' : '250'),
);
const accountInputProfileEnabled = (): boolean =>
  ACCOUNT_INPUT_PROFILE || process.env?.['XLN_ACCOUNT_INPUT_PROFILE'] === '1' || process.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const accountInputSlowMs = (): number => {
  const configured = Number(process.env?.['XLN_ACCOUNT_INPUT_SLOW_MS'] ?? ACCOUNT_INPUT_SLOW_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : ACCOUNT_INPUT_SLOW_MS;
};

export { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';

export interface AccountHandlerResult {
  newState: EntityState;
  outputs: EntityInput[];
  // Pure events for entity-level orchestration:
  mempoolOps: MempoolOp[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: SwapCancelRequestEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  /** Exact consensus response that the final Entity flush must preserve. */
  requiredAccountResponse?: AccountInput;
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute' | 'settlement'; context: string }>;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  candidateEffects: EntityCandidateEffect[];
}

const buildAccountHandlerResult = (
  newState: EntityState,
  effects: CommittedAccountEffects,
  requiredAccountResponse?: AccountInput,
  accountJClaimNodeChanges?: AccountJClaimNodeChanges,
): AccountHandlerResult => ({
  newState,
  outputs: effects.outputs,
  mempoolOps: effects.mempoolOps,
  swapOffersCreated: effects.swapOffersCreated,
  swapCancelRequests: effects.swapCancelRequests,
  swapOffersCancelled: effects.swapOffersCancelled,
  candidateEffects: effects.candidateEffects,
  ...(requiredAccountResponse ? { requiredAccountResponse } : {}),
  ...(effects.hashesToSign.length > 0 ? { hashesToSign: effects.hashesToSign } : {}),
  ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
});

export async function applyAccountInputToEntity(
  state: EntityState,
  input: AccountInput,
  env: Env,
  options?: ApplyEntityTxOptions,
): Promise<AccountHandlerResult> {
  const profileStartedAt = getPerfMs();
  const profileMarks: Record<string, number> = {};
  const checkpointProfile = (label: string): void => {
    profileMarks[label] = Math.round(getPerfMs() - profileStartedAt);
  };
  let profileOutcome = 'returned';
  try {
  // State is already cloned at the Entity-frame boundary.
  const newState: EntityState = state;
  const incomingAck = accountInputAck(input);
  const incomingProposal = accountInputProposal(input);
  accountHandlerLog.debug('input.apply', {
    from: shortId(input.fromEntityId),
    to: shortId(input.toEntityId),
    height: accountInputReferenceHeight(input),
    frame: Boolean(incomingProposal),
    prevHanko: Boolean(incomingAck),
  });

  // Followups append to one explicit effect accumulator. No helper publishes
  // transport or storage effects directly from the isolated Entity candidate.
  const effects: CommittedAccountEffects = {
    outputs: [],
    mempoolOps: [],
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    candidateEffects: [],
    hashesToSign: [],
  };
  const { outputs, hashesToSign: allHashesToSign } = effects;
  let accountJClaimNodeChanges: AccountJClaimNodeChanges | undefined;

  let requiredAccountResponse: AccountInput | undefined;
  const { accountMachine, counterpartyId, createdAccount } = resolveInboundAccount(
    newState,
    input,
    Boolean(incomingAck),
    Boolean(incomingProposal),
  );
  checkpointProfile('accountResolve');

  // Entity-local dispute evidence selects the exact signed proof for J.
  // No external AccountInput may extend that lane once the freeze begins.
  if (rejectFrozenAccountInput(newState, accountMachine, input, counterpartyId)) {
    return buildAccountHandlerResult(newState, effects);
  }

  // NOTE: Credit limits start at 0 - no auto-credit on account opening
  // Credit must be explicitly extended via set_credit_limit transaction

  // === SETTLEMENT WORKSPACE ACTIONS ===
  // Process settleAction before frame consensus (bilateral negotiation)
  if (input.kind === 'settle') {
    const result = await processSettleAction(
      accountMachine,
      input.settleAction,
      input.fromEntityId,
      newState.entityId,
      newState.timestamp, // Entity-level timestamp for determinism
      env,
      newState,
    );

    if (result.success) {
      addMessage(newState, `⚖️ ${result.message}`);
      // Inline auto-approve: send hanko back to proposer immediately
      if (result.autoApproveOutput) {
        outputs.push(result.autoApproveOutput);
      }
      if (result.hashesToSign) {
        allHashesToSign.push(...result.hashesToSign);
      }
    } else {
      accountHandlerLog.warn('settle_action.failed', {
        from: shortId(input.fromEntityId),
        message: result.message,
      });
      addMessage(newState, `⚠️ Settlement: ${result.message}`);
    }
  }
  checkpointProfile('preConsensus');

  // CHANNEL.TS PATTERN: Apply frame-level consensus only.
  if (incomingAck || incomingProposal || input.kind === 'dispute' || input.kind === 'board_reseal') {
    const pendingBeforeTxs = accountMachine.pendingFrame?.accountTxs?.map(tx => tx.type) || [];
    const inputFrameTxs = incomingProposal?.frame.accountTxs.map(tx => tx.type) || [];
    accountHandlerLog.debug('frame.process', {
      from: shortId(input.fromEntityId),
      pending: accountMachine.pendingFrame ? accountMachine.pendingFrame.height : null,
    });

    const counterpartyCertifiedBoardHash = resolveObserverCertifiedBoardHash(
      newState,
      getCertifiedBoardNodeStore(env),
      input.fromEntityId,
    );
    const result = await applyAccountInput(env, accountMachine, input, {
      entityTimestamp: newState.timestamp,
      finalizedJHeight: newState.lastFinalizedJHeight ?? 0,
      owningEntityIsHub: Boolean(newState.hubRebalanceConfig),
      ...(counterpartyCertifiedBoardHash ? { counterpartyCertifiedBoardHash } : {}),
    }, options?.accountJClaimNodeStore);
    checkpointProfile('consensus');
    accountJClaimNodeChanges = result.accountJClaimNodeChanges;
    const touchesCrossFillAck =
      pendingBeforeTxs.includes('cross_swap_fill_ack') ||
      inputFrameTxs.includes('cross_swap_fill_ack') ||
      (result.committedFrames ?? []).some(({ frame }) =>
        (frame.accountTxs ?? []).some(tx => tx.type === 'cross_swap_fill_ack'),
      );
    if (touchesCrossFillAck) {
      accountHandlerLog.debug('cross_fill_ack.input_result', {
        entity: shortId(newState.entityId),
        counterparty: shortId(counterpartyId),
        inputHeight: accountInputReferenceHeight(input),
        hasPrevHanko: Boolean(incomingAck),
        inputFrameTxs,
        pendingBeforeTxs,
        pendingAfter: accountMachine.pendingFrame?.accountTxs?.map(tx => tx.type) || [],
        currentHeight: accountMachine.currentHeight,
        committedTxs: (result.committedFrames ?? []).map(({ frame }) => frame.accountTxs.map(tx => tx.type)),
        events: result.events,
        success: result.success,
        error: result.success ? undefined : result.error,
      });
    }

    if (result.success) {
      requiredAccountResponse = await applySuccessfulAccountInput({
        env,
        state: newState,
        input,
        account: accountMachine,
        counterpartyId,
        createdAccount,
        result,
        effects,
        ...(options ? { options } : {}),
        checkpointProfile,
      });
      checkpointProfile('postConsensus');
    } else if (result.disputeRequired) {
      const unsafe = await handleUnsafeAccountFrame({
        env,
        state: newState,
        input,
        account: accountMachine,
        counterpartyId,
        createdAccount,
        dispute: result.disputeRequired,
        effects,
      });
      return buildAccountHandlerResult(
        unsafe.newState,
        { ...effects, outputs: unsafe.outputs },
        undefined,
        accountJClaimNodeChanges,
      );
    } else if (result.rejected) {
      accountHandlerLog.warn('frame.rejected', {
        from: shortId(input.fromEntityId),
        error: result.rejected.reason,
      });
      addMessage(newState, `⚠️ Rejected account frame: ${result.rejected.reason}`);
      return buildAccountHandlerResult(
        newState,
        effects,
        undefined,
        accountJClaimNodeChanges,
      );
    } else {
      accountHandlerLog.error('frame.consensus_failed', {
        from: shortId(input.fromEntityId),
        error: result.error,
      });
      addMessage(newState, `❌ ${result.error}`);
      throw new Error(`FRAME_CONSENSUS_FAILED: ${result.error || 'unknown'}`);
    }
  } else if (input.kind !== 'settle') {
    // Only error if there was no settleAction either
    // Settlement workspace actions (propose/update/approve/reject) don't require frames
    const error = `ACCOUNT_INPUT_EMPTY: from=${shortId(input.fromEntityId)} to=${shortId(input.toEntityId)}`;
    accountHandlerLog.error('input.empty', {
      from: shortId(input.fromEntityId),
      to: shortId(input.toEntityId),
    });
    addMessage(newState, `❌ ${error}`);
    throw new Error(error);
  }

  checkpointProfile('finalize');
  return buildAccountHandlerResult(
    newState,
    effects,
    requiredAccountResponse,
    accountJClaimNodeChanges,
  );
  } catch (error) {
    profileOutcome = 'threw';
    throw error;
  } finally {
    const elapsedMs = Math.round(getPerfMs() - profileStartedAt);
    if (accountInputProfileEnabled() || elapsedMs >= accountInputSlowMs()) {
      accountHandlerLog.info('input.profile', {
        entity: shortId(state.entityId, 8),
        counterparty: shortId(input.fromEntityId, 8),
        kind: input.kind,
        height: accountInputReferenceHeight(input) ?? null,
        proposalTxs: accountInputProposal(input)?.frame.accountTxs.length ?? 0,
        outcome: profileOutcome,
        elapsedMs,
        phases: cumulativeMarksToPhases(profileMarks, elapsedMs),
      });
    }
  }
}
