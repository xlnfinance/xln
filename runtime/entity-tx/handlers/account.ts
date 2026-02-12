import type { AccountInput, AccountTx, EntityState, Env, EntityInput, EntityTx, HtlcRoute, AccountMachine } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState, addMessage, addMessages, canonicalAccountKey, getAccountPerspective, emitScopedEvents } from '../../state-helpers';
import { applyCommand, createBook, canonicalPair, deriveSide, type BookState, type OrderbookExtState } from '../../orderbook';
import { HTLC } from '../../constants';
import { formatEntityId, HEAVY_LOGS } from '../../utils';
import { isLeftEntity } from '../../entity-id-utils';
import { batchAddRevealSecret, initJBatch } from '../../j-batch';
import { getDeltaTransformerAddress } from '../../proof-builder';
import { sanitizeBaseFee } from '../../routing/fees';
import { cancelHook as cancelScheduledHook } from '../../entity-crontab';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const findAccountKeyInsensitive = (accounts: Map<string, AccountMachine>, counterpartyId: string): string | null => {
  const target = normalizeEntityRef(counterpartyId);
  for (const key of accounts.keys()) {
    if (normalizeEntityRef(key) === target) return key;
  }
  return null;
};

// === PURE EVENT TYPES ===
// Events returned by handlers, applied by entity orchestrator

export interface MempoolOp {
  accountId: string;
  tx: AccountTx;
}

export interface SwapOfferEvent {
  offerId: string;
  makerIsLeft: boolean;     // Simple boolean (account-level context)
  fromEntity: string;       // Account pair (left entity)
  toEntity: string;         // Account pair (right entity)
  accountId?: string;       // Added by entity handler (Hub's Map key for this account)
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  minFillRatio: number;
}

export interface SwapCancelEvent {
  offerId: string;
  accountId: string;
}

export interface MatchResult {
  mempoolOps: MempoolOp[];       // swap_resolve txs to push
  bookUpdates: {                 // orderbook state mutations
    pairId: string;
    book: BookState;
  }[];
}

export interface AccountHandlerResult {
  newState: EntityState;
  outputs: EntityInput[];
  // Pure events for entity-level orchestration:
  mempoolOps: MempoolOp[];
  swapOffersCreated: SwapOfferEvent[];
  swapOffersCancelled: SwapCancelEvent[];
  // Multi-signer: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute' | 'settlement'; context: string }>;
}

