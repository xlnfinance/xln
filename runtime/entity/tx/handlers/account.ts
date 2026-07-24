import type {
  AccountInput,
  EntityState,
  Env,
  EntityInput,
  AccountMachine,
  EntityCandidateEffect,
} from '../../../types';
import { applyAccountInput as applyConsensusAccountInput } from '../../../account/consensus/index';
import { addMessage, addMessages, emitScopedEvents } from '../../../state-helpers';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
  normalizeAccountStateDomain,
  sameAccountStateDomain,
} from '../../../account/state-root';
import { isLeftEntity } from '../../id';
import { scheduleHook as scheduleCrontabHook } from '../../scheduler';
import { upsertSortedStringMapEntry } from '../../../storage/sorted-index';
import { normalizeAccountWatchSeed } from '../../../account/watch-seed';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from './account-cross-j-followups';
import { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';
import {
  applyCommittedHtlcLockFollowup,
  applyHtlcSecretFollowups,
  applyHtlcTimeoutFollowups,
  applyPendingForwardFollowup,
} from './account/committed-htlc-followups';
import {
  processCommittedSettlementTransitionFollowup,
  processSettleAction,
} from './settle';
import type { MempoolOp } from './account/orderbook-queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';
import { accountInputAck, accountInputProposal, accountInputReferenceHeight } from '../../../account/consensus/flush';
import { handlePrepareDispute } from './dispute';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/board-registry';
import { assertEntityAccountInsertionCapacity } from '../../account-capacity';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claim-accumulator';
import type { AccountJClaimNodeChanges } from '../../../types/account-j-claims';
import { pruneUnreachableDisputeEvidence } from '../../../protocol/dispute/evidence-retention';
import type { ApplyEntityTxOptions } from '../apply';
import { armHtlcSecretAckTimeout, persistVerifiedHtlcSecret } from '../htlc-route-lifecycle';
import { buildHubRebalancePolicyTx } from './account-admin';
import { cumulativeMarksToPhases } from '../../../infra/perf-profile';
import { getPerfMs } from '../../../utils';

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

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
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

export const frozenAccountInputLogLevel = (
  account: Pick<AccountMachine, 'status' | 'activeDispute'>,
  input: Pick<AccountInput, 'kind'>,
): 'info' | 'warn' | 'error' => {
  // A signed ACK may legitimately be retried by the reliable transport after
  // local dispute preparation or J submission. It is security-relevant and
  // must remain visible, but it is an expected no-op rather than a Runtime
  // fault. The frozen gate below still rejects it before any Account mutation.
  if (input.kind === 'ack') return 'warn';
  const durableOnchainFreeze =
    account.status === 'disputed' &&
    (account.activeDispute?.observedOnChain === true || account.activeDispute === undefined);
  return durableOnchainFreeze && input.kind === 'frame_ack' ? 'info' : 'error';
};

export const canProcessFrozenAccountInput = (
  status: AccountMachine['status'],
  hasActiveDispute: boolean,
  _hasAck: boolean,
  frameTxTypes: readonly string[],
): boolean => {
  if ((status ?? 'active') === 'active') return true;
  // Finalization removes activeDispute but deliberately leaves the Account
  // closed. The only bilateral frame allowed through that terminal fence is
  // the explicit reopen transition (and its exact ACK). Before finalization,
  // activeDispute remains present from local draft through the on-chain event,
  // so even a forged/retried reopen frame cannot bypass the freeze.
  if (
    status === 'disputed' &&
    !hasActiveDispute &&
    frameTxTypes.length === 1 &&
    frameTxTypes[0] === 'reopen_disputed'
  ) return true;
  // No external AccountInput may extend a lane after dispute preparation has
  // begun. This includes ACK-only inputs and apparent control proposals: the
  // jurisdiction path is anchored to the last mutually signed ProofBody.
  return false;
};

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
  /** Exact consensus response that the final Entity flush must preserve. */
  requiredAccountResponse?: AccountInput;
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute' | 'settlement'; context: string }>;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
  candidateEffects: EntityCandidateEffect[];
}

