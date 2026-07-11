import type { AccountInput, EntityState, Env, EntityInput, AccountMachine } from '../../types';
import { markStorageAccountDirty, markStorageEntityDirty } from '../../env-events';
import { applyAccountInput as applyConsensusAccountInput } from '../../account-consensus';
import { addMessage, addMessages, emitScopedEvents, resolveEntityProposerId } from '../../state-helpers';
import { createStructuredLogger, shortId } from '../../logger';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
} from '../../account-state-root';
import { isLeftEntity } from '../../entity-id-utils';
import { scheduleHook as scheduleCrontabHook } from '../../entity-crontab';
import { upsertSortedStringMapEntry } from '../../sorted-index';
import { assertSameJurisdictionAccount } from '../../jurisdiction-runtime';
import { normalizeAccountWatchSeed } from '../../account-watch-seed';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from './account-cross-j-followups';
import { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';
import {
  applyCommittedHtlcLockFollowup,
  applyHtlcSecretFollowups,
  applyHtlcTimeoutFollowups,
  applyPendingForwardFollowup,
} from './account/committed-htlc-followups';
import { processSettleAction } from './settle';
import type { MempoolOp } from './account/orderbook-queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';
import { canProcessAccountTxForDisputeStatus } from '../../account-dispute-policy';
import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from '../../account-consensus/flush';

export type { MempoolOp } from './account/orderbook-queue';
export {
  collectOpenSwapOffersForOrderbook,
  compareSwapOffersForOrderbook,
  normalizeSwapOfferForOrderbook,
  sortSwapOffersForOrderbook,
} from './account/orderbook-offers';
export { processOrderbookCancels } from './account/orderbook-cancels';
export { processOrderbookSwaps } from './account/orderbook-matching';
export type {
  MatchResult,
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const accountHandlerLog = createStructuredLogger('account.handler');

export { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';

const findAccountKeyInsensitive = (accounts: Map<string, AccountMachine>, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  for (const key of accounts.keys()) {
    if (normalizeEntityRef(key) === target) return key;
  }
  return null;
};


export interface AccountHandlerResult {
  newState: EntityState;
  outputs: EntityInput[];
  // Pure events for entity-level orchestration:
  mempoolOps: MempoolOp[];
  swapOffersCreated: SwapOfferEvent[];
  swapCancelRequests: SwapCancelRequestEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute' | 'settlement'; context: string }>;
}

export async function applyAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<AccountHandlerResult> {
  const incomingAck = accountInputAck(input);
  const incomingProposal = accountInputProposal(input);
  accountHandlerLog.debug('input.apply', {
    from: shortId(input.fromEntityId),
    to: shortId(input.toEntityId),
    height: accountInputReferenceHeight(input),
    frame: Boolean(incomingProposal),
    prevHanko: Boolean(incomingAck),
  });

  // CRITICAL: Don't clone here - state already cloned at entity level (applyEntityTx)
  const newState: EntityState = state;  // Use state directly
  if (normalizeEntityRef(input.toEntityId) !== normalizeEntityRef(newState.entityId)) {
    throw new Error(
      `ACCOUNT_INPUT_WRONG_TARGET: expected=${shortId(newState.entityId)} got=${shortId(input.toEntityId)}`,
    );
  }
  if (normalizeEntityRef(input.fromEntityId) === normalizeEntityRef(newState.entityId)) {
    throw new Error(`ACCOUNT_INPUT_SELF_SENDER: entity=${shortId(newState.entityId)}`);
  }
  const outputs: EntityInput[] = [];

  // Collect events for entity-level orchestration (pure - no direct mempool mutation)
  const mempoolOps: MempoolOp[] = [];
  const allSwapOffersCreated: SwapOfferEvent[] = [];
  const allSwapCancelRequests: SwapCancelRequestEvent[] = [];
  const allSwapOffersCancelled: SwapCancelEvent[] = [];
  // Multi-signer: Collect hashes during processing (not scanning)
  const allHashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [];

  // Get or create account machine (KEY: counterparty ID for simpler lookups)
  // AccountMachine still uses canonical left/right internally
  const counterpartyId = normalizeEntityRef(input.fromEntityId);
  markStorageEntityDirty(env, newState.entityId);
  const existingAccountKey = findAccountKeyInsensitive(newState.accounts, counterpartyId);
  let accountMachine = existingAccountKey ? newState.accounts.get(existingAccountKey) : undefined;
  assertSameJurisdictionAccount(env, newState.entityId, newState.config?.jurisdiction, counterpartyId);
  if (accountMachine) {
    markStorageAccountDirty(env, newState.entityId, counterpartyId);
  }
  const inputWatchSeed = input.watchSeed === undefined
    ? undefined
    : normalizeAccountWatchSeed(input.watchSeed, 'ACCOUNT_INPUT');
  if (accountMachine && inputWatchSeed && accountMachine.watchSeed.toLowerCase() !== inputWatchSeed) {
    throw new Error(`ACCOUNT_WATCH_SEED_MISMATCH:${counterpartyId}`);
  }
  if (!accountMachine) {
    if (incomingAck && !incomingProposal) {
      const error = `ACCOUNT_INPUT_ACK_FOR_UNKNOWN_ACCOUNT: from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)}`;
      throw new Error(error);
    }
    const incomingFrameHeight = Number(accountInputReferenceHeight(input) ?? 0);
    if (incomingFrameHeight > 1) {
      const error =
        `ACCOUNT_SYNC_REQUIRED: entity=${shortId(newState.entityId)} ` +
        `counterparty=${shortId(counterpartyId)} inputHeight=${incomingFrameHeight}`;
      addMessage(newState, error);
      throw new Error(error);
    }
    const watchSeed = normalizeAccountWatchSeed(inputWatchSeed, 'ACCOUNT_INPUT_GENESIS');
    accountHandlerLog.debug('machine.create', { counterparty: shortId(counterpartyId) });

    // CONSENSUS FIX: Start with empty deltas (Channel.ts pattern)
    const initialDeltas = new Map();

    // CANONICAL: Sort entities (left < right) for AccountMachine internals (like Channel.ts)
    const leftEntity = isLeftEntity(state.entityId, counterpartyId) ? state.entityId : counterpartyId;
    const rightEntity = isLeftEntity(state.entityId, counterpartyId) ? counterpartyId : state.entityId;

    accountMachine = {
      leftEntity,
      rightEntity,
      watchSeed,
      status: 'active',
      mempool: [],
      currentFrame: {
        height: 0,
        // Deterministic account genesis: fixed zero timestamp.
        // First committed account frame carries consensus timestamp.
        timestamp: 0,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: '',
        accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
        deltas: [],
        stateHash: '',
        byLeft: state.entityId === leftEntity, // Am I left entity?
      },
      deltas: initialDeltas,
      globalCreditLimits: {
        ownLimit: 0n, // Credit starts at 0 - must be explicitly extended
        peerLimit: 0n, // Credit starts at 0 - must be explicitly extended
      },
      currentHeight: 0,
      pendingSignatures: [],
      rollbackCount: 0,
      proofHeader: {
        fromEntity: state.entityId,
        toEntity: counterpartyId,
        nextProofNonce: 1,
      },
      proofBody: {
        tokenIds: [],
        deltas: [],
      },
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(), // request_collateral target amounts (prepaid by requester)
      requestedRebalanceFeeState: new Map(), // Bilateral prepaid fee metadata
      shadow: {
        rebalance: {
          policy: new Map(),
          submittedAtByToken: new Map(),
        },
      },
      locks: new Map(), // HTLC: Empty locks map
      swapOffers: new Map(), // Swap: Empty offers map
      pulls: new Map(), // Pull: Empty ratio-gated pull map
      swapOrderHistory: new Map(),
      swapClosedOrders: new Map(),
      // Bilateral J-event consensus
      leftJObservations: [],
      rightJObservations: [],
      jEventChain: [],
      lastFinalizedJHeight: 0,
      // Dispute resolution values are encoded in 10-block units.
      // 576 * 10 = 5760 blocks, roughly 24h at 15-second block time.
      disputeConfig: {
        leftDisputeDelay: 576,
        rightDisputeDelay: 576,
      },
      jNonce: 0,
    };
    const jurisdiction = state.config?.jurisdiction;
    if (!jurisdiction) {
      throw new Error(`ACCOUNT_STATE_DOMAIN_MISSING: entity=${shortId(state.entityId)}`);
    }
    accountMachine.currentFrame.accountStateRoot = computeAccountStateRoot(
      accountMachine,
      accountStateDomainFromJurisdiction(jurisdiction),
    );
    accountMachine.currentFrame.stateHash = accountMachine.currentFrame.accountStateRoot;

    // Store with counterparty ID as key (simpler than canonical)
    // Type assertion safe: accountMachine was just created above in this block
    upsertSortedStringMapEntry(newState.accounts, counterpartyId, accountMachine as AccountMachine);
    markStorageAccountDirty(env, newState.entityId, counterpartyId);
    accountHandlerLog.debug('machine.created', { counterparty: shortId(counterpartyId) });
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // Dispute freeze: this mirrors account-tx/apply.ts through
  // canProcessAccountTxForDisputeStatus. During dispute_preparing we still allow
  // evidence-only frames (pull_resolve/swap_resolve) to settle argument data.
  // After disputeStart is queued/observed, only control traffic is allowed; the
  // signed calldata hashes are already committed and must not drift.
  if ((accountMachine.status ?? 'active') !== 'active') {
    const frameTxTypes = incomingProposal?.frame.accountTxs.map((tx) => tx.type) || [];
    const allowedWhileDisputed = frameTxTypes.every((txType) =>
      canProcessAccountTxForDisputeStatus(accountMachine.status, txType)
    );
    if (!allowedWhileDisputed) {
      const dropMsg =
        `🛑 Frozen account input dropped for ${counterpartyId.slice(-4)} ` +
        `(height=${accountInputReferenceHeight(input) ?? 'n/a'}, txs=[${frameTxTypes.join(',')}], ack=${!!incomingAck})`;
      accountHandlerLog.error('input.dropped_frozen_account', {
        counterparty: shortId(counterpartyId),
        height: accountInputReferenceHeight(input) ?? null,
        txs: frameTxTypes,
        ack: Boolean(incomingAck),
      });
      addMessage(newState, dropMsg);
      return {
        newState,
        outputs,
        mempoolOps,
        swapOffersCreated: allSwapOffersCreated,
        swapCancelRequests: allSwapCancelRequests,
        swapOffersCancelled: allSwapOffersCancelled,
        ...(allHashesToSign.length > 0 && { hashesToSign: allHashesToSign }),
      };
    }
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
    } else {
      accountHandlerLog.warn('settle_action.failed', {
        from: shortId(input.fromEntityId),
        message: result.message,
      });
      addMessage(newState, `⚠️ Settlement: ${result.message}`);
    }
  }

  // CHANNEL.TS PATTERN: Apply frame-level consensus only.
  if (incomingAck || incomingProposal || input.kind === 'dispute') {
    const pendingBeforeTxs = accountMachine.pendingFrame?.accountTxs?.map(tx => tx.type) || [];
    const inputFrameTxs = incomingProposal?.frame.accountTxs.map(tx => tx.type) || [];
    accountHandlerLog.debug('frame.process', {
      from: shortId(input.fromEntityId),
      pending: accountMachine.pendingFrame ? accountMachine.pendingFrame.height : null,
    });

    const result = await applyConsensusAccountInput(env, accountMachine, input);
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
      addMessages(newState, result.events);
      emitScopedEvents(
        env,
        'account',
        `E/A/${newState.entityId.slice(-4)}:${counterpartyId.slice(-4)}/consensus`,
        result.events,
        {
          entityId: newState.entityId,
          counterpartyId,
          frameHeight: accountInputReferenceHeight(input),
          hasNewFrame: Boolean(incomingProposal),
        },
        newState.entityId,
      );

      // Hub rebalance must remain global (all accounts matched together), but we
      // still want it to react quickly after any committed account frame.
      // Schedule a one-shot global rebalance kick for the next crontab wake-up.
      if (newState.hubRebalanceConfig && newState.crontabState) {
        scheduleCrontabHook(newState.crontabState, {
          id: 'hub-rebalance-kick',
          triggerAt: newState.timestamp,
          type: 'hub_rebalance_kick',
          data: {
            reason: 'account_frame_committed',
            counterpartyId,
          },
        });
        markStorageEntityDirty(env, newState.entityId);
      }

      // Multi-signer: Collect hashes from result during processing
      if (result.hashesToSign) {
        allHashesToSign.push(...result.hashesToSign);
      }

      // === COMMITTED FRAME PROCESSING: Check if account-level commits need entity side effects ===
      // Account consensus returns the committed frames explicitly. This avoids
      // guessing from input shape, especially for batched ACK + new-frame flows.
      const buildCommittedSwapOfferEvent = (offerId: string): SwapOfferEvent | null => {
        const offer = accountMachine.swapOffers?.get(offerId);
        if (!offer) return null;
        return {
          offerId,
          accountId: counterpartyId,
          makerIsLeft: offer.makerIsLeft,
          fromEntity: accountMachine.leftEntity,
          toEntity: accountMachine.rightEntity,
          createdHeight: offer.createdHeight,
          giveTokenId: offer.giveTokenId,
          giveAmount: offer.giveAmount,
          wantTokenId: offer.wantTokenId,
          wantAmount: offer.wantAmount,
          ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
          ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
          minFillRatio: offer.minFillRatio,
          ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
        };
      };
      const committedFrameEntries = result.committedFrames ?? [];

      for (const { frame: committedFrame, committedViaNewFrame } of committedFrameEntries) {
        if (!committedFrame?.accountTxs) continue;
        applyCommittedAccountFrameFollowups(newState, counterpartyId, committedFrame, mempoolOps, env);

        for (const accountTx of committedFrame.accountTxs) {
          const crossJurisdictionFollowupHandled = applyCommittedCrossJurisdictionAccountTxFollowup(
            env,
            newState,
            counterpartyId,
            accountTx,
            outputs,
          );
          if (!crossJurisdictionFollowupHandled) {
            await applyCommittedHtlcLockFollowup(
              { env, state, newState, input, accountMachine, outputs, mempoolOps },
              accountTx,
              committedViaNewFrame,
            );
          }

          if (accountTx.type === 'swap_offer') {
            const committedOfferEvent = buildCommittedSwapOfferEvent(accountTx.data.offerId);
            if (committedOfferEvent) allSwapOffersCreated.push(committedOfferEvent);
          } else if (accountTx.type === 'swap_resolve' || accountTx.type === 'cross_swap_fill_ack') {
            const committedOfferEvent = buildCommittedSwapOfferEvent(accountTx.data.offerId);
            if (committedOfferEvent) {
              allSwapOffersCreated.push(committedOfferEvent);
            } else {
              allSwapOffersCancelled.push({ offerId: accountTx.data.offerId, accountId: counterpartyId });
            }
          } else if (accountTx.type === 'swap_cancel_request') {
            allSwapCancelRequests.push({ offerId: accountTx.data.offerId, accountId: counterpartyId });
          }
        }
      }
      applyPendingForwardFollowup({ env, state, newState, input, accountMachine, outputs, mempoolOps });
      applyHtlcTimeoutFollowups({ env, state, newState, input, accountMachine, outputs, mempoolOps }, result.timedOutHashlocks || []);
      applyHtlcSecretFollowups({ env, state, newState, input, accountMachine, outputs, mempoolOps }, result.revealedSecrets || []);

      if (allSwapOffersCreated.length > 0) {
        accountHandlerLog.debug('swap.offers_committed', { count: allSwapOffersCreated.length });
      }
      if (allSwapCancelRequests.length > 0) {
        accountHandlerLog.debug('swap.cancel_requests_committed', { count: allSwapCancelRequests.length });
      }
      if (allSwapOffersCancelled.length > 0) {
        accountHandlerLog.debug('swap.offers_cancelled_committed', { count: allSwapOffersCancelled.length });
      }

      // Send response (ACK + optional new frame)
      if (result.response) {
        accountHandlerLog.debug('response.send', { to: shortId(result.response.toEntityId), height: accountInputReferenceHeight(result.response) });

        // Get target proposer
        // IMPORTANT: Send only to PROPOSER - bilateral consensus between entity proposers
        // Multi-validator entities sync account state via entity-level consensus (not bilateral broadcast)
        outputs.push({
          entityId: result.response.toEntityId,
          signerId: resolveEntityProposerId(
            env,
            result.response.toEntityId,
            `account response output ${newState.entityId}->${result.response.toEntityId}`,
          ),
          entityTxs: [{
            type: 'accountInput',
            data: result.response
          }]
        });

        accountHandlerLog.debug('response.queued', {
          from: shortId(state.entityId),
          to: shortId(result.response.toEntityId),
          height: accountInputReferenceHeight(result.response),
          prevHanko: Boolean(accountInputAck(result.response)),
        });
      }
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

  return {
    newState,
    outputs,
    mempoolOps,
    swapOffersCreated: allSwapOffersCreated,
    swapCancelRequests: allSwapCancelRequests,
    swapOffersCancelled: allSwapOffersCancelled,
    ...(allHashesToSign.length > 0 && { hashesToSign: allHashesToSign }),
  };
}