export async function handleAccountInput(state: EntityState, input: AccountInput, env: Env): Promise<AccountHandlerResult> {
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId.slice(-4)} → ${input.toEntityId.slice(-4)}`);
  console.log(`🚀 APPLY accountInput details: height=${input.height}, hasNewFrame=${!!input.newAccountFrame}, hasPrevHanko=${!!input.prevHanko}`);

  // CRITICAL: Don't clone here - state already cloned at entity level (applyEntityTx)
  const newState: EntityState = state;  // Use state directly
  const outputs: EntityInput[] = [];

  // Collect events for entity-level orchestration (pure - no direct mempool mutation)
  const mempoolOps: MempoolOp[] = [];
  const allSwapOffersCreated: SwapOfferEvent[] = [];
  const allSwapOffersCancelled: SwapCancelEvent[] = [];
  // Multi-signer: Collect hashes during processing (not scanning)
  const allHashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [];

  // Get or create account machine (KEY: counterparty ID for simpler lookups)
  // AccountMachine still uses canonical left/right internally
  const counterpartyId = normalizeEntityRef(input.fromEntityId);
  const existingAccountKey = findAccountKeyInsensitive(newState.accounts, counterpartyId);
  let accountMachine = existingAccountKey ? newState.accounts.get(existingAccountKey) : undefined;
  let isNewAccount = false;
  const replayMode = (env as Record<PropertyKey, unknown>)[Symbol.for('xln.runtime.env.replay.mode')] === true;
  if (replayMode) {
    console.log(
      `[REPLAY][ACCOUNT-HANDLER] lookup from=${counterpartyId.slice(-8)} ` +
      `foundKey=${existingAccountKey ? existingAccountKey.slice(-8) : 'none'} ` +
      `accounts=${Array.from(newState.accounts.keys()).map((k) => k.slice(-8)).join(',')}`
    );
  }

  if (!accountMachine) {
    isNewAccount = true;
    console.log(`💳 Creating new account machine for ${counterpartyId.slice(-4)} (counterparty: ${counterpartyId.slice(-4)})`);

    // CONSENSUS FIX: Start with empty deltas (Channel.ts pattern)
    const initialDeltas = new Map();

    // CANONICAL: Sort entities (left < right) for AccountMachine internals (like Channel.ts)
    const leftEntity = isLeftEntity(state.entityId, counterpartyId) ? state.entityId : counterpartyId;
    const rightEntity = isLeftEntity(state.entityId, counterpartyId) ? counterpartyId : state.entityId;

    accountMachine = {
      leftEntity,
      rightEntity,
      mempool: [],
      currentFrame: {
        height: 0,
        // Deterministic account genesis: fixed zero timestamp.
        // First committed account frame carries consensus timestamp.
        timestamp: 0,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: '',
        tokenIds: [],
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
        cooperativeNonce: 0,
        disputeNonce: 0,
      },
      proofBody: {
        tokenIds: [],
        deltas: [],
      },
      frameHistory: [],
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(), // Phase 2: C→R withdrawal tracking
      locks: new Map(), // HTLC: Empty locks map
      swapOffers: new Map(), // Swap: Empty offers map
      // Bilateral J-event consensus
      leftJObservations: [],
      rightJObservations: [],
      jEventChain: [],
      lastFinalizedJHeight: 0,
      // Dispute resolution (delay values * 10 = blocks)
      disputeConfig: {
        leftDisputeDelay: 10,   // 100 blocks
        rightDisputeDelay: 10,  // 100 blocks
      },
      onChainSettlementNonce: 0,
    };

    // Store with counterparty ID as key (simpler than canonical)
    // Type assertion safe: accountMachine was just created above in this block
    newState.accounts.set(counterpartyId, accountMachine as AccountMachine);
    console.log(`✅ Account created with counterparty key: ${counterpartyId.slice(-4)}`);
  }

  if (isNewAccount && input.prevHanko && !input.newAccountFrame) {
    const error = `ACCOUNT_INPUT_ACK_FOR_UNKNOWN_ACCOUNT: from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)}`;
    if (replayMode) {
      console.error(`[REPLAY][ACCOUNT-HANDLER] ${error}`);
    }
    throw new Error(error);
  }

  // FINTECH-SAFETY: Ensure accountMachine exists
  if (!accountMachine) {
    throw new Error(`CRITICAL: AccountMachine creation failed for ${input.fromEntityId}`);
  }

  // NOTE: Credit limits start at 0 - no auto-credit on account opening
  // Credit must be explicitly extended via set_credit_limit transaction

  // === SETTLEMENT WORKSPACE ACTIONS ===
  // Process settleAction before frame consensus (bilateral negotiation)
  if (input.settleAction) {
    const { processSettleAction } = await import('./settle');
    const result = processSettleAction(
      accountMachine,
      input.settleAction,
      input.fromEntityId,
      newState.entityId,
      newState.timestamp // Entity-level timestamp for determinism
    );

    if (result.success) {
      addMessage(newState, `⚖️ ${result.message}`);
    } else {
      console.warn(`⚠️ settleAction failed: ${result.message}`);
      addMessage(newState, `⚠️ Settlement: ${result.message}`);
    }
  }

  // CHANNEL.TS PATTERN: Process frame-level consensus ONLY
  if (input.height !== undefined || input.newAccountFrame) {
    console.log(`🤝 Processing frame from ${input.fromEntityId.slice(-4)}, accountMachine.pendingFrame=${accountMachine.pendingFrame ? `h${accountMachine.pendingFrame.height}` : 'none'}`);

    const result = await processAccountInput(env, accountMachine, input);
    if (replayMode) {
      console.log(
        `[REPLAY][ACCOUNT-HANDLER] result success=${result.success} ` +
        `currentHeight=${accountMachine.currentHeight} pending=${accountMachine.pendingFrame?.height ?? 0} ` +
        `error=${result.error || 'none'}`
      );
    }
    if ((env as Record<PropertyKey, unknown>)[Symbol.for('xln.runtime.env.replay.mode')] === true) {
      console.log(
        `REPLAY_ACCOUNT_RESULT from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)} ` +
        `height=${input.height} newFrame=${input.newAccountFrame?.height ?? 'none'} ` +
        `success=${result.success} error=${result.error || 'none'}`
      );
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
          frameHeight: input.newAccountFrame?.height ?? input.height,
          hasNewFrame: Boolean(input.newAccountFrame),
        },
        newState.entityId,
      );

      // Multi-signer: Collect hashes from result during processing
      if (result.hashesToSign) {
        allHashesToSign.push(...result.hashesToSign);
      }

      // === HTLC LOCK PROCESSING: Check if we need to forward ===
      // CRITICAL: Only process NEW locks (prevent replay on re-processing same frame)
      // Check if this is a NEW frame (just committed) by comparing heights
      const justCommittedFrame = input.newAccountFrame;
      const isNewFrame = Boolean(justCommittedFrame && justCommittedFrame.height > (accountMachine.currentHeight - 1));

      if (isNewFrame && justCommittedFrame?.accountTxs) {
        if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: isNewFrame=${isNewFrame}, inputHeight=${justCommittedFrame.height}, currentHeight=${accountMachine.currentHeight}`);
        if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: accountMachine.locks.size=${accountMachine.locks.size}`);
        if (HEAVY_LOGS) console.log(`🔍 FRAME-TXS: ${justCommittedFrame.accountTxs.length} txs in frame:`, justCommittedFrame.accountTxs.map(tx => tx.type));
        for (const accountTx of justCommittedFrame.accountTxs) {
          if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: Checking committed tx type=${accountTx.type}`);

          // Keep lockBook aligned with finalized account-level HTLC lifecycle.
          if (accountTx.type === 'htlc_resolve') {
            newState.lockBook.delete(accountTx.data.lockId);
            // Cancel any scheduled timeout hook once resolve is finalized in committed frame.
            if (newState.crontabState) {
              cancelScheduledHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
            }
          }

          // === J-EVENT BILATERAL CONSENSUS ===
          if (accountTx.type === 'j_event_claim') {
            const { jHeight, jBlockHash, events, observedAt } = accountTx.data;
            console.log(`📥 j_event_claim: Counterparty claims jHeight=${jHeight}`);

            // Determine which side counterparty is
            const { iAmLeft: weAreLeft, counterparty } = getAccountPerspective(accountMachine, newState.entityId);
            const theyAreLeft = !weAreLeft;

            const obs = { jHeight, jBlockHash, events, observedAt };

            // Store THEIR observation in appropriate array
            if (theyAreLeft) {
              accountMachine.leftJObservations.push(obs);
              console.log(`   📝 Stored LEFT obs from counterparty (${accountMachine.leftJObservations.length} total)`);
            } else {
              accountMachine.rightJObservations.push(obs);
              console.log(`   📝 Stored RIGHT obs from counterparty (${accountMachine.rightJObservations.length} total)`);
            }

            // Try finalize now that we have counterparty's observation
            const { tryFinalizeAccountJEvents } = await import('../j-events');
            tryFinalizeAccountJEvents(accountMachine, counterparty, { timestamp: newState.timestamp });

            continue; // Move to next tx
          }

          if (accountTx.type === 'swap_resolve' || accountTx.type === 'swap_cancel') {
            const key = `${counterpartyId}:${accountTx.data.offerId}`;
            if (newState.pendingSwapFillRatios?.delete(key)) {
              console.log(`📉 Cleared pending fillRatio for ${key.slice(-12)}`);
            }
          }

          if (accountTx.type === 'htlc_lock') {
            if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: Found htlc_lock in committed frame!`);
            const lock = accountMachine.locks.get(accountTx.data.lockId);
            if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: lock found? ${!!lock}`);
            if (!lock) {
              console.log(`❌ HTLC-CHECK: Lock not in accountMachine.locks (lockId=${accountTx.data.lockId.slice(0,16)}...)`);
              continue;
            }

            // Check envelope (onion routing)
            if (!lock.envelope) {
              console.log(`⏭️ HTLC: No envelope, skipping forwarding`);
              continue;
            }

            let envelope = lock.envelope;
            console.log(`🧅 ═════════════════════════════════════════════════════════════`);
            console.log(`🧅 ENVELOPE RECEIVED at ${newState.entityId.slice(-4)}`);
            console.log(`🧅 LockId: ${lock.lockId.slice(0,16)}...`);
            console.log(`🧅 Hashlock: ${lock.hashlock.slice(0,16)}...`);
            console.log(`🧅 Amount: ${lock.amount}`);
            console.log(`🧅 Envelope type: ${typeof envelope}`);
            if (typeof envelope !== 'string') {
              console.log(`🧅 OUTER envelope: finalRecipient=${envelope.finalRecipient}, nextHop=${envelope.nextHop?.slice(-4)}`);
            }
            console.log(`🧅 OUTER envelope structure: ${JSON.stringify(envelope, null, 2).slice(0, 300)}...`);

            // CRITICAL: For onion routing, envelope can be:
            // 1. A string (encrypted payload for THIS hop - decrypt it directly)
            // 2. An object with innerEnvelope (THIS hop's plaintext instructions with encrypted payload for NEXT hop)

            // Case 1: Envelope is a string (encrypted FOR us)
            if (typeof envelope === 'string') {
              console.log(`🔓 Envelope is encrypted string - decrypting for us...`);
              try {
                let envelopeData: string = envelope;

                // Decrypt if encrypted (base64), or use cleartext (JSON starts with '{')
                const isCleartext1 = envelopeData.trimStart().startsWith('{');
                if (newState.cryptoPrivateKey && !isCleartext1) {
                  const { NobleCryptoProvider } = await import('../../crypto-noble');
                  const crypto = new NobleCryptoProvider();
                  envelopeData = await crypto.decrypt(envelope as string, newState.cryptoPrivateKey);
                  console.log(`🔓 Decryption successful`);
                } else if (isCleartext1) {
                  console.log(`🔓 Envelope is cleartext JSON — skipping decrypt`);
                }

                // Unwrap decrypted envelope
                const { unwrapEnvelope } = await import('../../htlc-envelope-types');
                envelope = unwrapEnvelope(envelopeData);
                console.log(`🔓 Unwrapped envelope: finalRecipient=${envelope.finalRecipient}, nextHop=${envelope.nextHop?.slice(-4)}`);
                console.log(`🔓 Decrypted envelope structure: ${JSON.stringify(envelope, null, 2).slice(0, 300)}...`);
              } catch (e) {
                console.log(`❌ HTLC-GATE: ENVELOPE_DECRYPT_FAIL - ${e instanceof Error ? e.message : String(e)} [lockId=${lock.lockId.slice(0,16)}]`);
                env.error('network', 'ENVELOPE_DECRYPT_FAIL', {
                  lockId: lock.lockId,
                  reason: e instanceof Error ? e.message : String(e),
                  fromEntityId: input.fromEntityId,
                  toEntityId: input.toEntityId,
                }, state.entityId);
                console.log(`🧅 ═════════════════════════════════════════════════════════════`);
                continue;
              }
            }
            // Case 2: Envelope has innerEnvelope (plaintext wrapper)
            else if (envelope.innerEnvelope && !envelope.finalRecipient) {
              console.log(`🔓 Decrypting innerEnvelope to get routing instructions...`);
              try {
                let envelopeData = envelope.innerEnvelope;

                // Decrypt if encrypted (base64), or use cleartext (JSON starts with '{')
                const isCleartext2 = envelopeData.trimStart().startsWith('{');
                if (newState.cryptoPrivateKey && !isCleartext2) {
                  const { NobleCryptoProvider } = await import('../../crypto-noble');
                  const crypto = new NobleCryptoProvider();
                  envelopeData = await crypto.decrypt(envelope.innerEnvelope, newState.cryptoPrivateKey);
                  console.log(`🔓 Decryption successful`);
                } else if (isCleartext2) {
                  console.log(`🔓 InnerEnvelope is cleartext JSON — skipping decrypt`);
                }

                // Unwrap decrypted envelope - THIS is our actual routing instruction
                const { unwrapEnvelope } = await import('../../htlc-envelope-types');
                envelope = unwrapEnvelope(envelopeData);
                console.log(`🔓 Unwrapped envelope: finalRecipient=${envelope.finalRecipient}, nextHop=${envelope.nextHop?.slice(-4)}`);
                console.log(`🔓 Decrypted envelope structure: ${JSON.stringify(envelope, null, 2).slice(0, 300)}...`);
              } catch (e) {
                console.log(`❌ HTLC-GATE: ENVELOPE_DECRYPT_FAIL - ${e instanceof Error ? e.message : String(e)} [lockId=${lock.lockId.slice(0,16)}]`);
                env.error('network', 'ENVELOPE_DECRYPT_FAIL', {
                  lockId: lock.lockId,
                  reason: e instanceof Error ? e.message : String(e),
                  fromEntityId: input.fromEntityId,
                  toEntityId: input.toEntityId,
                }, state.entityId);
                console.log(`🧅 ═════════════════════════════════════════════════════════════`);
                continue;
              }
            }

            // Validate envelope structure (safety check)
            const { validateEnvelope } = await import('../../htlc-envelope-types');
            try {
              validateEnvelope(envelope);
              console.log(`🧅 Envelope validation: PASSED`);
            } catch (e) {
              console.log(`❌ HTLC: Invalid envelope structure: ${e instanceof Error ? e.message : String(e)}`);
              console.log(`🧅 ═════════════════════════════════════════════════════════════`);
              continue;
            }

            // CRITICAL: Verify envelope matches HTLC lock (prevent replay/manipulation)
            // This is "verify-after-decrypt" pattern - simpler than AAD
            // The envelope MUST match the lock that carries it
            if (lock.amount.toString() !== accountTx.data.amount.toString()) {
              console.log(`❌ HTLC: Envelope amount mismatch: lock=${lock.amount}, tx=${accountTx.data.amount}`);
              console.log(`🧅 ═════════════════════════════════════════════════════════════`);
              continue;
            }
            if (lock.tokenId !== accountTx.data.tokenId) {
              console.log(`❌ HTLC: Envelope tokenId mismatch: lock=${lock.tokenId}, tx=${accountTx.data.tokenId}`);
              console.log(`🧅 ═════════════════════════════════════════════════════════════`);
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
              console.log(`🧅 ═════════════════════════════════════════════════════════════`);
              continue;
            }
            console.log(`✅ HTLC: Envelope verified - matches lock parameters (amount, tokenId, hashlock)`);

            // For intermediary hops, verify nextHop is a valid entity
            if (envelope.nextHop && !envelope.finalRecipient) {
              // Check if we have an account with nextHop (can forward)
              const hasNextHopAccount = newState.accounts.has(envelope.nextHop);
              if (!hasNextHopAccount) {
                console.log(`❌ HTLC: Cannot forward - no account with nextHop ${envelope.nextHop.slice(-4)}`);
                console.log(`❌ HTLC: Available accounts: [${Array.from(newState.accounts.keys()).map(k => k.slice(-4)).join(', ')}]`);
                console.log(`🧅 ═════════════════════════════════════════════════════════════`);
                continue;
              }
              console.log(`✅ HTLC: NextHop ${envelope.nextHop.slice(-4)} validated - account exists`);
            }

            // Are we the final recipient?
            if (envelope.finalRecipient) {
              console.log(`🎯 HTLC-ROUTING: WE ARE FINAL RECIPIENT!`);
              // Final recipient - reveal immediately
              if (envelope.secret) {
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
                console.log(`🎯 HTLC: Final recipient, revealing secret=${envelope.secret.slice(0,16)}...`);
                console.log(`🧅 ═════════════════════════════════════════════════════════════`);
              } else {
                console.log(`❌ HTLC: Final recipient envelope missing secret!`);
                console.log(`🧅 ═════════════════════════════════════════════════════════════`);
              }
            } else if (envelope.nextHop) {
              // Intermediary - forward to next hop
              const nextHop = envelope.nextHop;
              console.log(`➡️ HTLC-ROUTING: INTERMEDIARY HOP`);
              console.log(`➡️ Forwarding to: ${nextHop.slice(-4)}`);

              // Register route for backward propagation
              const inboundEntity = newState.entityId === accountMachine.leftEntity
                ? accountMachine.rightEntity
                : accountMachine.leftEntity;

              console.log(`➡️ Registering route: ${inboundEntity.slice(-4)} → ${newState.entityId.slice(-4)} → ${nextHop.slice(-4)}`);

              // Create route object (typed as HtlcRoute for pendingFee)
              const htlcRoute: HtlcRoute = {
                hashlock: lock.hashlock,
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
                console.log(`❌ HTLC-CANCEL: Cancelling inbound lock, reason=${cancelReason}`);
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
                const localProfile = env.gossip?.getProfiles?.()?.find((p: any) =>
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
                console.log(`📦 Inner envelope for next hop: ${innerEnvelope ? 'present' : 'missing'}`);

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
                console.log(`➡️ HTLC-FORWARD: Creating outbound lock`);
                console.log(`➡️ Outbound lockId: ${lock.lockId}-fwd`);
                console.log(`➡️ Amount: ${lock.amount} → ${forwardAmount} (fee=${feeAmount})`);
                console.log(`➡️ Timelock: ${lock.timelock} → ${forwardTimelock}`);
                console.log(`➡️ Height: ${lock.revealBeforeHeight} → ${forwardHeight}`);
                console.log(`➡️ Inner envelope: ${innerEnvelope ? JSON.stringify(innerEnvelope, null, 2).slice(0, 200) : 'NONE'}...`);

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
                console.log(`🧅 ═════════════════════════════════════════════════════════════`);

                console.log(`➡️ HTLC: Forwarding to ${nextHop.slice(-4)}, amount ${forwardAmount} (fee ${feeAmount})`);
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
        console.log(`💸 ═════════════════════════════════════════════════════════════`);
        console.log(`💸 PROCESSING PENDING-FORWARD at ${state.entityId.slice(-4)}`);
        console.log(`💸 Amount: ${forward.amount}, TokenId: ${forward.tokenId}`);
        console.log(`💸 Route: [${forward.route.map(r => r.slice(-4)).join(',')}]`);
        console.log(`💸 Description: ${forward.description || 'none'}`);

        const nextHop = forward.route.length > 1 ? forward.route[1] : null;

        if (nextHop) {
          console.log(`💸 Next hop: ${nextHop.slice(-4)}`);
          const nextHopAccountKey = nextHop; // counterparty ID is key
          const nextHopAccount = newState.accounts.get(nextHopAccountKey);
          if (nextHopAccount) {
            // Forward full amount (no fees for simplicity)
            const forwardAmount = forward.amount;

            console.log(`💸 FORWARDING TO NEXT HOP`);
            console.log(`💸   Creating direct_payment AccountTx`);
            console.log(`💸   Amount: ${forwardAmount}`);
            console.log(`💸   From: ${state.entityId.slice(-4)}`);
            console.log(`💸   To: ${nextHop.slice(-4)}`);
            console.log(`💸   Route: [${forward.route.slice(1).map(r => r.slice(-4)).join(',')}]`);

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

            console.log(`💸 FORWARD QUEUED: mempoolOps.length=${mempoolOps.length}`);
            console.log(`💸 ═════════════════════════════════════════════════════════════`);
          } else {
            console.log(`❌ No account found for next hop ${nextHop.slice(-4)}`);
            console.log(`💸 ═════════════════════════════════════════════════════════════`);
          }
        } else {
          console.log(`❌ No next hop in forward route`);
          console.log(`💸 ═════════════════════════════════════════════════════════════`);
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
            env.emit('PaymentFailed', {
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

      if (revealedSecrets.length > 0) {
        if (!newState.jBatchState) {
          newState.jBatchState = initJBatch();
        }
        const transformerAddress = getDeltaTransformerAddress();
        if (transformerAddress === '0x0000000000000000000000000000000000000000') {
          console.warn('⚠️ HTLC: DeltaTransformer address not set - skipping on-chain reveal');
        } else {
          for (const { secret } of revealedSecrets) {
            batchAddRevealSecret(newState.jBatchState, transformerAddress, secret);
          }
        }
      }

      for (const { secret, hashlock } of revealedSecrets) {
        if (HEAVY_LOGS) console.log(`🔍 HTLC-SECRET: Processing revealed secret for hash ${hashlock.slice(0,16)}...`);
        const route = newState.htlcRoutes.get(hashlock);
        if (route) {
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
            console.log(`⬅️ HTLC: Propagating secret to ${route.inboundEntity.slice(-4)}`);
          } else {
            console.log(`✅ HTLC: Payment complete (we initiated)`);
          }
          env.emit('PaymentFinalized', {
            hashlock,
            secret,
            inboundEntity: route.inboundEntity,
            outboundEntity: route.outboundEntity,
            entityId: state.entityId,
          });
        } else {
          console.log(`⚠️ HTLC: No route found for hashlock ${hashlock.slice(0,16)}...`);
        }
      }

      // === COLLECT SWAP EVENTS (deferred to entity-level orchestration) ===
      const swapOffersCreated = result.swapOffersCreated || [];
      if (swapOffersCreated.length > 0) {
        console.log(`📊 SWAP-EVENTS: Collected ${swapOffersCreated.length} swap offers for entity-level matching`);
        allSwapOffersCreated.push(...swapOffersCreated);
      }

      const swapOffersCancelled = result.swapOffersCancelled || [];
      if (swapOffersCancelled.length > 0) {
        console.log(`📊 SWAP-EVENTS: Collected ${swapOffersCancelled.length} swap cancels`);
        allSwapOffersCancelled.push(...swapOffersCancelled);
        // Update E-Machine swapBook immediately (this is entity state, not mempool)
        // AUDIT FIX (CRITICAL-6): Use namespaced key for swapBook delete
        for (const { offerId, accountId } of swapOffersCancelled) {
          const swapBookKey = `${accountId}:${offerId}`;
          newState.swapBook.delete(swapBookKey);
        }
      }

      // Send response (ACK + optional new frame)
      if (result.response) {
        console.log(`📤 Sending response to ${result.response.toEntityId.slice(-4)}`);

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

        console.log(`✅ ACK-RESPONSE queued: ${state.entityId.slice(-4)} → ${result.response.toEntityId.slice(-4)}, height=${result.response.height}, hasPrevHanko=${!!result.response.prevHanko}`);
      }
    } else {
      console.error(`❌ Frame consensus failed: ${result.error}`);
      addMessage(newState, `❌ ${result.error}`);
      env.emit('PaymentFailed', {
        entityId: state.entityId,
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
        reason: result.error || 'unknown',
      });
      env.error('consensus', 'FRAME_CONSENSUS_FAILED', {
        reason: result.error || 'unknown',
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
      }, state.entityId);
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
  swapOffers: SwapOfferEvent[]
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, bookUpdates };

  // AUDIT FIX (CRITICAL-5): Cache book updates within batch to avoid stale snapshots
  // Without this, same-tick offers don't see each other's fills
  const bookCache = new Map<string, BookState>();

  for (const offer of swapOffers) {
    // Use accountId enriched by entity handler (already has correct counterparty ID)
    const accountId = offer.accountId!;
    console.log(`📊 ORDERBOOK-PROCESS: offerId=${offer.offerId}, accountId=${accountId.slice(-8)}`);

    const { pairId } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const bookKey = pairId;

    const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
    // LOT_SCALE = 10^12: Orderbook works in lots for uint32 efficiency
    // For 18-decimal tokens: 1 lot = 10^12 wei = 0.000001 tokens
    // This allows up to ~4.2M lots per order (uint32 max), sufficient for most trades
    // NOTE (MEDIUM-1): Amounts below LOT_SCALE will be truncated to 0 lots and rejected
    // This is acceptable: sub-$0.001 orders at typical ETH prices are uneconomical anyway
    const LOT_SCALE = 10n ** 12n;
    const MAX_LOTS = 0xFFFFFFFFn;

    let priceTicks: bigint;
    let qtyLots: bigint;
    let quantizedGive: bigint;
    let quantizedWant: bigint;

    if (side === 1) {
      const baseAmount = offer.giveAmount;
      if (baseAmount % LOT_SCALE !== 0n) {
        console.warn(`⚠️ ORDERBOOK: giveAmount not aligned to LOT_SCALE — skipping offer=${offer.offerId}, amount=${baseAmount}`);
        continue;
      }
      priceTicks = (offer.wantAmount * 100n) / offer.giveAmount;
      qtyLots = baseAmount / LOT_SCALE;
      quantizedGive = baseAmount;
      quantizedWant = (quantizedGive * priceTicks) / 100n;
    } else {
      const baseAmount = offer.wantAmount;
      if (baseAmount % LOT_SCALE !== 0n) {
        console.warn(`⚠️ ORDERBOOK: wantAmount not aligned to LOT_SCALE — skipping offer=${offer.offerId}, amount=${baseAmount}`);
        continue;
      }
      priceTicks = (offer.giveAmount * 100n) / offer.wantAmount;
      qtyLots = baseAmount / LOT_SCALE;
      quantizedWant = baseAmount;
      quantizedGive = (quantizedWant * priceTicks) / 100n;
    }

    if (qtyLots === 0n || qtyLots > MAX_LOTS || priceTicks <= 0n || priceTicks > MAX_LOTS) {
      console.warn(`⚠️ ORDERBOOK: Invalid order — skipping offer=${offer.offerId}, qty=${qtyLots}, price=${priceTicks}`);
      continue;
    }

    const account = hubState.accounts.get(accountId);
    const accountOffer = account?.swapOffers?.get(offer.offerId);
    if (accountOffer) {
      accountOffer.quantizedGive = quantizedGive;
      accountOffer.quantizedWant = quantizedWant;
    }

    // AUDIT FIX (CRITICAL-5): Use cached book if available, otherwise load from ext.books
    let book = bookCache.get(bookKey) || ext.books.get(bookKey);
    if (!book) {
      const BOOK_LEVELS = 100;
      const PRICE_TICK = 1000;
      const center = Number(priceTicks);
      const halfRange = PRICE_TICK * Math.floor(BOOK_LEVELS / 2);
      const pmin = Math.max(1, center - halfRange);
      const pmax = pmin + PRICE_TICK * (BOOK_LEVELS - 1);

      book = createBook({
        tick: PRICE_TICK,
        pmin,
        pmax,
        maxOrders: 10000,
        stpPolicy: 0,
      });
    }

    const makerId = offer.makerIsLeft ? offer.fromEntity : offer.toEntity;
    const namespacedOrderId = `${accountId}:${offer.offerId}`;
    console.log(`📊 ORDERBOOK ADD: maker=${formatEntityId(makerId)}, orderId=${namespacedOrderId.slice(-20)}, side=${side}, price=${priceTicks}, qty=${qtyLots}`);

    const result = applyCommand(book, {
      kind: 0,
      ownerId: makerId,
      orderId: namespacedOrderId,
      side,
      tif: 0,
      postOnly: false,
      priceTicks: Number(priceTicks),
      qtyLots: Number(qtyLots),
      minFillRatio: offer.minFillRatio ?? 0,
    });

    book = result.state;
    // AUDIT FIX (CRITICAL-5): Cache updated book for next offer in same batch
    bookCache.set(bookKey, book);
    bookUpdates.push({ pairId: bookKey, book });

    // Process trade events
    const fillsPerOrder = new Map<string, { filledLots: number; originalLots: number }>();

    for (const event of result.events) {
      if (event.type === 'TRADE') {
        const extractOfferId = (namespacedId: string) => {
          const lastColon = namespacedId.lastIndexOf(':');
          return lastColon >= 0 ? namespacedId.slice(lastColon + 1) : namespacedId;
        };

        const makerEntry = fillsPerOrder.get(event.makerOrderId);
        if (!makerEntry) {
          fillsPerOrder.set(event.makerOrderId, { filledLots: event.qty, originalLots: event.makerQtyBefore });
        } else {
          makerEntry.filledLots += event.qty;
        }

        const takerEntry = fillsPerOrder.get(event.takerOrderId);
        if (!takerEntry) {
          fillsPerOrder.set(event.takerOrderId, { filledLots: event.qty, originalLots: event.takerQtyTotal });
        } else {
          takerEntry.filledLots += event.qty;
        }

        console.log(`📊 ORDERBOOK TRADE: ${extractOfferId(event.makerOrderId)} ↔ ${extractOfferId(event.takerOrderId)} @ ${event.price}, qty=${event.qty}`);
      }
    }

    // Emit swap_resolve for each filled order
    const MAX_FILL_RATIO = 65535;

    for (const [namespacedOrderId, { filledLots, originalLots }] of fillsPerOrder) {
      // Parse namespacedOrderId format: "counterpartyId:offerId"
      // counterpartyId is the Map key used to store the account
      const lastColon = namespacedOrderId.lastIndexOf(':');
      if (lastColon === -1) continue;
      const offerId = namespacedOrderId.slice(lastColon + 1);
      const accountId = namespacedOrderId.slice(0, lastColon);

      // Verify account exists in hub's state
      if (HEAVY_LOGS) console.log(`🔍 ORDERBOOK-LOOKUP: Looking for accountId="${accountId}"`);
      if (HEAVY_LOGS) console.log(`🔍 ORDERBOOK-LOOKUP: Hub accounts:`, Array.from(hubState.accounts.keys()));
      if (HEAVY_LOGS) console.log(`🔍 ORDERBOOK-LOOKUP: Match found:`, hubState.accounts.has(accountId));
      if (!hubState.accounts.has(accountId)) {
        console.warn(`⚠️ ORDERBOOK: Account not found for swap_resolve, skipping`);
        console.warn(`   Looking for: "${accountId}"`);
        console.warn(`   Hub has: ${Array.from(hubState.accounts.keys()).map(k => `"${k}"`).join(', ')}`);
        continue;
      }
      console.log(`✅ ORDERBOOK-LOOKUP: Found account for ${accountId.slice(-8)}, generating swap_resolve`);

      const filledBig = BigInt(filledLots);
      const originalBig = BigInt(originalLots);
      const fillRatio = originalBig > 0n
        ? Number((filledBig * BigInt(MAX_FILL_RATIO)) / originalBig)
        : 0;

      const orderStillInBook = book.orderIdToIdx.has(namespacedOrderId) &&
        book.orderActive[book.orderIdToIdx.get(namespacedOrderId)!];

      mempoolOps.push({
        accountId,
        tx: {
          type: 'swap_resolve',
          data: {
            offerId,
            fillRatio: Math.min(fillRatio, MAX_FILL_RATIO),
            cancelRemainder: !orderStillInBook,
          }
        }
      });
      console.log(`📤 ORDERBOOK: Queued swap_resolve for ${offerId.slice(-8)}, fill=${(fillRatio/MAX_FILL_RATIO*100).toFixed(1)}%, cancel=${!orderStillInBook}`);
    }
  }

  return { mempoolOps, bookUpdates };
}

/**
 * Process swap cancels through hub's orderbook
 */
export function processOrderbookCancels(
  hubState: EntityState,
  cancels: SwapCancelEvent[]
): { pairId: string; book: BookState }[] {
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return bookUpdates;

  for (const { offerId, accountId } of cancels) {
    const namespacedOrderId = `${accountId}:${offerId}`;

    for (const [bookKey, book] of ext.books) {
      const maybeOrderIdx = book.orderIdToIdx.get(namespacedOrderId);
      if (maybeOrderIdx === undefined) continue;
      const orderIdx: number = maybeOrderIdx;
      if (!book.orderActive[orderIdx]) continue;
      const ownerIdx = book.orderOwnerIdx[orderIdx] as number;
      const ownerId = book.owners[ownerIdx];
      if (!ownerId) continue; // Skip if owner not found

      const result = applyCommand(book, {
        kind: 1,  // CANCEL command - only needs ownerId and orderId
        ownerId,
        orderId: namespacedOrderId,
      });

      bookUpdates.push({ pairId: bookKey, book: result.state });
      console.log(`📊 ORDERBOOK: Cancelled order ${offerId.slice(-8)}`);
      break;
    }
  }

  return bookUpdates;
}
