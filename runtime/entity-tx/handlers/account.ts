import type { AccountInput, EntityState, Env, EntityInput, HtlcRoute, AccountMachine, HtlcNoteKey } from '../../types';
import { markStorageAccountDirty, markStorageEntityDirty } from '../../env-events';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { addMessage, addMessages, emitScopedEvents } from '../../state-helpers';
import { HTLC } from '../../constants';
import { HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortId } from '../../logger';
import { isLeftEntity } from '../../entity-id-utils';
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
import { assertSameJurisdictionAccount } from '../../jurisdiction-runtime';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from './account-cross-j-followups';
import { applyCommittedAccountFrameFollowups } from './account/committed-frame-followups';
import type { MempoolOp } from './account/orderbook-queue';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from './account/orderbook-offers';

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