export async function applyAccountInput(
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
  const candidateEffects: EntityCandidateEffect[] = [];
  // Multi-signer: Collect hashes during processing (not scanning)
  const allHashesToSign: Array<{
    hash: string;
    type: 'accountFrame' | 'dispute' | 'settlement';
    context: string;
  }> = [];
  let accountJClaimNodeChanges: AccountJClaimNodeChanges | undefined;

  // Get or create account machine (KEY: counterparty ID for simpler lookups)
  // AccountMachine still uses canonical left/right internally
  const counterpartyId = normalizeEntityRef(input.fromEntityId);
  let requiredAccountResponse: AccountInput | undefined;
  const existingAccountKey = findAccountKeyInsensitive(newState.accounts, counterpartyId);
  let accountMachine = existingAccountKey ? newState.accounts.get(existingAccountKey) : undefined;
  const createdAccount = !accountMachine;
  if (!accountMachine) {
    assertEntityAccountInsertionCapacity(
      newState.accounts,
      counterpartyId,
      `accountInput:${newState.entityId}`,
    );
  }
  if (input.domain === undefined) throw new Error(`ACCOUNT_INPUT_DOMAIN_REQUIRED:${counterpartyId}`);
  const inputDomain = normalizeAccountStateDomain(input.domain, 'ACCOUNT_INPUT_DOMAIN');
  if (accountMachine) {
    if (!sameAccountStateDomain(inputDomain, accountMachine.domain)) {
      throw new Error(`ACCOUNT_DOMAIN_CHANGED:${counterpartyId}`);
    }
  } else {
    const jurisdiction = state.config?.jurisdiction;
    if (!jurisdiction) throw new Error(`ACCOUNT_STATE_DOMAIN_MISSING: entity=${shortId(state.entityId)}`);
    if (!sameAccountStateDomain(inputDomain, accountStateDomainFromJurisdiction(jurisdiction))) {
      throw new Error(`ACCOUNT_INPUT_DOMAIN_MISMATCH:${counterpartyId}`);
    }
  }
  const inputWatchSeed = input.watchSeed === undefined
    ? undefined
    : normalizeAccountWatchSeed(input.watchSeed, 'ACCOUNT_INPUT');
  if (accountMachine && inputWatchSeed && accountMachine.watchSeed.toLowerCase() !== inputWatchSeed) {
    throw new Error(`ACCOUNT_WATCH_SEED_MISMATCH:${counterpartyId}`);
  }
  if (!accountMachine) {
    if ((incomingAck && !incomingProposal) || input.kind === 'board_reseal') {
      const code = input.kind === 'board_reseal'
        ? 'ACCOUNT_BOARD_RESEAL_UNKNOWN_ACCOUNT'
        : 'ACCOUNT_INPUT_ACK_FOR_UNKNOWN_ACCOUNT';
      const error = `${code}: from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)}`;
      throw new Error(error);
    }
    const incomingFrameHeight = Number(accountInputReferenceHeight(input) ?? 0);
    if (!incomingProposal || incomingFrameHeight !== 1) {
      const code = incomingFrameHeight > 1 ? 'ACCOUNT_SYNC_REQUIRED' : 'ACCOUNT_GENESIS_FRAME_REQUIRED';
      const error =
        `${code}: entity=${shortId(newState.entityId)} ` +
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
      domain: inputDomain,
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
      // Bilateral J-event consensus: roots only; bodies live in Account frames.
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      // Dispute resolution values are encoded in 10-block units.
      // 576 * 10 = 5760 blocks, roughly 24h at 15-second block time.
      disputeConfig: {
        leftDisputeDelay: 576,
        rightDisputeDelay: 576,
      },
      jNonce: 0,
    };
    accountMachine.currentFrame.accountStateRoot = computeAccountStateRoot(accountMachine);
    accountMachine.currentFrame.stateHash = accountMachine.currentFrame.accountStateRoot;
    accountHandlerLog.debug('machine.candidate_created', { counterparty: shortId(counterpartyId) });
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }
  checkpointProfile('accountResolve');

  // Dispute freeze happens at AccountInput ingress. Optional transformer
  // evidence lives in Entity state; accepting even an ACK-only input here would
  // let a late optimistic frame replace the exact signed proof selected for J.
  if ((accountMachine.status ?? 'active') !== 'active') {
    const proposalTxTypes = incomingProposal?.frame.accountTxs.map((tx) => tx.type) || [];
    const pendingAckTxTypes = incomingAck
      ? accountMachine.pendingFrame?.accountTxs.map((tx) => tx.type) ?? []
      : [];
    const frameTxTypes = proposalTxTypes.length > 0 ? proposalTxTypes : pendingAckTxTypes;
    const allowedWhileDisputed = canProcessFrozenAccountInput(
      accountMachine.status,
      Boolean(accountMachine.activeDispute),
      Boolean(incomingAck),
      frameTxTypes,
    );
    if (!allowedWhileDisputed) {
      const dropMsg =
        `🛑 Frozen account input dropped for ${counterpartyId.slice(-4)} ` +
        `(height=${accountInputReferenceHeight(input) ?? 'n/a'}, txs=[${frameTxTypes.join(',')}], ack=${!!incomingAck})`;
      const severity = frozenAccountInputLogLevel(accountMachine, input);
      const logFrozenInput = severity === 'info'
        ? accountHandlerLog.info
        : severity === 'warn'
          ? accountHandlerLog.warn
          : accountHandlerLog.error;
      logFrozenInput('input.dropped_frozen_account', {
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
        candidateEffects,
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
    const result = await applyConsensusAccountInput(env, accountMachine, input, {
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
      candidateEffects.push(...(result.candidateEffects ?? []));
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
          ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
        };
      };
      const committedFrameEntries = result.committedFrames ?? [];
      for (const { frame, committedViaNewFrame } of committedFrameEntries) {
        candidateEffects.push({
          kind: 'accountFrameHistory',
          entityId: accountMachine.proofHeader.fromEntity,
          counterpartyId: input.fromEntityId,
          accountHeight: frame.height,
          source: committedViaNewFrame ? 'peerCommit' : 'ackCommit',
          frame: structuredClone(frame),
        });
      }
      const committedInboundGenesis = committedFrameEntries.some(({ frame }) => frame.height === 1);
      if (createdAccount) {
        if (!committedInboundGenesis) {
          throw new Error(`ACCOUNT_GENESIS_COMMIT_REQUIRED:${counterpartyId}`);
        }
        upsertSortedStringMapEntry(newState.accounts, counterpartyId, accountMachine);
        accountHandlerLog.debug('machine.created', { counterparty: shortId(counterpartyId) });
      }

      for (const { frame: committedFrame, committedViaNewFrame } of committedFrameEntries) {
        if (!committedFrame?.accountTxs) continue;
        applyCommittedAccountFrameFollowups(
          newState,
          counterpartyId,
          committedFrame,
          mempoolOps,
          env,
          candidateEffects,
        );

        for (const accountTx of committedFrame.accountTxs) {
          const settlementFollowup = await processCommittedSettlementTransitionFollowup(
            accountMachine,
            accountTx,
            committedFrame,
            counterpartyId,
            newState,
            env,
          );
          outputs.push(...settlementFollowup.outputs);
          mempoolOps.push(...settlementFollowup.mempoolOps);
          allHashesToSign.push(...settlementFollowup.hashesToSign);
          const crossJurisdictionFollowupHandled = applyCommittedCrossJurisdictionAccountTxFollowup(
            env,
            newState,
            counterpartyId,
            accountTx,
            outputs,
            committedFrame.timestamp,
            allSwapOffersCreated,
            options?.storageChanges,
          );
          if (!crossJurisdictionFollowupHandled) {
            await applyCommittedHtlcLockFollowup(
              { env, state, newState, input, accountMachine, outputs, mempoolOps, candidateEffects },
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
      if (createdAccount && committedInboundGenesis && newState.hubRebalanceConfig) {
        const localSide = newState.entityId.toLowerCase() === accountMachine.leftEntity.toLowerCase()
          ? 'left'
          : 'right';
        for (const tokenId of Array.from(accountMachine.deltas.keys()).sort((left, right) => left - right)) {
          const currentPolicy = accountMachine.rebalanceFeePolicies?.get(tokenId)?.[localSide];
          if (currentPolicy?.policyVersion === newState.hubRebalanceConfig.policyVersion) continue;
          mempoolOps.push({
            accountId: counterpartyId,
            tx: buildHubRebalancePolicyTx(newState.hubRebalanceConfig, tokenId),
          });
        }
      }
      const htlcFollowupContext = {
        env,
        state,
        newState,
        input,
        accountMachine,
        outputs,
        mempoolOps,
        candidateEffects,
      };
      applyPendingForwardFollowup(htlcFollowupContext);
      applyHtlcTimeoutFollowups(htlcFollowupContext, result.timedOutHashlocks || []);
      applyHtlcSecretFollowups(htlcFollowupContext, result.revealedSecrets || []);
      if (committedFrameEntries.length > 0) {
        pruneUnreachableDisputeEvidence(accountMachine, newState.jBatchState);
      }
      checkpointProfile('committedFollowups');

      if (allSwapOffersCreated.length > 0) {
        accountHandlerLog.debug('swap.offers_committed', { count: allSwapOffersCreated.length });
      }
      if (allSwapCancelRequests.length > 0) {
        accountHandlerLog.debug('swap.cancel_requests_committed', { count: allSwapCancelRequests.length });
      }
      if (allSwapOffersCancelled.length > 0) {
        accountHandlerLog.debug('swap.offers_cancelled_committed', { count: allSwapOffersCancelled.length });
      }

      // Account responses are not outputs yet. Entity consensus performs one
      // final Account flush after every AccountInput, matching pass, and hook
      // has run, so an ACK can be combined with all same-frame Account work.
      if (result.response) {
        requiredAccountResponse = structuredClone(result.response);
        accountHandlerLog.debug('response.deferred_to_entity_flush', {
          from: shortId(state.entityId),
          to: shortId(result.response.toEntityId),
          height: accountInputReferenceHeight(result.response),
          prevHanko: Boolean(accountInputAck(result.response)),
        });
        checkpointProfile('responseDeferred');
      }
      checkpointProfile('postConsensus');
    } else if (result.disputeRequired) {
      if (createdAccount) {
        addMessage(newState, `⚠️ Rejected uncommitted account genesis from ${counterpartyId.slice(-8)}`);
        return {
          newState,
          outputs,
          mempoolOps,
          swapOffersCreated: allSwapOffersCreated,
          swapCancelRequests: allSwapCancelRequests,
          swapOffersCancelled: allSwapOffersCancelled,
          candidateEffects,
          ...(allHashesToSign.length > 0 && { hashesToSign: allHashesToSign }),
          ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
        };
      }
      if (result.disputeRequired.signedFrame) {
        accountMachine.shadow.rejectedFrameEvidence = {
          reason: result.disputeRequired.reason,
          frame: structuredClone(result.disputeRequired.signedFrame.frame),
          frameHanko: result.disputeRequired.signedFrame.frameHanko,
        };
      }
      for (const { hashlock, secret } of result.disputeRequired.evidenceSecrets) {
        const lock = [...accountMachine.locks.values()].find(
          candidate => candidate.hashlock.toLowerCase() === hashlock.toLowerCase(),
        );
        if (!lock) {
          throw new Error(`HTLC_DISPUTE_EVIDENCE_LOCK_MISSING:${hashlock}`);
        }
        persistVerifiedHtlcSecret(newState, counterpartyId, lock, secret);
        const route = newState.htlcRoutes.get(hashlock)!;
        const localIsLeft = accountMachine.leftEntity.toLowerCase() === newState.entityId.toLowerCase();
        const localSentLock = lock.senderIsLeft === localIsLeft;
        if (localSentLock && route.inboundEntity && route.inboundLockId) {
          mempoolOps.push({
            accountId: route.inboundEntity,
            tx: {
              type: 'htlc_resolve',
              data: { lockId: route.inboundLockId, outcome: 'secret', secret },
            },
          });
          armHtlcSecretAckTimeout(newState, route);
        }
      }
      const startsBefore = newState.jBatchState?.batch.disputeStarts.length ?? 0;
      const prepared = await handlePrepareDispute(
        newState,
        {
          type: 'prepareDispute',
          data: {
            counterpartyEntityId: counterpartyId,
            description: 'late-htlc-secret-enforcement',
          },
        },
        env,
      );
      const startsAfter = prepared.newState.jBatchState?.batch.disputeStarts.length ?? 0;
      const disputeStarted = startsAfter > startsBefore;
      if (disputeStarted && prepared.newState.jBatchState) {
        prepared.newState.jBatchState.autoBroadcastDraft = true;
      }
      const disputeOutputs = disputeStarted && !prepared.newState.jBatchState?.sentBatch
        ? [{
            entityId: prepared.newState.entityId,
            signerId: prepared.newState.config.validators[0]!,
            entityTxs: [{ type: 'j_broadcast' as const, data: {} }],
          }]
        : [];
      addMessage(
        prepared.newState,
        disputeStarted
          ? `⚠️ Unsafe account frame rejected; dispute start queued`
          : `⚠️ Unsafe account frame rejected; dispute preparation awaits Hanko`,
      );
      return {
        newState: prepared.newState,
        outputs: [...outputs, ...prepared.outputs, ...disputeOutputs],
        mempoolOps,
        swapOffersCreated: allSwapOffersCreated,
        swapCancelRequests: allSwapCancelRequests,
        swapOffersCancelled: allSwapOffersCancelled,
        candidateEffects,
        ...(allHashesToSign.length > 0 && { hashesToSign: allHashesToSign }),
        ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
      };
    } else if (result.rejected) {
      accountHandlerLog.warn('frame.rejected', {
        from: shortId(input.fromEntityId),
        error: result.rejected.reason,
      });
      addMessage(newState, `⚠️ Rejected account frame: ${result.rejected.reason}`);
      return {
        newState,
        outputs,
        mempoolOps,
        swapOffersCreated: allSwapOffersCreated,
        swapCancelRequests: allSwapCancelRequests,
        swapOffersCancelled: allSwapOffersCancelled,
        candidateEffects,
        ...(allHashesToSign.length > 0 && { hashesToSign: allHashesToSign }),
        ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
      };
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
  return {
    newState,
    outputs,
    mempoolOps,
    swapOffersCreated: allSwapOffersCreated,
    swapCancelRequests: allSwapCancelRequests,
    swapOffersCancelled: allSwapOffersCancelled,
    candidateEffects,
    ...(requiredAccountResponse ? { requiredAccountResponse } : {}),
    ...(allHashesToSign.length > 0 && { hashesToSign: allHashesToSign }),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
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
