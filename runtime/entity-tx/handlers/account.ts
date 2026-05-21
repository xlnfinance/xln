import type { AccountInput, EntityState, Env, EntityInput, HtlcRoute, AccountMachine, HtlcNoteKey } from '../../types';
import { markStorageAccountDirty, markStorageEntityDirty } from '../../env-events';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { addMessage, addMessages, emitScopedEvents } from '../../state-helpers';
import {
  applyCommand,
  createBook,
  canonicalPair,
  deriveSide,
  getBookOrder,
  getBestAsk,
  getBestBid,
  refreshRestingOrder,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../orderbook';
import { HTLC, LIMITS, SWAP as SWAP_CONSTANTS } from '../../constants';
import { getSwapPairPolicyByBaseQuote, hasSwapPairPolicyByBaseQuote, type SwapPairPolicy } from '../../account-utils';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortId, shortOrder, shouldLogFullPayloads } from '../../logger';
import { isLeftEntity } from '../../entity-id-utils';
import {
  buildSwapResolveDataFromOrderbookFill,
  calculateSwapTakerFeeAmount,
  compareCanonicalText,
  MAX_SWAP_FILL_RATIO,
  type NormalizedOrderbookOffer,
  swapKey,
} from '../../swap-execution';
import { sanitizeBaseFee } from '../../routing/fees';
import {
  scheduleHook as scheduleCrontabHook,
  HTLC_SECRET_ACK_TIMEOUT_MS,
} from '../../entity-crontab';
import { NobleCryptoProvider } from '../../crypto-noble';
import { unwrapEnvelope, validateEnvelope } from '../../htlc-envelope-types';
import { terminateHtlcRoute } from '../htlc-route-lifecycle';
import { upsertSortedStringMapEntry } from '../../sorted-index';
import {
  buildHtlcFinalizedEventPayload,
  buildHtlcReceivedEventPayload,
} from '../../htlc-events';
import {
  buildCrossJurisdictionFillAck,
  buildCrossJurisdictionMarketOffer,
  type CrossJurisdictionFillInstruction,
  type CrossMarketOffer,
} from '../../cross-jurisdiction-orderbook';
import { assertSameJurisdictionAccount } from '../../jurisdiction-runtime';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from './account-cross-j-followups';
import { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';
import {
  findQueuedCrossSwapAckForEntityState,
  hasQueuedCrossSwapAckForEntityState,
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
  type SwapResolveEnqueueData,
} from './account/orderbook-queue';
import {
  normalizeSwapOfferForOrderbook,
  resolveStoredOfferEntityRefs,
  sortSwapOffersForOrderbook,
  type MatchResult,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
  type SwapOfferEvent,
} from './account/orderbook-offers';

export type { MempoolOp } from './account/orderbook-queue';
export {
  collectOpenSwapOffersForOrderbook,
  compareSwapOffersForOrderbook,
  normalizeSwapOfferForOrderbook,
  sortSwapOffersForOrderbook,
} from './account/orderbook-offers';
export { processOrderbookCancels } from './account/orderbook-cancels';
export type {
  MatchResult,
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const accountHandlerLog = createStructuredLogger('account.handler');
const orderbookLog = createStructuredLogger('orderbook');

const getJurisdictionId = (state: EntityState, env: Env): string => {
  return String(state.config?.jurisdiction?.name || env.activeJurisdiction || '').trim();
};

export { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';

const findAccountKeyInsensitive = (accounts: Map<string, AccountMachine>, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  for (const key of accounts.keys()) {
    if (normalizeEntityRef(key) === target) return key;
  }
  return null;
};

type OrderbookProcessOptions = {
  debugRebuildProjectionOnly?: boolean;
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

export async function handleAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<AccountHandlerResult> {
  accountHandlerLog.debug('input.apply', {
    from: shortId(input.fromEntityId),
    to: shortId(input.toEntityId),
    height: input.height,
    frame: Boolean(input.newAccountFrame),
    prevHanko: Boolean(input.prevHanko),
  });

  // CRITICAL: Don't clone here - state already cloned at entity level (applyEntityTx)
  const newState: EntityState = state;  // Use state directly
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
  markStorageAccountDirty(env, newState.entityId, counterpartyId);
  const existingAccountKey = findAccountKeyInsensitive(newState.accounts, counterpartyId);
  let accountMachine = existingAccountKey ? newState.accounts.get(existingAccountKey) : undefined;
  assertSameJurisdictionAccount(env, newState.entityId, newState.config?.jurisdiction, counterpartyId);
  let isNewAccount = false;
  if (!accountMachine) {
    isNewAccount = true;
    accountHandlerLog.debug('machine.create', { counterparty: shortId(counterpartyId) });

    // CONSENSUS FIX: Start with empty deltas (Channel.ts pattern)
    const initialDeltas = new Map();

    // CANONICAL: Sort entities (left < right) for AccountMachine internals (like Channel.ts)
    const leftEntity = isLeftEntity(state.entityId, counterpartyId) ? state.entityId : counterpartyId;
    const rightEntity = isLeftEntity(state.entityId, counterpartyId) ? counterpartyId : state.entityId;

    accountMachine = {
      leftEntity,
      rightEntity,
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
        nonce: 1,  // Next unified on-chain nonce to use
      },
      proofBody: {
        tokenIds: [],
        deltas: [],
      },
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(), // request_collateral target amounts (prepaid by requester)
      requestedRebalanceFeeState: new Map(), // Prepaid fee metadata + scheduling hints
      rebalancePolicy: new Map(), // Rebalance: per-token soft/hard/maxFee
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
      onChainSettlementNonce: 0,
    };

    // Store with counterparty ID as key (simpler than canonical)
    // Type assertion safe: accountMachine was just created above in this block
    upsertSortedStringMapEntry(newState.accounts, counterpartyId, accountMachine as AccountMachine);
    accountHandlerLog.debug('machine.created', { counterparty: shortId(counterpartyId) });
  }

  if (isNewAccount && input.prevHanko && !input.newAccountFrame) {
    const error = `ACCOUNT_INPUT_ACK_FOR_UNKNOWN_ACCOUNT: from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)}`;
    throw new Error(error);
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // Dispute freeze: once account is disputed, only allow the minimal bilateral traffic
  // that can resolve the dispute state itself. The account-tx layer already allows only
  // `j_event_claim` and `reopen_disputed`, so the transport/input gate must mirror that
  // rule instead of dropping reopen frames before consensus can apply them.
  if ((accountMachine.status ?? 'active') === 'disputed') {
    const frameTxTypes = input.newAccountFrame?.accountTxs?.map((tx) => tx.type) || [];
    const allowedWhileDisputed = frameTxTypes.every((txType) => txType === 'j_event_claim' || txType === 'reopen_disputed');
    if (!allowedWhileDisputed) {
      const dropMsg =
        `🛑 Disputed account input dropped for ${counterpartyId.slice(-4)} ` +
        `(height=${input.height ?? input.newAccountFrame?.height ?? 'n/a'}, txs=[${frameTxTypes.join(',')}], ack=${!!input.prevHanko})`;
      console.error(dropMsg);
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
  if (input.settleAction) {
    const { processSettleAction } = await import('./settle');
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
      console.warn(`⚠️ settleAction failed: ${result.message}`);
      addMessage(newState, `⚠️ Settlement: ${result.message}`);
    }
  }

  // CHANNEL.TS PATTERN: Process frame-level consensus ONLY
  if (input.height !== undefined || input.newAccountFrame) {
    accountHandlerLog.debug('frame.process', {
      from: shortId(input.fromEntityId),
      pending: accountMachine.pendingFrame ? accountMachine.pendingFrame.height : null,
    });

    const currentHeightBefore = accountMachine.currentHeight;
    const pendingFrameBefore = accountMachine.pendingFrame;
    const result = await processAccountInput(env, accountMachine, input);

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
          frameHeight: input.newAccountFrame?.height ?? input.height,
          hasNewFrame: Boolean(input.newAccountFrame),
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
      const committedFrameEntries =
        result.committedFrames && result.committedFrames.length > 0
          ? result.committedFrames
          : (() => {
              const justCommittedFrame =
                input.newAccountFrame && input.newAccountFrame.height > currentHeightBefore
                  ? input.newAccountFrame
                  : input.prevHanko && pendingFrameBefore && accountMachine.currentHeight > currentHeightBefore
                    ? pendingFrameBefore
                    : undefined;
              return justCommittedFrame
                ? [{ frame: justCommittedFrame, committedViaNewFrame: Boolean(input.newAccountFrame) }]
                : [];
            })();

      for (const { frame: committedFrame, committedViaNewFrame } of committedFrameEntries) {
        if (!committedFrame?.accountTxs) continue;
        if (HEAVY_LOGS) console.log(
          `🔍 HTLC-CHECK: commitMode=${committedViaNewFrame ? 'newFrame' : 'ack'}, inputHeight=${committedFrame.height}, currentHeight=${accountMachine.currentHeight}`,
        );
        if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: accountMachine.locks.size=${accountMachine.locks.size}`);
        if (HEAVY_LOGS) console.log(`🔍 FRAME-TXS: ${committedFrame.accountTxs.length} txs in frame:`, committedFrame.accountTxs.map(tx => tx.type));

        applyCommittedAccountFrameFollowups(newState, counterpartyId, committedFrame);

        for (const accountTx of committedFrame.accountTxs) {
          if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: Checking committed tx type=${accountTx.type}`);

          if (applyCommittedCrossJurisdictionAccountTxFollowup(env, newState, counterpartyId, accountTx, outputs)) {
            continue;
          }

          if (accountTx.type === 'htlc_resolve' || accountTx.type === 'j_event_claim' || accountTx.type === 'swap_resolve') {
            continue;
          }

          if (accountTx.type === 'htlc_lock') {
            // Only the receiver-side commit should decrypt/route an HTLC lock.
            // On proposer ACK, the committed frame is our own outbound lock, so
            // re-running receiver-side envelope handling will try to decrypt the
            // next hop's ciphertext with our key and fail spuriously.
            if (!committedViaNewFrame) {
              continue;
            }
            if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: Found htlc_lock in committed frame!`);
            const lock = accountMachine.locks.get(accountTx.data.lockId);
            if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: lock found? ${!!lock}`);
            if (!lock) {
              continue;
            }

            // Check envelope (onion routing)
            if (!lock.envelope) {
              continue;
            }

            let envelope = lock.envelope;

            // CRITICAL: For onion routing, envelope can be:
            // 1. A string (encrypted payload for THIS hop - decrypt it directly)
            // 2. An object with innerEnvelope (THIS hop's plaintext instructions with encrypted payload for NEXT hop)

            // Case 1: Envelope is a string (encrypted FOR us)
            if (typeof envelope === 'string') {
              try {
                let envelopeData: string = envelope;

                // Decrypt if encrypted (base64), or use cleartext (JSON starts with '{')
                const isCleartext1 = envelopeData.trimStart().startsWith('{');
                if (isCleartext1) {
                  env.error('network', 'MISSING_CRYPTO_KEY', {
                    lockId: lock.lockId,
                    reason: 'cleartext_direct_envelope',
                    fromEntityId: input.fromEntityId,
                    toEntityId: input.toEntityId,
                  }, state.entityId);
                  throw new Error(`MISSING_CRYPTO_KEY:${lock.lockId}`);
                }
                if (newState.entityEncPrivKey) {
                  const crypto = new NobleCryptoProvider();
                  envelopeData = await crypto.decrypt(envelope as string, newState.entityEncPrivKey);
                } else {
                  env.error('network', 'MISSING_CRYPTO_KEY', {
                    lockId: lock.lockId,
                    reason: 'missing_entity_encryption_key',
                    fromEntityId: input.fromEntityId,
                    toEntityId: input.toEntityId,
                  }, state.entityId);
                  throw new Error(`MISSING_CRYPTO_KEY:${lock.lockId}`);
                }

                // Unwrap decrypted envelope
                envelope = unwrapEnvelope(envelopeData);
              } catch (e) {
                console.log(`❌ HTLC-GATE: ENVELOPE_DECRYPT_FAIL - ${e instanceof Error ? e.message : String(e)} [lockId=${lock.lockId.slice(0,16)}]`);
                env.error('network', 'ENVELOPE_DECRYPT_FAIL', {
                  lockId: lock.lockId,
                  reason: e instanceof Error ? e.message : String(e),
                  fromEntityId: input.fromEntityId,
                  toEntityId: input.toEntityId,
                }, state.entityId);
                throw new Error(`ENVELOPE_DECRYPT_FAIL:${lock.lockId}`);
              }
            }
            // Case 2: Envelope has innerEnvelope (plaintext wrapper)
            else if (envelope.innerEnvelope && !envelope.finalRecipient) {
              try {
                let envelopeData = envelope.innerEnvelope;

                // Decrypt if encrypted (base64), or use cleartext (JSON starts with '{')
                const isCleartext2 = envelopeData.trimStart().startsWith('{');
                if (isCleartext2) {
                  env.error('network', 'MISSING_CRYPTO_KEY', {
                    lockId: lock.lockId,
                    reason: 'cleartext_inner_envelope',
                    fromEntityId: input.fromEntityId,
                    toEntityId: input.toEntityId,
                  }, state.entityId);
                  throw new Error(`MISSING_CRYPTO_KEY:${lock.lockId}`);
                }
                if (newState.entityEncPrivKey) {
                  const crypto = new NobleCryptoProvider();
                  envelopeData = await crypto.decrypt(envelope.innerEnvelope, newState.entityEncPrivKey);
                } else {
                  env.error('network', 'MISSING_CRYPTO_KEY', {
                    lockId: lock.lockId,
                    reason: 'missing_entity_encryption_key',
                    fromEntityId: input.fromEntityId,
                    toEntityId: input.toEntityId,
                  }, state.entityId);
                  throw new Error(`MISSING_CRYPTO_KEY:${lock.lockId}`);
                }

                // Unwrap decrypted envelope - THIS is our actual routing instruction
                envelope = unwrapEnvelope(envelopeData);
              } catch (e) {
                console.log(`❌ HTLC-GATE: ENVELOPE_DECRYPT_FAIL - ${e instanceof Error ? e.message : String(e)} [lockId=${lock.lockId.slice(0,16)}]`);
                env.error('network', 'ENVELOPE_DECRYPT_FAIL', {
                  lockId: lock.lockId,
                  reason: e instanceof Error ? e.message : String(e),
                  fromEntityId: input.fromEntityId,
                  toEntityId: input.toEntityId,
                }, state.entityId);
                throw new Error(`ENVELOPE_DECRYPT_FAIL:${lock.lockId}`);
              }
            }

            // Validate envelope structure (safety check)
            try {
              validateEnvelope(envelope);
            } catch (e) {
              console.log(`❌ HTLC: Invalid envelope structure: ${e instanceof Error ? e.message : String(e)}`);
              continue;
            }

            // CRITICAL: Verify envelope matches HTLC lock (prevent replay/manipulation)
            // This is "verify-after-decrypt" pattern - simpler than AAD
            // The envelope MUST match the lock that carries it
            if (lock.amount.toString() !== accountTx.data.amount.toString()) {
              console.log(`❌ HTLC: Envelope amount mismatch: lock=${lock.amount}, tx=${accountTx.data.amount}`);
              continue;
            }
            if (lock.tokenId !== accountTx.data.tokenId) {
              console.log(`❌ HTLC: Envelope tokenId mismatch: lock=${lock.tokenId}, tx=${accountTx.data.tokenId}`);
              continue;
            }
            if (lock.hashlock !== accountTx.data.hashlock) {
              console.log(`❌ HTLC: Envelope hashlock mismatch: lock=${lock.hashlock.slice(0,16)}..., tx=${accountTx.data.hashlock.slice(0,16)}...`);
              env.error('consensus', 'HTLC_ENVELOPE_HASHLOCK_MISMATCH', {
                lockId: lock.lockId,
                lockHashlock: lock.hashlock,
                txHashlock: accountTx.data.hashlock,
                fromEntityId: input.fromEntityId,
                toEntityId: input.toEntityId,
              }, state.entityId);
              continue;
            }

            // For intermediary hops, verify nextHop is a valid entity
            if (envelope.nextHop && !envelope.finalRecipient) {
              // Check if we have an account with nextHop (can forward)
              const hasNextHopAccount = newState.accounts.has(envelope.nextHop);
              if (!hasNextHopAccount) {
                console.log(`❌ HTLC: Cannot forward - no account with nextHop ${envelope.nextHop.slice(-4)}`);
                console.log(`❌ HTLC: Available accounts: [${Array.from(newState.accounts.keys()).map(k => k.slice(-4)).join(', ')}]`);
                continue;
              }
            }

            // Are we the final recipient?
            if (envelope.finalRecipient) {
              // Final recipient - reveal immediately
              if (envelope.secret) {
                const inboundEntity = newState.entityId === accountMachine.leftEntity
                  ? accountMachine.rightEntity
                  : accountMachine.leftEntity;
                const paymentDescription = typeof envelope.description === 'string' ? envelope.description.trim() : '';
                if (!newState.htlcRoutes.has(lock.hashlock)) {
                  newState.htlcRoutes.set(lock.hashlock, {
                    hashlock: lock.hashlock,
                    tokenId: lock.tokenId,
                    amount: lock.amount,
                    ...(typeof envelope.startedAtMs === 'number' ? { startedAtMs: envelope.startedAtMs } : {}),
                    inboundEntity,
                    inboundLockId: lock.lockId,
                    createdTimestamp: newState.timestamp,
                  });
                }
                env.emit('HtlcReceived', {
                  ...buildHtlcReceivedEventPayload({
                    entityId: state.entityId,
                    fromEntity: input.fromEntityId,
                    toEntity: state.entityId,
                    hashlock: lock.hashlock,
                    lockId: lock.lockId,
                    amount: lock.amount,
                    tokenId: lock.tokenId,
                    ...(paymentDescription ? { description: paymentDescription } : {}),
                    ...(typeof envelope.startedAtMs === 'number' ? { startedAtMs: envelope.startedAtMs } : {}),
                    ...(getJurisdictionId(state, env) ? { jurisdictionId: getJurisdictionId(state, env) } : {}),
                    receivedAtMs: newState.timestamp,
                  }),
                });
                if (paymentDescription) {
                  if (!(newState.htlcNotes instanceof Map)) newState.htlcNotes = new Map<HtlcNoteKey, string>();
                  newState.htlcNotes.set(`hashlock:${lock.hashlock}`, paymentDescription);
                  newState.htlcNotes.set(`lock:${lock.lockId}`, paymentDescription);
                }
                mempoolOps.push({
                  accountId: input.fromEntityId,
                  tx: {
                    type: 'htlc_resolve',
                    data: {
                      lockId: lock.lockId,
                      outcome: 'secret' as const,
                      secret: envelope.secret
                    }
                  }
                });
              } else {
                console.log(`❌ HTLC: Final recipient envelope missing secret!`);
              }
            } else if (envelope.nextHop) {
              // Intermediary - forward to next hop
              const nextHop = envelope.nextHop;

              // Register route for backward propagation
              const inboundEntity = newState.entityId === accountMachine.leftEntity
                ? accountMachine.rightEntity
                : accountMachine.leftEntity;

              // Create route object (typed as HtlcRoute for pendingFee)
              const htlcRoute: HtlcRoute = {
                hashlock: lock.hashlock,
                tokenId: lock.tokenId,
                amount: lock.amount,
                ...(typeof envelope.startedAtMs === 'number' ? { startedAtMs: envelope.startedAtMs } : {}),
                inboundEntity,
                inboundLockId: lock.lockId,
                outboundEntity: nextHop,
                outboundLockId: `${lock.lockId}-fwd`,
                createdTimestamp: newState.timestamp
              };
              newState.htlcRoutes.set(lock.hashlock, htlcRoute);

              const nextAccount = newState.accounts.get(nextHop);

              // Helper: cancel inbound lock and propagate error backward
              const cancelInboundLock = (cancelReason: string) => {
                mempoolOps.push({
                  accountId: input.fromEntityId,
                  tx: {
                    type: 'htlc_resolve',
                    data: { lockId: lock.lockId, outcome: 'error' as const, reason: cancelReason }
                  }
                });
                // Clean up route
                newState.htlcRoutes.delete(lock.hashlock);
              };

              if (nextAccount) {
                // Calculate forwarded amounts/timelocks with safety checks
                const localEntityId = String(newState.entityId || '').toLowerCase();
                const localProfile = env.gossip?.getProfiles?.()?.find((p: { entityId?: unknown; metadata?: { baseFee?: bigint } } | undefined) =>
                  String(p?.entityId || '').toLowerCase() === localEntityId
                );
                const baseFee = sanitizeBaseFee(localProfile?.metadata?.baseFee ?? 0n);

                let forwardAmount: bigint;
                let feeAmount: bigint;

                const envelopeForwardAmountRaw = (envelope as { forwardAmount?: unknown })?.forwardAmount;
                if (typeof envelopeForwardAmountRaw === 'string' && envelopeForwardAmountRaw.length > 0) {
                  try {
                    forwardAmount = BigInt(envelopeForwardAmountRaw);
                  } catch {
                    console.log(`❌ HTLC: Invalid envelope forwardAmount=${String(envelopeForwardAmountRaw)}`);
                    cancelInboundLock(`invalid_forward_amount`);
                    continue;
                  }
                  if (forwardAmount <= 0n || forwardAmount > lock.amount) {
                    console.log(`❌ HTLC: Envelope forwardAmount out of range inbound=${lock.amount} forward=${forwardAmount}`);
                    cancelInboundLock(`invalid_forward_amount`);
                    continue;
                  }
                  feeAmount = lock.amount - forwardAmount;
                } else {
                  // Exact-receive invariant: intermediary hops must use sender-quoted
                  // forwardAmount from onion envelope; never recompute locally.
                  console.log(`❌ HTLC: Missing envelope forwardAmount for intermediary hop`);
                  cancelInboundLock(`missing_forward_amount`);
                  continue;
                }

                if (feeAmount < baseFee) {
                  console.log(`❌ HTLC: Fee floor violation inbound=${lock.amount} forward=${forwardAmount} fee=${feeAmount} minBaseFee=${baseFee}`);
                  cancelInboundLock(`fee_below_base`);
                  continue;
                }

                // Store pending fee (only accrue on successful reveal, not on forward)
                htlcRoute.pendingFee = feeAmount;

                // Get inner envelope for next hop (already decrypted above)
                // The envelope variable now contains OUR decrypted instructions
                // envelope.innerEnvelope is the NEXT hop's encrypted payload
                const innerEnvelope = envelope.innerEnvelope;

                // Calculate forwarded timelock/height with safety checks
                const forwardTimelock = lock.timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS); // Per-hop timelock delta
                const forwardHeight = lock.revealBeforeHeight - 1;

                // Validate forwarded lock is still valid (with instrumentation)
                const currentJHeight = newState.lastFinalizedJHeight || 0;

                // Timelock validation: forward must have breathing room (1s safety margin for processing delays)
                const SAFETY_MARGIN_MS = 1000;
                if (forwardTimelock < BigInt(newState.timestamp) + BigInt(SAFETY_MARGIN_MS)) {
                  console.log(`❌ HTLC-GATE: TIMELOCK_TOO_TIGHT - forward=${forwardTimelock}, current+margin=${BigInt(newState.timestamp) + BigInt(SAFETY_MARGIN_MS)} [lockId=${lock.lockId.slice(0,16)}]`);
                  cancelInboundLock(`timelock_too_tight`);
                  continue;
                }

                if (forwardHeight <= currentJHeight) {
                  console.log(`❌ HTLC-GATE: HEIGHT_EXPIRED - forward=${forwardHeight}, current=${currentJHeight}, lock=${lock.revealBeforeHeight} [lockId=${lock.lockId.slice(0,16)}]`);
                  cancelInboundLock(`height_expired`);
                  continue;
                }

                // Forward HTLC with reduced timelock/height and inner envelope
                mempoolOps.push({
                  accountId: nextHop,
                  tx: {
                    type: 'htlc_lock',
                    data: {
                      lockId: `${lock.lockId}-fwd`,
                      hashlock: lock.hashlock,
                      timelock: forwardTimelock,
                      revealBeforeHeight: forwardHeight,
                      amount: forwardAmount,
                      tokenId: lock.tokenId,
                      envelope: innerEnvelope  // Next hop's envelope
                    }
                  }
                });
              } else {
                console.log(`❌ HTLC: No account found for nextHop ${nextHop.slice(-4)}`);
                cancelInboundLock(`no_account:${nextHop.slice(-4)}`);
              }
            }
          }
        }
      }

      // CRITICAL: Process multi-hop forwarding (consume pendingForward)
      // Skip if env.skipPendingForward (for AHB demo frame separation)
      // AUTO-PROPOSE deferred to Frame 13 when flag cleared
      if (accountMachine.pendingForward && !env.skipPendingForward) {
        const forward = accountMachine.pendingForward;

        const nextHop = forward.route.length > 1 ? forward.route[1] : null;

        if (nextHop) {
          const nextHopAccountKey = nextHop; // counterparty ID is key
          const nextHopAccount = newState.accounts.get(nextHopAccountKey);
          if (nextHopAccount) {
            // Forward full amount (no fees for simplicity)
            const forwardAmount = forward.amount;

            mempoolOps.push({
              accountId: nextHopAccountKey, // CRITICAL: Use canonical key, not entity ID!
              tx: {
                type: 'direct_payment',
                data: {
                  tokenId: forward.tokenId,
                  amount: forwardAmount,
                  route: forward.route.slice(1),
                  description: forward.description || 'Forwarded payment',
                  fromEntityId: state.entityId,
                  toEntityId: nextHop,
                }
              }
            });

          } else {
            console.log(`❌ No account found for next hop ${nextHop.slice(-4)}`);
          }
        } else {
          console.log(`❌ No next hop in forward route`);
        }

        delete accountMachine.pendingForward;
      }

      // === HTLC ERROR PROPAGATION (timeout/cancel) ===
      // When an htlc_resolve(error) happens, propagate cancel backward through route
      const timedOutHashlocks = result.timedOutHashlocks || [];
      for (const timedOutHashlock of timedOutHashlocks) {
        console.log(`⬅️ HTLC-ERROR: Propagating cancel for hashlock ${timedOutHashlock.slice(0,16)}...`);
        const route = newState.htlcRoutes.get(timedOutHashlock);
        if (route) {
          // Clear pending fee (won't be earned)
          if (route.pendingFee) {
            console.log(`   Clearing pending fee: ${route.pendingFee}`);
          }

          // Propagate cancel backward to inbound (sender gets lock released)
          if (route.inboundEntity && route.inboundLockId) {
            mempoolOps.push({
              accountId: route.inboundEntity,
              tx: {
                type: 'htlc_resolve',
                data: {
                  lockId: route.inboundLockId,
                  outcome: 'error' as const,
                  reason: 'downstream_error',
                }
              }
            });
            console.log(`⬅️ HTLC: Propagating cancel to ${route.inboundEntity.slice(-4)}`);
          } else {
            // We're the origin — payment failed, notify via event
            console.log(`❌ HTLC: Payment failed (we initiated), hashlock=${timedOutHashlock.slice(0,16)}...`);
            env.emit('HtlcFailed', {
              hashlock: timedOutHashlock,
              reason: 'timeout',
              entityId: state.entityId,
            });
          }

          // Remove from lockBook
          if (route.outboundLockId) {
            newState.lockBook.delete(route.outboundLockId);
          }

          // Remove from htlcRoutes
          newState.htlcRoutes.delete(timedOutHashlock);
          console.log(`   ✅ Route cleaned up`);
        }
      }

      // === HTLC SECRET PROPAGATION ===
      // Check if any reveals happened in this frame
      const revealedSecrets = result.revealedSecrets || [];
      if (HEAVY_LOGS) console.log(`🔍 HTLC-SECRET-CHECK: ${revealedSecrets.length} secrets revealed in frame`);

      // IMPORTANT:
      // Do NOT auto-queue on-chain RevealSecret on normal HTLC success path.
      // On-chain reveal is only queued via dispute flow (disputeFinalize + useOnchainRegistry),
      // not for default day-to-day payments.

      for (const { secret, hashlock } of revealedSecrets) {
        if (HEAVY_LOGS) console.log(`🔍 HTLC-SECRET: Processing revealed secret for hash ${hashlock.slice(0,16)}...`);
        const route = newState.htlcRoutes.get(hashlock);
        if (route) {
          if (route.secret) {
            console.log(`⏭️ HTLC: Secret already recorded for ${hashlock.slice(0, 16)}..., skipping duplicate propagation`);
            continue;
          }
          const outboundLock = route.outboundLockId ? newState.lockBook.get(route.outboundLockId) : undefined;
          const inboundLock = route.inboundLockId ? newState.lockBook.get(route.inboundLockId) : undefined;
          const eventLock = inboundLock ?? outboundLock;
          const eventAmount = eventLock?.amount ?? route.amount;
          const eventTokenId = eventLock?.tokenId ?? route.tokenId;
          const eventLockId = eventLock?.lockId ?? route.inboundLockId ?? route.outboundLockId;
          const finalizedDescription =
            (eventLock && newState.htlcNotes?.get(`lock:${eventLock.lockId}` as HtlcNoteKey))
            ?? newState.htlcNotes?.get(`hashlock:${hashlock}` as HtlcNoteKey)
            ?? undefined;

          // Store secret
          route.secret = secret;

          // Accrue fees on successful reveal (not on forward)
          if (route.pendingFee) {
            newState.htlcFeesEarned = (newState.htlcFeesEarned || 0n) + route.pendingFee;
            console.log(`💰 HTLC: Fee earned on reveal: ${route.pendingFee} (total: ${newState.htlcFeesEarned})`);
            delete route.pendingFee; // Clear pending (use delete for optional property)
          }

          // Remove from lockBook (E-Machine aggregated view) - payment settled
          if (route.outboundLockId) {
            newState.lockBook.delete(route.outboundLockId);
          }
          if (route.inboundLockId) {
            newState.lockBook.delete(route.inboundLockId);
          }

          // Propagate backward to sender (2024 hashlockMap pattern)
          if (route.inboundEntity && route.inboundLockId) {
            mempoolOps.push({
              accountId: route.inboundEntity,
              tx: {
                type: 'htlc_resolve',
                data: {
                  lockId: route.inboundLockId,
                  outcome: 'secret' as const,
                  secret
                }
              }
            });
            route.secretAckPending = true;
            route.secretAckStartedAt = newState.timestamp;
            route.secretAckDeadlineAt = newState.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS;
            if (newState.crontabState) {
              scheduleCrontabHook(newState.crontabState, {
                id: `htlc-secret-ack:${hashlock}`,
                triggerAt: route.secretAckDeadlineAt,
                type: 'htlc_secret_ack_timeout',
                data: {
                  hashlock,
                  counterpartyEntityId: route.inboundEntity,
                  inboundLockId: route.inboundLockId,
                },
              });
              markStorageEntityDirty(env, newState.entityId);
            }
            console.log(`⬅️ HTLC: Propagating secret to ${route.inboundEntity.slice(-4)}`);
          } else {
            if (route.crossJurisdictionRelay) {
              const relay = route.crossJurisdictionRelay;
              outputs.push({
                entityId: relay.targetEntityId,
                entityTxs: [{
                  type: 'resolveHtlcLock',
                  data: {
                    counterpartyEntityId: relay.targetCounterpartyEntityId,
                    lockId: relay.targetLockId,
                    secret,
                    description: `Cross-j ${relay.routeId} target claim ${relay.fillRatio}/65535`,
                  },
                }],
              });
              console.log(
                `🌉 HTLC: Relaying cross-j secret route=${relay.routeId} ` +
                `target=${relay.targetEntityId.slice(-4)} ratio=${relay.fillRatio}/65535`,
              );
            }
            console.log(`✅ HTLC: Payment complete (we initiated)`);
            terminateHtlcRoute(newState, hashlock, newState.timestamp);
            env.emit('HtlcFinalized', {
              ...buildHtlcFinalizedEventPayload({
                entityId: state.entityId,
                fromEntity: state.entityId,
                ...(route.outboundEntity ? { toEntity: route.outboundEntity } : {}),
                hashlock,
                secret,
                ...(eventLockId ? { lockId: eventLockId } : {}),
                ...(eventAmount !== undefined ? { amount: eventAmount } : {}),
                ...(eventTokenId !== undefined ? { tokenId: eventTokenId } : {}),
                ...(finalizedDescription ? { description: finalizedDescription } : {}),
                ...(route.startedAtMs !== undefined ? { startedAtMs: route.startedAtMs } : {}),
                ...(getJurisdictionId(state, env) ? { jurisdictionId: getJurisdictionId(state, env) } : {}),
                finalizedAtMs: newState.timestamp,
              }),
            });
          }
        } else {
          console.log(`⚠️ HTLC: No route found for hashlock ${hashlock.slice(0,16)}...`);
        }
      }

      // === COLLECT SWAP EVENTS (deferred to entity-level orchestration) ===
      const swapOffersCreated = result.swapOffersCreated || [];
      if (swapOffersCreated.length > 0) {
        accountHandlerLog.debug('swap.offers_created', { count: swapOffersCreated.length });
        allSwapOffersCreated.push(...swapOffersCreated);
      }

      const swapCancelRequests = result.swapCancelRequests || [];
      if (swapCancelRequests.length > 0) {
        accountHandlerLog.debug('swap.cancel_requests', { count: swapCancelRequests.length });
        const normalizedCancelRequests = swapCancelRequests.map(({ offerId }) => ({
          offerId,
          accountId: counterpartyId,
        }));
        allSwapCancelRequests.push(...normalizedCancelRequests);
      }

      const swapOffersCancelled = result.swapOffersCancelled || [];
      if (swapOffersCancelled.length > 0) {
        accountHandlerLog.debug('swap.offers_cancelled', { count: swapOffersCancelled.length });
        // Normalize to local counterparty key for this account machine.
        const normalizedCancels = swapOffersCancelled.map(({ offerId }) => ({ offerId, accountId: counterpartyId }));
        allSwapOffersCancelled.push(...normalizedCancels);
      }

      // Send response (ACK + optional new frame)
      if (result.response) {
        accountHandlerLog.debug('response.send', { to: shortId(result.response.toEntityId), height: result.response.height });

        // Get target proposer
        // IMPORTANT: Send only to PROPOSER - bilateral consensus between entity proposers
        // Multi-validator entities sync account state via entity-level consensus (not bilateral broadcast)
        outputs.push({
          entityId: result.response.toEntityId,
          entityTxs: [{
            type: 'accountInput',
            data: result.response
          }]
        });

        accountHandlerLog.debug('response.queued', {
          from: shortId(state.entityId),
          to: shortId(result.response.toEntityId),
          height: result.response.height,
          prevHanko: Boolean(result.response.prevHanko),
        });
      }
    } else {
      console.error(`❌ Frame consensus failed: ${result.error}`);
      addMessage(newState, `❌ ${result.error}`);
      throw new Error(`FRAME_CONSENSUS_FAILED: ${result.error || 'unknown'}`);
    }
  } else if (!input.settleAction) {
    // Only error if there was no settleAction either
    // Settlement workspace actions (propose/update/approve/reject) don't require frames
    console.error(`❌ Received AccountInput without frames - invalid!`);
    addMessage(newState, `❌ Invalid AccountInput from ${input.fromEntityId.slice(-4)}`);
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

/**
 * Process swap offers through hub's orderbook (PURE - returns events, no mutations)
 * Called at entity level after aggregating all swap events
 */
export function processOrderbookSwaps(
  hubState: EntityState,
  swapOffers: NormalizedOrderbookOffer[],
  options: OrderbookProcessOptions = {},
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const crossJurisdictionFills: CrossJurisdictionFillInstruction[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const debugProjectionRejects: Array<{ offerId: string; accountId: string; reason: string }> = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
  const debugRebuildProjectionOnly = options.debugRebuildProjectionOnly === true;
  const sameAccountSwapOffers = swapOffers.filter((offer) => !offer.crossJurisdiction);
  const crossJurisdictionSwapOffers = swapOffers.filter((offer) => !!offer.crossJurisdiction);
  const minTradeSize = ext.hubProfile?.minTradeSize ?? 0n;
  const swapTakerFeeBpsRaw = hubState.hubRebalanceConfig?.swapTakerFeeBps;
  const swapTakerFeeBps = Number.isFinite(Number(swapTakerFeeBpsRaw))
    ? Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBpsRaw))))
    : 0;
  const debugProjectionRejectKeys = new Set<string>();
  const recordDebugProjectionReject = (accountId: string, offerId: string, reason: string): true => {
    if (!debugRebuildProjectionOnly) {
      throw new Error(
        `ORDERBOOK_LIVE_PROJECTION_REJECT: account=${accountId} offer=${offerId} reason=${reason}`,
      );
    }
    const key = swapKey(accountId, offerId);
    if (debugProjectionRejectKeys.has(key)) return true;
    debugProjectionRejectKeys.add(key);
    debugProjectionRejects.push({ accountId, offerId, reason });
    return true;
  };
  const rejectInvalidCrossOffer = (accountId: string, offerId: string, reason: string): void => {
    // Cross-j orders settle through fill notices and pull clearing. Rehydrate
    // can report debug projection rejects; live matching must surface malformed
    // routes as invariant failures instead of silently cancelling liquidity.
    recordDebugProjectionReject(accountId, offerId, reason);
    orderbookLog.warn('crossj.offer_skipped', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8), reason });
  };
  const rejectInvalidOffer = (accountId: string, offerId: string, reason: string): void => {
    if (debugRebuildProjectionOnly) {
      recordDebugProjectionReject(accountId, offerId, reason);
      return;
    }
    queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, accountId, {
      offerId,
      fillRatio: 0,
      cancelRemainder: true,
      comment: reason,
    });
  };

  // Pair books stay hot within this pass so same-tick offers see each other's exact fills.
  // The book is a deterministic projection of account swapOffers, not a second owner of order lifecycle.
  const bookCache = new Map<string, BookState>();
  const orderbookOfferMeta = new Map<string, NormalizedOrderbookOffer>();
  let pairSweepCount = 0;
  const queuedSwapResolutions = new Set<string>();
  const sweptPairs = new Set<string>();

  const materializeCanonicalRestingOffer = (
    giveTokenId: number,
    wantTokenId: number,
    priceTicks: bigint,
    qtyLots: number,
  ): {
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
    quantizedGive: bigint;
    quantizedWant: bigint;
    priceTicks: bigint;
  } => {
    const baseAmount = BigInt(qtyLots) * SWAP_LOT_SCALE;
    const side = deriveSide(giveTokenId, wantTokenId);
    const quoteAmount = (baseAmount * priceTicks) / ORDERBOOK_PRICE_SCALE;
    if (side === 1) {
      return {
        giveTokenId,
        wantTokenId,
        giveAmount: baseAmount,
        wantAmount: quoteAmount,
        quantizedGive: baseAmount,
        quantizedWant: quoteAmount,
        priceTicks,
      };
    }
    return {
      giveTokenId,
      wantTokenId,
      giveAmount: quoteAmount,
      wantAmount: baseAmount,
      quantizedGive: quoteAmount,
      quantizedWant: baseAmount,
      priceTicks,
    };
  };

  const buildLiveOfferMeta = (
    namespacedOrderId: string,
  ): NormalizedOrderbookOffer | null => {
    const lastColon = namespacedOrderId.lastIndexOf(':');
    if (lastColon === -1) return null;
    const accountId = namespacedOrderId.slice(0, lastColon);
    const offerId = namespacedOrderId.slice(lastColon + 1);
    const account = hubState.accounts.get(accountId);
    const liveOffer = account?.swapOffers?.get(offerId);
    if (!account || !liveOffer) return null;
    if (liveOffer.crossJurisdiction) return null;
    const entityRefs = resolveStoredOfferEntityRefs(account, liveOffer);
    return normalizeSwapOfferForOrderbook(
      {
        offerId,
        makerIsLeft: liveOffer.makerIsLeft,
        fromEntity: entityRefs.fromEntity,
        toEntity: entityRefs.toEntity,
        createdHeight: liveOffer.createdHeight,
        giveTokenId: liveOffer.giveTokenId,
        giveAmount: liveOffer.giveAmount,
        wantTokenId: liveOffer.wantTokenId,
        wantAmount: liveOffer.wantAmount,
        priceTicks: liveOffer.priceTicks,
        timeInForce: liveOffer.timeInForce,
        minFillRatio: liveOffer.minFillRatio,
        ...(liveOffer.crossJurisdiction ? { crossJurisdiction: liveOffer.crossJurisdiction } : {}),
      },
      accountId,
    );
  };

  const synthesizeOfferFromMissingBookLookup = (
    takerSide: 0 | 1,
    baseTokenId: number,
    quoteTokenId: number,
    originalLots: number,
    filledLots: number,
    weightedCost: bigint,
  ): {
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
    quantizedGive: bigint;
    quantizedWant: bigint;
    priceTicks: bigint;
  } => {
    const originalLotsBig = BigInt(Math.max(0, originalLots));
    const filledLotsBig = BigInt(Math.max(0, filledLots));
    if (originalLotsBig <= 0n || filledLotsBig <= 0n) {
      throw new Error(`ORDERBOOK_FILL_LOOKUP_FAILED: invalid lots original=${originalLots} filled=${filledLots}`);
    }

    if (weightedCost <= 0n || weightedCost % filledLotsBig !== 0n) {
      throw new Error(
        `ORDERBOOK_FILL_LOOKUP_FAILED: non-integral maker price weightedCost=${weightedCost.toString()} filledLots=${filledLotsBig.toString()}`,
      );
    }

    const makerSide = takerSide === 0 ? 1 : 0;
    const priceTicks = weightedCost / filledLotsBig;
    const canonicalOffer = materializeCanonicalRestingOffer(
      makerSide === 1 ? baseTokenId : quoteTokenId,
      makerSide === 1 ? quoteTokenId : baseTokenId,
      priceTicks,
      Number(originalLotsBig),
    );
    if (canonicalOffer.giveAmount <= 0n || canonicalOffer.wantAmount <= 0n) {
      throw new Error(
        `ORDERBOOK_FILL_LOOKUP_FAILED: synthesized maker offer is zero give=${canonicalOffer.giveAmount.toString()} want=${canonicalOffer.wantAmount.toString()}`,
      );
    }
    return canonicalOffer;
  };

  const resolvePairBandReference = (
    pairPolicy: SwapPairPolicy,
    hasExplicitPairPolicy: boolean,
    bestBid: bigint | null,
    bestAsk: bigint | null,
  ): { anchor: bigint | null; label: string } => {
    if (bestBid !== null && bestAsk !== null) {
      return { anchor: (bestBid + bestAsk) / 2n, label: 'midpoint' };
    }
    if (bestBid !== null) return { anchor: bestBid, label: 'bestBid' };
    if (bestAsk !== null) return { anchor: bestAsk, label: 'bestAsk' };
    if (!hasExplicitPairPolicy) return { anchor: null, label: 'unanchored' };
    return { anchor: pairPolicy.mmMidPriceTicks, label: 'policyMid' };
  };

  const containCurrentOfferPairFailure = (
    pairId: string,
    currentAccountId: string,
    currentOfferId: string,
    message: string,
  ): void => {
    console.error(
      `❌ ORDERBOOK: pair-local failure pair=${pairId} offer=${currentOfferId} account=${currentAccountId.slice(-8)} error=${message}`,
    );
    if (debugRebuildProjectionOnly) {
      recordDebugProjectionReject(currentAccountId, currentOfferId, `pair-error:${message}`);
      return;
    }
    throw new Error(
      `ORDERBOOK_PAIR_COMMAND_FAILED: pair=${pairId} account=${currentAccountId} offer=${currentOfferId} error=${message}`,
    );
  };

  const createEmptyPairBook = (
    bucketWidthTicks: number,
  ): BookState => createBook({
    bucketWidthTicks: BigInt(Math.max(1, bucketWidthTicks)),
    maxOrders: LIMITS.MAX_ORDERBOOK_ORDERS_PER_PAIR,
    stpPolicy: 1,
  });

  const sweepPairOutOfBandOffers = (
    pairId: string,
    pairPolicy: SwapPairPolicy,
    hasExplicitPairPolicy: boolean,
    currentBook: BookState,
  ): BookState => {
    const REJECT_BPS = SWAP_CONSTANTS.PRICE_REJECT_BPS;
    const BPS_BASE = SWAP_CONSTANTS.BPS_BASE;
    const bestBid = getBestBid(currentBook);
    const bestAsk = getBestAsk(currentBook);
    const { anchor: bandAnchor, label: bandLabel } = resolvePairBandReference(pairPolicy, hasExplicitPairPolicy, bestBid, bestAsk);
    if (bandAnchor === null) return currentBook;

    const minAllowed = bandAnchor - ((bandAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
    const maxAllowed = bandAnchor + ((bandAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
    let removed = 0;
    let nextBook = currentBook;

    for (const order of currentBook.orders.values()) {
      const liveOffer = buildLiveOfferMeta(order.orderId);
      if (!liveOffer) {
        if (debugRebuildProjectionOnly) continue;
        throw new Error(`ORDERBOOK_ORPHAN_BOOK_ORDER: pair=${pairId} order=${order.orderId}`);
      }
      if (order.priceTicks < minAllowed || order.priceTicks > maxAllowed) {
        removed += 1;
        console.warn(
          `⚠️ ORDERBOOK: sweeping out-of-band resting offer=${liveOffer.offerId} pair=${pairId} price=${order.priceTicks.toString()} ` +
          `outside ±${REJECT_BPS / 100}% of ${bandLabel} ${bandAnchor.toString()}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(liveOffer.accountId, liveOffer.offerId, `outside-anchor-band:${order.priceTicks.toString()}`);
        } else {
          const cancelResult = applyCommand(nextBook, {
            kind: 1,
            ownerId: order.ownerId,
            orderId: order.orderId,
          });
          nextBook = cancelResult.state;
          queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, liveOffer.accountId, {
            offerId: liveOffer.offerId,
            fillRatio: 0,
            cancelRemainder: true,
          });
        }
        continue;
      }
    }

    if (removed === 0) return currentBook;
    pairSweepCount += 1;
    return nextBook;
  };

  const assertBookMatchesKnownAccountOffers = (pairId: string, book: BookState): void => {
    for (const order of book.orders.values()) {
      const orderId = order.orderId;
      const meta = orderbookOfferMeta.get(orderId) ?? buildLiveOfferMeta(orderId);
      if (!meta) {
        throw new Error(`ORDERBOOK_ORPHAN_BOOK_ORDER: pair=${pairId} order=${orderId}`);
      }
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, meta.accountId, meta.offerId)) {
        throw new Error(`ORDERBOOK_PENDING_RESOLUTION_STILL_IN_BOOK: pair=${pairId} order=${orderId}`);
      }
      orderbookOfferMeta.set(orderId, meta);
      const metaSide = deriveSide(meta.giveTokenId, meta.wantTokenId);
      const metaBaseAmount = metaSide === 1
        ? (meta.quantizedGive ?? meta.giveAmount)
        : meta.wantAmount;
      if (
        order.priceTicks !== meta.priceTicks ||
        order.ownerId !== (meta.makerIsLeft ? meta.fromEntity : meta.toEntity) ||
        BigInt(order.qtyLots) !== metaBaseAmount / SWAP_LOT_SCALE
      ) {
        throw new Error(
          `ORDERBOOK_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
          `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
        );
      }
    }
  };

  const buildCrossMarketOffer = (offer: NormalizedOrderbookOffer): CrossMarketOffer | null => {
    return buildCrossJurisdictionMarketOffer(offer, hubState.entityId);
  };

  const buildCrossMarketOfferFromBookOrder = (namespacedOrderId: string): CrossMarketOffer | null => {
    const lastColon = namespacedOrderId.lastIndexOf(':');
    if (lastColon === -1) return null;
    const accountId = namespacedOrderId.slice(0, lastColon);
    const offerId = namespacedOrderId.slice(lastColon + 1);
    const account = hubState.accounts.get(accountId);
    const offer = account?.swapOffers?.get(offerId);
    if (!account || !offer?.crossJurisdiction) return null;
    const entityRefs = resolveStoredOfferEntityRefs(account, offer);
    return buildCrossMarketOffer(normalizeSwapOfferForOrderbook(
      {
        offerId,
        makerIsLeft: offer.makerIsLeft,
        fromEntity: entityRefs.fromEntity,
        toEntity: entityRefs.toEntity,
        createdHeight: offer.createdHeight,
        giveTokenId: offer.giveTokenId,
        giveAmount: offer.giveAmount,
        wantTokenId: offer.wantTokenId,
        wantAmount: offer.wantAmount,
        priceTicks: offer.priceTicks,
        timeInForce: offer.timeInForce,
        minFillRatio: offer.minFillRatio,
        crossJurisdiction: offer.crossJurisdiction,
      },
      accountId,
    ));
  };

  const crossLiveOfferMeta = new Map<string, CrossMarketOffer>();
  const crossPendingAckInputs = new Map<
    string,
    NonNullable<NormalizedOrderbookOffer['pendingCrossSwapAck']>
  >();
  for (const rawOffer of crossJurisdictionSwapOffers) {
    if (!rawOffer.pendingCrossSwapAck) continue;
    crossPendingAckInputs.set(swapKey(rawOffer.accountId, rawOffer.offerId), rawOffer.pendingCrossSwapAck);
  }
  const assertedCrossJurisdictionPairs = new Set<string>();
  const crossPendingAckOrderIdsByPair = new Map<string, Set<string>>();
  const crossAggregatedFills = new Map<string, { filledLots: number; weightedCost: bigint }>();
  const suspendCrossOrderForPendingAck = (pairId: string, orderId: string): void => {
    let orders = crossPendingAckOrderIdsByPair.get(pairId);
    if (!orders) {
      orders = new Set();
      crossPendingAckOrderIdsByPair.set(pairId, orders);
    }
    orders.add(orderId);
  };
  const suspendedCrossOrdersForPair = (pairId: string): ReadonlySet<string> | undefined => {
    const orders = crossPendingAckOrderIdsByPair.get(pairId);
    return orders && orders.size > 0 ? orders : undefined;
  };

  const refreshExistingCrossBookOrder = (
    pairId: string,
    namespacedOrderId: string,
    meta: CrossMarketOffer,
  ): void => {
    let book = bookCache.get(pairId) || ext.books.get(pairId);
    if (!book || !getBookOrder(book, namespacedOrderId)) return;

    const qtyLots = meta.baseAmount / SWAP_LOT_SCALE;
    if (qtyLots > 0xFFFFFFFFn) {
      throw new Error(`ORDERBOOK_CROSS_J_REFRESH_QTY_INVALID: pair=${pairId} order=${namespacedOrderId} qty=${qtyLots.toString()}`);
    }
    if (qtyLots > 0n) {
      book = refreshRestingOrder(book, {
        ownerId: meta.makerId,
        orderId: namespacedOrderId,
        side: meta.side,
        priceTicks: meta.priceTicks,
        qtyLots: Number(qtyLots),
      });
    } else {
      const cancelResult = applyCommand(book, {
        kind: 1,
        ownerId: meta.makerId,
        orderId: namespacedOrderId,
      });
      book = cancelResult.state;
    }

    bookCache.set(pairId, book);
    bookUpdates.push({ pairId, book });
  };

  const assertCrossBookMatchesKnownRoutes = (pairId: string, book: BookState): void => {
    if (assertedCrossJurisdictionPairs.has(pairId)) return;
    assertedCrossJurisdictionPairs.add(pairId);

    for (const order of book.orders.values()) {
      const orderId = order.orderId;
      const lastColon = orderId.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(`ORDERBOOK_CROSS_J_MALFORMED_BOOK_ORDER: pair=${pairId} order=${orderId}`);
      }
      const accountId = orderId.slice(0, lastColon);
      const offerId = orderId.slice(lastColon + 1);
      const queuedPendingAck = findQueuedCrossSwapAckForEntityState(hubState, accountId, offerId);
      const pendingAck = crossPendingAckInputs.get(orderId) ?? queuedPendingAck?.data ?? null;
      const meta = crossLiveOfferMeta.get(orderId) ?? buildCrossMarketOfferFromBookOrder(orderId);
      if (!meta) {
        if (pendingAck) {
          suspendCrossOrderForPendingAck(pairId, orderId);
          continue;
        }
        throw new Error(`ORDERBOOK_CROSS_J_ORPHAN_BOOK_ORDER: pair=${pairId} order=${orderId}`);
      }

      crossLiveOfferMeta.set(orderId, meta);
      const canonicalQtyLots = meta.baseAmount / SWAP_LOT_SCALE;
      if (pendingAck) {
        const pendingRatio = Math.max(
          0,
          Math.min(MAX_SWAP_FILL_RATIO, Math.floor(Number(pendingAck.cumulativeFillRatio ?? 0) || 0)),
        );
        if (pendingAck.cancelRemainder || pendingRatio >= MAX_SWAP_FILL_RATIO) {
          suspendCrossOrderForPendingAck(pairId, orderId);
          continue;
        }
        if (BigInt(order.qtyLots) > canonicalQtyLots) {
          throw new Error(
            `ORDERBOOK_CROSS_J_PENDING_ACK_QTY_INVALID: pair=${pairId} order=${orderId} ` +
            `storedQty=${order.qtyLots.toString()} canonicalQty=${canonicalQtyLots.toString()}`,
          );
        }
        suspendCrossOrderForPendingAck(pairId, orderId);
        continue;
      }
      if (
        meta.pairId !== pairId ||
        order.priceTicks !== meta.priceTicks ||
        order.ownerId !== meta.makerId ||
        BigInt(order.qtyLots) !== canonicalQtyLots
      ) {
        throw new Error(
          `ORDERBOOK_CROSS_J_CACHE_MISMATCH: pair=${pairId} order=${orderId} ` +
          `storedPrice=${order.priceTicks.toString()} canonicalPrice=${meta.priceTicks.toString()}`,
        );
      }
    }
  };

  const processCrossJurisdictionOffers = (): void => {
    for (const rawOffer of crossJurisdictionSwapOffers) {
      const marketOffer = buildCrossMarketOffer(rawOffer);
      if (!marketOffer) continue;
      crossLiveOfferMeta.set(swapKey(rawOffer.accountId, rawOffer.offerId), marketOffer);
    }

    for (const rawOffer of sortSwapOffersForOrderbook(crossJurisdictionSwapOffers)) {
      if (crossPendingAckInputs.has(swapKey(rawOffer.accountId, rawOffer.offerId))) continue;
      const marketOffer = buildCrossMarketOffer(rawOffer);
      if (!marketOffer) continue;
      refreshExistingCrossBookOrder(
        marketOffer.pairId,
        swapKey(rawOffer.accountId, rawOffer.offerId),
        marketOffer,
      );
    }

    for (const [pairId, book] of ext.books) {
      if (!String(pairId).startsWith('cross:')) continue;
      const currentBook = bookCache.get(pairId) || book;
      assertCrossBookMatchesKnownRoutes(pairId, currentBook);
      if (currentBook !== book) {
        bookCache.set(pairId, currentBook);
      }
    }

    for (const rawOffer of sortSwapOffersForOrderbook(crossJurisdictionSwapOffers)) {
      const currentAccountId = rawOffer.accountId;
      const currentNamespacedOrderId = swapKey(currentAccountId, rawOffer.offerId);
      if (crossPendingAckInputs.has(currentNamespacedOrderId)) continue;
      const marketOffer = buildCrossMarketOffer(rawOffer);
      if (!marketOffer) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, 'invalid-cross-j-route');
        continue;
      }
      const qtyLots = marketOffer.baseAmount / SWAP_LOT_SCALE;
      if (qtyLots <= 0n) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `cross-dust-remainder:${marketOffer.baseAmount.toString()}`);
        continue;
      }
      if (qtyLots > 0xFFFFFFFFn) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `invalid-cross-qty:${qtyLots.toString()}`);
        continue;
      }

      crossLiveOfferMeta.set(currentNamespacedOrderId, marketOffer);
      const suspendedOrderIds = suspendedCrossOrdersForPair(marketOffer.pairId);
      if (suspendedOrderIds?.has(currentNamespacedOrderId)) continue;
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, rawOffer.offerId)) {
        continue;
      }
      // Cross-j routes carry delayed clearing state outside the plain book.
      // The book itself is loaded from the persisted snapshot and updated by
      // normal order commands, never rebuilt from an account scan in live mode.
      let book = bookCache.get(marketOffer.pairId) || ext.books.get(marketOffer.pairId);
      if (!book) {
        book = createEmptyPairBook(getSwapPairPolicyByBaseQuote(rawOffer.giveTokenId, rawOffer.wantTokenId).bookBucketWidthTicks);
      } else {
        assertCrossBookMatchesKnownRoutes(marketOffer.pairId, book);
      }
      const existingOrder = getBookOrder(book, currentNamespacedOrderId);
      if (existingOrder) {
        const refreshResult = applyCommand(book, {
          kind: 1,
          ownerId: marketOffer.makerId,
          orderId: currentNamespacedOrderId,
        });
        book = refreshResult.state;
        bookCache.set(marketOffer.pairId, book);
        bookUpdates.push({ pairId: marketOffer.pairId, book });
      }

      let result: ReturnType<typeof applyCommand>;
      try {
        result = applyCommand(book, {
          kind: 0,
          ownerId: marketOffer.makerId,
          orderId: currentNamespacedOrderId,
          side: marketOffer.side,
          tif: rawOffer.timeInForce,
          postOnly: debugRebuildProjectionOnly,
          priceTicks: marketOffer.priceTicks,
          qtyLots: Number(qtyLots),
          minFillRatio: rawOffer.minFillRatio,
        }, suspendedOrderIds ? { suspendedOrderIds } : undefined);
      } catch (error) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `cross-pair-error:${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      book = result.state;
      bookCache.set(marketOffer.pairId, book);
      bookUpdates.push({ pairId: marketOffer.pairId, book });

      const rejectEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'REJECT' }> =>
          event.type === 'REJECT' && event.orderId === currentNamespacedOrderId,
      );
      const tradeEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'TRADE' }> => event.type === 'TRADE',
      );
      if (rejectEvents.length > 0 && tradeEvents.length === 0) {
        rejectInvalidCrossOffer(currentAccountId, rawOffer.offerId, `cross-post-only-reject:${rejectEvents.map(event => event.reason).join(',')}`);
        continue;
      }
      if (debugRebuildProjectionOnly) {
        if (tradeEvents.length > 0) {
          recordDebugProjectionReject(currentAccountId, rawOffer.offerId, `debug-rebuild-cross-trade:${tradeEvents.length}`);
        }
        continue;
      }

      const fillsPerOrder = new Map<string, { filledLots: number; weightedCost: bigint }>();
      for (const event of tradeEvents) {
        const tradeCost = event.price * BigInt(event.qty);
        for (const orderId of [event.makerOrderId, event.takerOrderId]) {
          const entry = fillsPerOrder.get(orderId);
          if (entry) {
            entry.filledLots += event.qty;
            entry.weightedCost += tradeCost;
          } else {
            fillsPerOrder.set(orderId, { filledLots: event.qty, weightedCost: tradeCost });
          }
        }
      }

      for (const [namespacedOrderId, fill] of fillsPerOrder) {
        const meta = crossLiveOfferMeta.get(namespacedOrderId) ?? buildCrossMarketOfferFromBookOrder(namespacedOrderId);
        if (!meta) {
          throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${namespacedOrderId}`);
        }
        const lastColon = namespacedOrderId.lastIndexOf(':');
        if (lastColon === -1) continue;
        const accountId = namespacedOrderId.slice(0, lastColon);
        const offerId = namespacedOrderId.slice(lastColon + 1);
        if (hasQueuedCrossSwapAckForEntityState(hubState, accountId, offerId)) continue;
        const aggregatedFill = crossAggregatedFills.get(namespacedOrderId);
        if (aggregatedFill) {
          aggregatedFill.filledLots += fill.filledLots;
          aggregatedFill.weightedCost += fill.weightedCost;
        } else {
          crossAggregatedFills.set(namespacedOrderId, {
            filledLots: fill.filledLots,
            weightedCost: fill.weightedCost,
          });
        }
      }
    }

    for (const namespacedOrderId of [...crossAggregatedFills.keys()].sort(compareCanonicalText)) {
      const fill = crossAggregatedFills.get(namespacedOrderId);
      if (!fill) continue;
      const meta = crossLiveOfferMeta.get(namespacedOrderId) ?? buildCrossMarketOfferFromBookOrder(namespacedOrderId);
      if (!meta) {
        throw new Error(`ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${namespacedOrderId}`);
      }
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) continue;
      const accountId = namespacedOrderId.slice(0, lastColon);
      const offerId = namespacedOrderId.slice(lastColon + 1);
      if (hasQueuedCrossSwapAckForEntityState(hubState, accountId, offerId)) continue;
      const ack = buildCrossJurisdictionFillAck(accountId, offerId, namespacedOrderId, meta, fill);
      if (!ack) continue;
      crossJurisdictionFills.push(ack.instruction);
      mempoolOps.push({ accountId, tx: ack.tx });
    }
  };

  processCrossJurisdictionOffers();

  for (const rawOffer of sortSwapOffersForOrderbook(sameAccountSwapOffers)) {
    let offer = rawOffer;
    const currentAccountId = offer.accountId;
    if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, currentAccountId, offer.offerId)) {
      continue;
    }
    orderbookLog.debug('offer.process', { offer: shortOrder(offer.offerId), account: shortId(currentAccountId, 8) });

    const { pairId, base, quote } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const bookKey = pairId;

    const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
    // SWAP_LOT_SCALE = 10^12: Orderbook works in lots for uint32 efficiency.
    // For 18-decimal tokens: 1 lot = 0.000001 tokens.
    // This is acceptable: sub-$0.001 orders at typical ETH prices are uneconomical anyway
    const MAX_LOTS = 0xFFFFFFFFn;

    let priceTicks: bigint;
    let qtyLots: bigint;

    const isSellBase = offer.giveTokenId === base && offer.wantTokenId === quote;
    const isBuyBase = offer.giveTokenId === quote && offer.wantTokenId === base;
    const pairPolicy = getSwapPairPolicyByBaseQuote(base, quote);
    const hasExplicitPairPolicy = hasSwapPairPolicyByBaseQuote(base, quote);
    const bucketWidthTicks = Math.max(1, pairPolicy.bookBucketWidthTicks);
    if (!isSellBase && !isBuyBase) {
      console.warn(
        `⚠️ ORDERBOOK: Invalid token direction for offer=${offer.offerId} give=${offer.giveTokenId} want=${offer.wantTokenId} base=${base} quote=${quote}`,
      );
      rejectInvalidOffer(currentAccountId, offer.offerId, 'invalid-direction');
      continue;
    }

    const baseAmount = isSellBase ? offer.giveAmount : offer.wantAmount;
    const quoteAmount = isSellBase ? offer.wantAmount : offer.giveAmount;
    if (baseAmount <= 0n || quoteAmount <= 0n) {
      console.warn(`⚠️ ORDERBOOK: Zero amount in offer=${offer.offerId}, base=${baseAmount}, quote=${quoteAmount}`);
      rejectInvalidOffer(currentAccountId, offer.offerId, 'zero-amount');
      continue;
    }
    if (minTradeSize > 0n && quoteAmount < minTradeSize) {
      console.warn(
        `⚠️ ORDERBOOK: Offer below minTradeSize=${minTradeSize.toString()} quote=${quoteAmount.toString()} offer=${offer.offerId}` +
        (debugRebuildProjectionOnly ? '; rejected from debug projection rebuild' : '; cancelling remainder'),
      );
      if (debugRebuildProjectionOnly) {
        recordDebugProjectionReject(currentAccountId, offer.offerId, `below-minTradeSize:${quoteAmount.toString()}`);
        continue;
      }
      queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
        offerId: offer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
      });
      continue;
    }
    if (baseAmount % SWAP_LOT_SCALE !== 0n) {
      console.warn(
        `⚠️ ORDERBOOK: base amount not aligned to SWAP_LOT_SCALE — skipping offer=${offer.offerId}, amount=${baseAmount}`,
      );
      rejectInvalidOffer(currentAccountId, offer.offerId, `lot-misaligned:${baseAmount.toString()}`);
      continue;
    }

    priceTicks = offer.priceTicks;

    qtyLots = baseAmount / SWAP_LOT_SCALE;

    if (qtyLots === 0n || qtyLots > MAX_LOTS || priceTicks <= 0n) {
      console.warn(`⚠️ ORDERBOOK: Invalid order — skipping offer=${offer.offerId}, qty=${qtyLots}, price=${priceTicks}`);
      rejectInvalidOffer(currentAccountId, offer.offerId, `invalid-order:${qtyLots.toString()}:${priceTicks.toString()}`);
      continue;
    }

    // ext.books is the persisted hot book snapshot. Live mode must not rebuild
    // it by scanning accounts; mismatches are bugs that need a root-cause fix.
    let book = bookCache.get(bookKey) || ext.books.get(bookKey);
    if (!book) {
      book = createEmptyPairBook(bucketWidthTicks);
    } else {
      assertBookMatchesKnownAccountOffers(bookKey, book);
    }

    if (!sweptPairs.has(bookKey)) {
      sweptPairs.add(bookKey);
      const sweptBook = sweepPairOutOfBandOffers(bookKey, pairPolicy, hasExplicitPairPolicy, book);
      if (sweptBook !== book) {
        book = sweptBook;
        bookCache.set(bookKey, book);
        bookUpdates.push({ pairId: bookKey, book });
      }
    }

    const bestBid = getBestBid(book);
    const bestAsk = getBestAsk(book);
    const REJECT_BPS = SWAP_CONSTANTS.PRICE_REJECT_BPS;
    const WARN_BPS = SWAP_CONSTANTS.PRICE_WARN_BPS;
    const BPS_BASE = SWAP_CONSTANTS.BPS_BASE;
    const { anchor: marketAnchor, label: marketAnchorLabel } = resolvePairBandReference(pairPolicy, hasExplicitPairPolicy, bestBid, bestAsk);
    if (marketAnchor !== null) {
      const minAllowed = marketAnchor - ((marketAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
      const maxAllowed = marketAnchor + ((marketAnchor * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
      if (priceTicks < minAllowed || priceTicks > maxAllowed) {
        console.warn(
          `⚠️ ORDERBOOK: price ${priceTicks.toString()} is outside ±${REJECT_BPS / 100}% band ` +
          `around ${marketAnchorLabel} ${marketAnchor.toString()} (bestBid=${String(bestBid)} bestAsk=${String(bestAsk)}) ` +
          `— auto-canceling offer=${offer.offerId}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(currentAccountId, offer.offerId, `outside-anchor-band:${priceTicks.toString()}`);
          continue;
        }
        queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
          offerId: offer.offerId,
          fillRatio: 0,
          cancelRemainder: true,
        });
        continue;
      }
    }
    if (side === 0 && bestAsk !== null) {
      const warnAbove = bestAsk + ((bestAsk * BigInt(WARN_BPS)) / BigInt(BPS_BASE));
      if (priceTicks > warnAbove) {
        console.warn(
          `⚠️ ORDERBOOK: BUY price ${priceTicks.toString()} is ${WARN_BPS / 100}%+ above best ask ${bestAsk.toString()} — allowing match/rest`,
        );
      }
    }
    if (side === 1 && bestBid !== null) {
      const warnBelow = bestBid - ((bestBid * BigInt(WARN_BPS)) / BigInt(BPS_BASE));
      if (priceTicks < warnBelow) {
        console.warn(
          `⚠️ ORDERBOOK: SELL price ${priceTicks.toString()} is ${WARN_BPS / 100}%+ below best bid ${bestBid.toString()} — allowing match/rest`,
        );
      }
    }

    const makerId = offer.makerIsLeft ? offer.fromEntity : offer.toEntity;
    const currentNamespacedOrderId = `${currentAccountId}:${offer.offerId}`;
    orderbookOfferMeta.set(currentNamespacedOrderId, {
      ...offer,
      accountId: currentAccountId,
      priceTicks,
    });
    const existingOrder = getBookOrder(book, currentNamespacedOrderId);
    if (existingOrder) {
      if (
        existingOrder.ownerId === makerId &&
        existingOrder.side === side &&
        BigInt(existingOrder.qtyLots) === qtyLots &&
        existingOrder.priceTicks === priceTicks
      ) {
        console.log(
          `📊 ORDERBOOK-SKIP: already materialized offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
          `price=${priceTicks.toString()} qty=${qtyLots.toString()}`,
        );
        bookCache.set(bookKey, book);
        continue;
      }
      console.warn(
        `⚠️ ORDERBOOK: cached order mismatch for live offer=${offer.offerId} account=${currentAccountId.slice(-8)} ` +
        `storedPrice=${existingOrder.priceTicks.toString()} canonicalPrice=${priceTicks.toString()} ` +
        `storedQty=${existingOrder.qtyLots.toString()} canonicalQty=${qtyLots.toString()}`,
      );
      throw new Error(`ORDERBOOK_CACHE_MISMATCH: pair=${bookKey} order=${currentNamespacedOrderId}`);
    }
    orderbookLog.debug('order.add', {
      maker: shortId(makerId),
      order: shortOrder(currentNamespacedOrderId, 20),
      side,
      price: priceTicks.toString(),
      qty: qtyLots.toString(),
    });

    let result: ReturnType<typeof applyCommand>;
    try {
      result = applyCommand(book, {
        kind: 0,
        ownerId: makerId,
        orderId: currentNamespacedOrderId,
        side,
        tif: offer.timeInForce,
        postOnly: debugRebuildProjectionOnly,
        priceTicks,
        qtyLots: Number(qtyLots),
        minFillRatio: offer.minFillRatio,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Out of order slots') {
        console.warn(
          `⚠️ ORDERBOOK FULL: pair=${bookKey} maxOrders=${book.params.maxOrders} offer=${offer.offerId} account=${currentAccountId.slice(-8)}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(currentAccountId, offer.offerId, `book-full:${book.params.maxOrders}`);
          continue;
        }
        if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
          offerId: offer.offerId,
          fillRatio: 0,
          cancelRemainder: true,
        })) {
          orderbookLog.debug('resolve.queued_cancel_full_book', { offer: shortOrder(offer.offerId, 8), account: shortId(currentAccountId, 8) });
        }
        continue;
      }
      containCurrentOfferPairFailure(bookKey, currentAccountId, offer.offerId, message);
      continue;
    }

    book = result.state;
    // Keep the updated pair book hot for the rest of this matching pass.
    bookCache.set(bookKey, book);
    bookUpdates.push({ pairId: bookKey, book });

    try {
      const rejectEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'REJECT' }> =>
          event.type === 'REJECT' && event.orderId === currentNamespacedOrderId,
      );
      const tradeEvents = result.events.filter(
        (event): event is Extract<typeof result.events[number], { type: 'TRADE' }> => event.type === 'TRADE',
      );
      const stpRejectEvent = rejectEvents.find((event) => event.reason === 'STP cancel taker');
      const resolveComment = stpRejectEvent
        ? `STP:${String(stpRejectEvent.blockingOrderId || '')}`
        : undefined;
      const offerRejectedWithoutFill = rejectEvents.length > 0 && tradeEvents.length === 0;
      if (offerRejectedWithoutFill) {
        const rejectReasons = rejectEvents.map((event) => event.reason).filter(Boolean).join(', ');
        console.warn(
          `⚠️ ORDERBOOK REJECT: offer=${offer.offerId} account=${currentAccountId.slice(-8)} side=${side} price=${priceTicks.toString()} qty=${qtyLots.toString()} bestBid=${String(bestBid)} bestAsk=${String(bestAsk)} reason=${rejectReasons || 'unknown'}`,
        );
        if (debugRebuildProjectionOnly) {
          recordDebugProjectionReject(currentAccountId, offer.offerId, `post-only-reject:${rejectReasons || 'unknown'}`);
          continue;
        }
        if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, currentAccountId, {
          offerId: offer.offerId,
          fillRatio: 0,
          cancelRemainder: true,
          ...(resolveComment ? { comment: resolveComment } : {}),
        })) {
          orderbookLog.debug('resolve.queued_cancel_reject', { offer: shortOrder(offer.offerId, 8), account: shortId(currentAccountId, 8) });
        }
        continue;
      }

      if (debugRebuildProjectionOnly) {
        continue;
      }

      // Process trade events
      const fillsPerOrder = new Map<string, {
        filledLots: number;
        originalLots: number;
        weightedCost: bigint;
      }>();

      for (const event of tradeEvents) {
        const extractOfferId = (namespacedId: string) => {
          const lastColon = namespacedId.lastIndexOf(':');
          return lastColon >= 0 ? namespacedId.slice(lastColon + 1) : namespacedId;
        };
        const tradeCost = event.price * BigInt(event.qty);

        const makerEntry = fillsPerOrder.get(event.makerOrderId);
        if (!makerEntry) {
          fillsPerOrder.set(event.makerOrderId, {
            filledLots: event.qty,
            originalLots: event.makerQtyBefore,
            weightedCost: tradeCost,
          });
        } else {
          makerEntry.filledLots += event.qty;
          makerEntry.weightedCost += tradeCost;
        }

        const takerEntry = fillsPerOrder.get(event.takerOrderId);
        if (!takerEntry) {
          fillsPerOrder.set(event.takerOrderId, {
            filledLots: event.qty,
            originalLots: event.takerQtyTotal,
            weightedCost: tradeCost,
          });
        } else {
          takerEntry.filledLots += event.qty;
          takerEntry.weightedCost += tradeCost;
        }

        orderbookLog.debug('trade', {
          maker: shortOrder(extractOfferId(event.makerOrderId)),
          taker: shortOrder(extractOfferId(event.takerOrderId)),
          price: event.price.toString(),
          qty: event.qty,
        });
      }

      // Emit swap_resolve for each filled order
      for (const [namespacedOrderId, { filledLots, originalLots, weightedCost }] of fillsPerOrder) {
      // Parse namespacedOrderId format: "counterpartyId:offerId"
      // counterpartyId is the Map key used to store the account
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(`ORDERBOOK_FILL_LOOKUP_FAILED: malformed namespacedOrderId=${namespacedOrderId}`);
      }
      const offerId = namespacedOrderId.slice(lastColon + 1);
      const accountId = namespacedOrderId.slice(0, lastColon);
      if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, accountId, offerId)) {
        continue;
      }

      // Verify account exists in hub's state
      if (HEAVY_LOGS) {
        orderbookLog.trace('lookup', {
          account: shortId(accountId, 8),
          known: Array.from(hubState.accounts.keys()).map((id) => shortId(id, 8)),
          found: hubState.accounts.has(accountId),
        });
      }
      if (!hubState.accounts.has(accountId)) {
        throw new Error(
          `ORDERBOOK_ACCOUNT_LOOKUP_FAILED: offer=${offerId} accountId=${accountId} ` +
          `known=[${Array.from(hubState.accounts.keys()).join(',')}]`,
        );
      }
      orderbookLog.debug('lookup.found', { account: shortId(accountId, 8), offer: shortOrder(offerId, 8) });

      const filledBig = BigInt(filledLots);
      const isCurrentTakerOrder = namespacedOrderId === currentNamespacedOrderId;
      if (filledBig <= 0n || weightedCost <= 0n) {
        throw new Error(
          `ORDERBOOK_FILL_LOOKUP_FAILED: invalid fill aggregate weightedCost=${weightedCost.toString()} filledLots=${filledBig.toString()}`,
        );
      }
      if (!isCurrentTakerOrder && weightedCost % filledBig !== 0n) {
        throw new Error(
          `ORDERBOOK_FILL_LOOKUP_FAILED: non-integral resting price weightedCost=${weightedCost.toString()} filledLots=${filledBig.toString()}`,
        );
      }
      const executionBaseWei = filledBig * SWAP_LOT_SCALE;
      const executionQuoteWei = (weightedCost * SWAP_LOT_SCALE) / ORDERBOOK_PRICE_SCALE;

      const account = hubState.accounts.get(accountId);
      const swapOffer = account?.swapOffers?.get(offerId);
      const restingPriceTicks = weightedCost / filledBig;
      const offerForExecution = isCurrentTakerOrder
        ? {
            giveTokenId: offer.giveTokenId,
            wantTokenId: offer.wantTokenId,
            giveAmount: offer.giveAmount,
            wantAmount: offer.wantAmount,
            quantizedGive: offer.giveAmount,
            quantizedWant: offer.wantAmount,
            priceTicks: offer.priceTicks,
          }
        : swapOffer
          ? materializeCanonicalRestingOffer(
              swapOffer.giveTokenId,
              swapOffer.wantTokenId,
              restingPriceTicks,
              originalLots,
            )
          : synthesizeOfferFromMissingBookLookup(side, base, quote, originalLots, filledLots, weightedCost);
      const orderStillInBook = getBookOrder(book, namespacedOrderId) !== null;
      const offerSource = isCurrentTakerOrder
        ? 'current-taker-offer'
        : swapOffer
          ? 'canonical-book-state'
          : 'synthesized-from-book-fill';
      const resolveData = buildSwapResolveDataFromOrderbookFill(
        offerForExecution,
        executionBaseWei,
        executionQuoteWei,
        !orderStillInBook,
      );

      const resolveEnqueueData: SwapResolveEnqueueData = {
        offerId,
        restingGiveTokenId: offerForExecution.giveTokenId,
        restingWantTokenId: offerForExecution.wantTokenId,
        ...resolveData,
        ...(offerForExecution.priceTicks !== undefined ? { restingPriceTicks: offerForExecution.priceTicks } : {}),
        restingGiveAmount: offerForExecution.giveAmount,
        restingWantAmount: offerForExecution.wantAmount,
        ...(offerForExecution.quantizedGive !== undefined ? { restingQuantizedGive: offerForExecution.quantizedGive } : {}),
        ...(offerForExecution.quantizedWant !== undefined ? { restingQuantizedWant: offerForExecution.quantizedWant } : {}),
        ...(isCurrentTakerOrder && resolveComment ? { comment: resolveComment } : {}),
      };
      if (isCurrentTakerOrder) {
        const takerFeeAmount = calculateSwapTakerFeeAmount(resolveData.executionWantAmount ?? 0n, swapTakerFeeBps);
        if (takerFeeAmount > 0n) {
          resolveEnqueueData.feeTokenId = offerForExecution.wantTokenId;
          resolveEnqueueData.feeAmount = takerFeeAmount;
        }
      }
      if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, accountId, resolveEnqueueData)) {
        orderbookLog.debug('resolve.queued', {
          offer: shortOrder(offerId, 8),
          fillPct: (resolveData.fillRatio / MAX_SWAP_FILL_RATIO * 100).toFixed(1),
          cancel: !orderStillInBook,
          source: offerSource,
        });
      }
      if (shouldLogFullPayloads()) {
        orderbookLog.trace('resolve.payload', {
          accountId,
          offerId,
          namespacedOrderId,
          offerSource,
          side,
          baseTokenId: base,
          quoteTokenId: quote,
          originalLots,
          filledLots,
          weightedCost: weightedCost.toString(),
          executionBaseWei: executionBaseWei.toString(),
          executionQuoteWei: executionQuoteWei.toString(),
          orderStillInBook,
          offerGiveTokenId: offerForExecution.giveTokenId,
          offerWantTokenId: offerForExecution.wantTokenId,
          offerGiveAmount: offerForExecution.giveAmount.toString(),
          offerQuantizedGive: (offerForExecution.quantizedGive ?? offerForExecution.giveAmount).toString(),
        });
      }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      containCurrentOfferPairFailure(bookKey, currentAccountId, offer.offerId, message);
      continue;
    }
  }

  if (pairSweepCount > 0) {
    orderbookLog.debug('pass.summary', { pairSweep: pairSweepCount });
  }

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
