import type { AccountFrame, AccountInput, AccountTx, EntityState, Env, EntityInput, EntityTx, HtlcRoute, AccountMachine, HtlcNoteKey } from '../../types';
import { handleAccountInput as processAccountInput } from '../../account-consensus';
import { cloneEntityState, addMessage, addMessages, canonicalAccountKey, getAccountPerspective, emitScopedEvents } from '../../state-helpers';
import {
  applyCommand,
  createBook,
  canonicalPair,
  computeSwapPriceTicks,
  deriveSide,
  getBestAsk,
  getBestBid,
  ORDERBOOK_PRICE_SCALE,
  requantizeRemainingSwapAtPrice,
  SWAP_LOT_SCALE,
  type BookState,
  type OrderbookExtState,
} from '../../orderbook';
import { HTLC, SWAP as SWAP_CONSTANTS } from '../../constants';
import { getSwapPairPolicyByBaseQuote } from '../../account-utils';
import { formatEntityId, HEAVY_LOGS } from '../../utils';
import { isLeftEntity } from '../../entity-id-utils';
import {
  buildSwapResolveDataFromOrderbookFill,
  compareCanonicalText,
  MAX_SWAP_FILL_RATIO,
  type NormalizedOrderbookOffer,
  swapKey,
} from '../../swap-execution';
import { sanitizeBaseFee } from '../../routing/fees';
import {
  cancelHook as cancelScheduledHook,
  scheduleHook as scheduleCrontabHook,
  HTLC_SECRET_ACK_TIMEOUT_MS,
} from '../../entity-crontab';
import { NobleCryptoProvider } from '../../crypto-noble';
import { unwrapEnvelope, validateEnvelope } from '../../htlc-envelope-types';
import { terminateHtlcRoute } from '../htlc-route-lifecycle';
import {
  buildHtlcFinalizedEventPayload,
  buildHtlcReceivedEventPayload,
} from '../../htlc-events';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const getJurisdictionId = (state: EntityState, env: Env): string => {
  return String(state.config?.jurisdiction?.name || env.activeJurisdiction || '').trim();
};

export function applyCommittedAccountFrameFollowups(
  newState: EntityState,
  counterpartyId: string,
  committedFrame: AccountFrame,
): void {
  if (HEAVY_LOGS) {
    console.log(
      `🔍 FRAME-COMMIT-FOLLOWUPS: height=${committedFrame.height}, txs=${committedFrame.accountTxs.length}`,
    );
  }

  for (const accountTx of committedFrame.accountTxs) {
    if (HEAVY_LOGS) console.log(`🔍 FRAME-COMMIT-FOLLOWUPS: tx type=${accountTx.type}`);

    // Keep lockBook aligned with finalized account-level HTLC lifecycle.
    if (accountTx.type === 'htlc_resolve') {
      newState.lockBook.delete(accountTx.data.lockId);
      if (newState.crontabState) {
        cancelScheduledHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
      }
      if (accountTx.data.outcome === 'secret') {
        for (const [hashlock, route] of newState.htlcRoutes.entries()) {
          if (route.inboundLockId !== accountTx.data.lockId) continue;
          console.log(`✅ HTLC: secret ACK confirmed for hashlock ${route.hashlock.slice(0, 16)}...`);
          terminateHtlcRoute(newState, hashlock, newState.timestamp);
        }
      }
    }

    if (accountTx.type === 'j_event_claim') continue;

    if (accountTx.type === 'swap_resolve') {
      const key = swapKey(counterpartyId, accountTx.data.offerId);
      if (newState.pendingSwapFillRatios?.delete(key)) {
        console.log(`📉 Cleared pending fillRatio for ${key.slice(-12)}`);
      }
    }
  }
}

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
  createdHeight?: number;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  priceTicks?: bigint;
  timeInForce?: 0 | 1 | 2;
  minFillRatio: number;
}

export interface SwapCancelEvent {
  offerId: string;
  accountId: string;
}

export interface SwapCancelRequestEvent {
  offerId: string;
  accountId: string;
}

export interface MatchResult {
  mempoolOps: MempoolOp[];       // swap_resolve txs to push
  bookUpdates: {                 // orderbook state mutations
    pairId: string;
    book: BookState;
  }[];
  quarantinedOffers: Array<{
    offerId: string;
    accountId: string;
    reason: string;
  }>;
}

type OrderbookProcessOptions = {
  rehydrateOnly?: boolean;
};

export const normalizeSwapOfferForOrderbook = (
  offer: SwapOfferEvent,
  accountId: string,
): NormalizedOrderbookOffer => {
  const priceTicks = typeof offer.priceTicks === 'bigint' && offer.priceTicks > 0n
    ? offer.priceTicks
    : computeSwapPriceTicks(
        offer.giveTokenId,
        offer.wantTokenId,
        offer.giveAmount,
        offer.wantAmount,
      );
  if (priceTicks <= 0n) {
    throw new Error(`ORDERBOOK_NORMALIZE_INVALID_PRICE: offer=${offer.offerId}`);
  }

  return {
    offerId: String(offer.offerId),
    accountId: String(accountId),
    makerIsLeft: !!offer.makerIsLeft,
    fromEntity: String(offer.fromEntity),
    toEntity: String(offer.toEntity),
    createdHeight: Number(offer.createdHeight ?? 0),
    giveTokenId: Number(offer.giveTokenId),
    giveAmount: BigInt(offer.giveAmount),
    wantTokenId: Number(offer.wantTokenId),
    wantAmount: BigInt(offer.wantAmount),
    priceTicks,
    timeInForce: offer.timeInForce ?? 0,
    minFillRatio: Number(offer.minFillRatio ?? 0),
  };
};

export const compareSwapOffersForOrderbook = (left: NormalizedOrderbookOffer, right: NormalizedOrderbookOffer): number => {
  const leftHeight = left.createdHeight;
  const rightHeight = right.createdHeight;
  if (leftHeight !== rightHeight) return leftHeight - rightHeight;
  const leftAccountId = left.accountId;
  const rightAccountId = right.accountId;
  const accountCmp = compareCanonicalText(leftAccountId, rightAccountId);
  if (accountCmp !== 0) return accountCmp;
  return compareCanonicalText(left.offerId, right.offerId);
};

export const sortSwapOffersForOrderbook = (swapOffers: NormalizedOrderbookOffer[]): NormalizedOrderbookOffer[] =>
  [...swapOffers].sort(compareSwapOffersForOrderbook);

export const collectOpenSwapOffersForOrderbook = (hubState: EntityState): NormalizedOrderbookOffer[] =>
  sortSwapOffersForOrderbook(
    Array.from(hubState.accounts.entries()).flatMap(([accountId, account]) =>
      Array.from(account.swapOffers.entries()).map(([offerId, offer]) =>
        normalizeSwapOfferForOrderbook(
          {
            offerId: String(offerId),
            makerIsLeft: offer.makerIsLeft,
            fromEntity: account.leftEntity,
            toEntity: account.rightEntity,
            createdHeight: offer.createdHeight,
            giveTokenId: offer.giveTokenId,
            giveAmount: offer.giveAmount,
            wantTokenId: offer.wantTokenId,
            wantAmount: offer.wantAmount,
            priceTicks: offer.priceTicks,
            timeInForce: offer.timeInForce,
            minFillRatio: offer.minFillRatio,
          },
          accountId,
        ),
      ),
    ),
  );

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
  console.log(`🚀 APPLY accountInput: ${input.fromEntityId.slice(-4)} → ${input.toEntityId.slice(-4)}`);
  console.log(`🚀 APPLY accountInput details: height=${input.height}, hasNewFrame=${!!input.newAccountFrame}, hasPrevHanko=${!!input.prevHanko}`);

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
  const existingAccountKey = findAccountKeyInsensitive(newState.accounts, counterpartyId);
  let accountMachine = existingAccountKey ? newState.accounts.get(existingAccountKey) : undefined;
  let isNewAccount = false;
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
        nonce: 1,  // Next unified on-chain nonce to use
      },
      proofBody: {
        tokenIds: [],
        deltas: [],
      },
      frameHistory: [],
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(), // request_collateral target amounts (prepaid by requester)
      requestedRebalanceFeeState: new Map(), // Prepaid fee metadata + scheduling hints
      rebalancePolicy: new Map(), // Rebalance: per-token soft/hard/maxFee
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
    if (allowedWhileDisputed) {
      console.log(
        `🔓 Disputed account input allowed for ${counterpartyId.slice(-4)} ` +
        `(txs=[${frameTxTypes.join(',')}])`,
      );
    } else {
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
    console.log(`🤝 Processing frame from ${input.fromEntityId.slice(-4)}, accountMachine.pendingFrame=${accountMachine.pendingFrame ? `h${accountMachine.pendingFrame.height}` : 'none'}`);

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
      }

      // Multi-signer: Collect hashes from result during processing
      if (result.hashesToSign) {
        allHashesToSign.push(...result.hashesToSign);
      }

      // === HTLC LOCK PROCESSING: Check if we need to forward ===
      // CRITICAL: process committed-frame side effects for both:
      // 1) receiver-side newAccountFrame commits
      // 2) proposer-side pendingFrame commits on ACK (prevHanko)
      const justCommittedFrame =
        input.newAccountFrame && input.newAccountFrame.height > currentHeightBefore
          ? input.newAccountFrame
          : input.prevHanko && pendingFrameBefore && accountMachine.currentHeight > currentHeightBefore
            ? pendingFrameBefore
            : undefined;
      const isNewFrame = Boolean(justCommittedFrame && input.newAccountFrame);

      if (isNewFrame && justCommittedFrame?.accountTxs) {
        if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: isNewFrame=${isNewFrame}, inputHeight=${justCommittedFrame.height}, currentHeight=${accountMachine.currentHeight}`);
        if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: accountMachine.locks.size=${accountMachine.locks.size}`);
        if (HEAVY_LOGS) console.log(`🔍 FRAME-TXS: ${justCommittedFrame.accountTxs.length} txs in frame:`, justCommittedFrame.accountTxs.map(tx => tx.type));
      }

      if (justCommittedFrame?.accountTxs) {
        applyCommittedAccountFrameFollowups(newState, counterpartyId, justCommittedFrame);
      }

      if (isNewFrame && justCommittedFrame?.accountTxs) {
        for (const accountTx of justCommittedFrame.accountTxs) {
          if (HEAVY_LOGS) console.log(`🔍 HTLC-CHECK: Checking committed tx type=${accountTx.type}`);

          if (accountTx.type === 'htlc_resolve' || accountTx.type === 'j_event_claim' || accountTx.type === 'swap_resolve') {
            continue;
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
                  console.log(`🔓 Decryption successful`);
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
                throw new Error(`ENVELOPE_DECRYPT_FAIL:${lock.lockId}`);
              }
            }
            // Case 2: Envelope has innerEnvelope (plaintext wrapper)
            else if (envelope.innerEnvelope && !envelope.finalRecipient) {
              console.log(`🔓 Decrypting innerEnvelope to get routing instructions...`);
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
                  console.log(`🔓 Decryption successful`);
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
                throw new Error(`ENVELOPE_DECRYPT_FAIL:${lock.lockId}`);
              }
            }

            // Validate envelope structure (safety check)
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
          const isFinalRecipient = !!route.inboundEntity && !route.outboundEntity;
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
            }
            console.log(`⬅️ HTLC: Propagating secret to ${route.inboundEntity.slice(-4)}`);
          } else {
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
        console.log(`📊 SWAP-EVENTS: Collected ${swapOffersCreated.length} swap offers for entity-level matching`);
        allSwapOffersCreated.push(...swapOffersCreated);
      }

      const swapCancelRequests = result.swapCancelRequests || [];
      if (swapCancelRequests.length > 0) {
        console.log(`📊 SWAP-EVENTS: Collected ${swapCancelRequests.length} swap cancel requests`);
        const normalizedCancelRequests = swapCancelRequests.map(({ offerId }) => ({
          offerId,
          accountId: counterpartyId,
        }));
        allSwapCancelRequests.push(...normalizedCancelRequests);
      }

      const swapOffersCancelled = result.swapOffersCancelled || [];
      if (swapOffersCancelled.length > 0) {
        console.log(`📊 SWAP-EVENTS: Collected ${swapOffersCancelled.length} swap cancels`);
        // Normalize to local counterparty key for this account machine.
        const normalizedCancels = swapOffersCancelled.map(({ offerId }) => ({ offerId, accountId: counterpartyId }));
        allSwapOffersCancelled.push(...normalizedCancels);
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
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const quarantinedOffers: Array<{ offerId: string; accountId: string; reason: string }> = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, bookUpdates, quarantinedOffers };
  const rehydrateOnly = options.rehydrateOnly === true;
  const minTradeSize = ext.hubProfile?.minTradeSize ?? 0n;
  const quarantineOffer = (accountId: string, offerId: string, reason: string): true => {
    quarantinedOffers.push({ accountId, offerId, reason });
    return true;
  };

  // AUDIT FIX (CRITICAL-5): Cache book updates within batch to avoid stale snapshots
  // Without this, same-tick offers don't see each other's fills
  const bookCache = new Map<string, BookState>();
  const MAX_BOOK_LEVELS = 40_000;

  for (const offer of sortSwapOffersForOrderbook(swapOffers)) {
    const accountId = offer.accountId;
    console.log(`📊 ORDERBOOK-PROCESS: offerId=${offer.offerId}, accountId=${accountId.slice(-8)}`);

    const { pairId, base, quote } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
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

    const isSellBase = offer.giveTokenId === base && offer.wantTokenId === quote;
    const isBuyBase = offer.giveTokenId === quote && offer.wantTokenId === base;
    const pairPolicy = getSwapPairPolicyByBaseQuote(base, quote);
    const policyTick = Math.max(1, pairPolicy.priceStepTicks);
    if (!isSellBase && !isBuyBase) {
      console.warn(
        `⚠️ ORDERBOOK: Invalid token direction for offer=${offer.offerId} give=${offer.giveTokenId} want=${offer.wantTokenId} base=${base} quote=${quote}`,
      );
      if (rehydrateOnly && quarantineOffer(accountId, offer.offerId, 'invalid-direction')) continue;
      continue;
    }

    const baseAmount = isSellBase ? offer.giveAmount : offer.wantAmount;
    const quoteAmount = isSellBase ? offer.wantAmount : offer.giveAmount;
    if (baseAmount <= 0n || quoteAmount <= 0n) {
      console.warn(`⚠️ ORDERBOOK: Zero amount in offer=${offer.offerId}, base=${baseAmount}, quote=${quoteAmount}`);
      if (rehydrateOnly && quarantineOffer(accountId, offer.offerId, 'zero-amount')) continue;
      continue;
    }
    if (minTradeSize > 0n && quoteAmount < minTradeSize) {
      console.warn(
        `⚠️ ORDERBOOK: Offer below minTradeSize=${minTradeSize.toString()} quote=${quoteAmount.toString()} offer=${offer.offerId}` +
        (rehydrateOnly ? '; quarantined during rehydrate' : '; cancelling remainder'),
      );
      if (rehydrateOnly) {
        quarantineOffer(accountId, offer.offerId, `below-minTradeSize:${quoteAmount.toString()}`);
        continue;
      }
      mempoolOps.push({
        accountId,
        tx: {
          type: 'swap_resolve',
          data: {
            offerId: offer.offerId,
            fillRatio: 0,
            cancelRemainder: true,
          },
        },
      });
      continue;
    }
    if (baseAmount % LOT_SCALE !== 0n) {
      console.warn(
        `⚠️ ORDERBOOK: base amount not aligned to LOT_SCALE — skipping offer=${offer.offerId}, amount=${baseAmount}`,
      );
      if (rehydrateOnly && quarantineOffer(accountId, offer.offerId, `lot-misaligned:${baseAmount.toString()}`)) continue;
      continue;
    }

    priceTicks = offer.priceTicks;

    qtyLots = baseAmount / LOT_SCALE;

    if (qtyLots === 0n || qtyLots > MAX_LOTS || priceTicks <= 0n || priceTicks > MAX_LOTS) {
      console.warn(`⚠️ ORDERBOOK: Invalid order — skipping offer=${offer.offerId}, qty=${qtyLots}, price=${priceTicks}`);
      if (rehydrateOnly && quarantineOffer(accountId, offer.offerId, `invalid-order:${qtyLots.toString()}:${priceTicks.toString()}`)) continue;
      continue;
    }

    // AUDIT FIX (CRITICAL-5): Use cached book if available, otherwise load from ext.books
    let book = bookCache.get(bookKey) || ext.books.get(bookKey);
    if (!book) {
      const priceTick = BigInt(Math.max(1, policyTick));
      const halfRange = ((priceTicks * BigInt(pairPolicy.bookRangeBps)) / 10_000n) > (priceTick * 50n)
        ? (priceTicks * BigInt(pairPolicy.bookRangeBps)) / 10_000n
        : (priceTick * 50n);
      let pmin = priceTicks > halfRange ? priceTicks - halfRange : 1n;
      if (pmin <= 0n) pmin = priceTick;
      let pmax = priceTicks + halfRange;
      let levels = Number(((pmax - pmin) / priceTick) + 1n);
      if (levels > MAX_BOOK_LEVELS) {
        const halfWindowLevels = BigInt(Math.floor(MAX_BOOK_LEVELS / 2));
        const maxSpan = priceTick * BigInt(Math.max(1, MAX_BOOK_LEVELS - 1));
        pmin = priceTicks > (halfWindowLevels * priceTick)
          ? priceTicks - (halfWindowLevels * priceTick)
          : priceTick;
        pmax = pmin + maxSpan;
        if (priceTicks > pmax) {
          pmax = priceTicks;
          pmin = pmax > maxSpan ? pmax - maxSpan : priceTick;
        }
        levels = Number(((pmax - pmin) / priceTick) + 1n);
      }

      book = createBook({
        tick: priceTick,
        pmin,
        pmax,
        maxOrders: 10000,
        stpPolicy: 1, // STP cancel taker: never execute self-trades
      });
    }

    const bookTickBig = book.params.tick > 0n ? book.params.tick : 1n;
    const bookPmin = book.params.pmin > 0n ? book.params.pmin : 1n;
    const snappedPriceTicks = priceTicks <= bookPmin
      ? bookPmin
      : bookPmin + (((priceTicks - bookPmin) / bookTickBig) * bookTickBig);
    priceTicks = snappedPriceTicks;
    if (priceTicks <= 0n) {
      console.warn(`⚠️ ORDERBOOK: book-tick rounding produced zero price — skipping offer=${offer.offerId}`);
      if (rehydrateOnly && quarantineOffer(accountId, offer.offerId, 'book-tick-zero-price')) continue;
      continue;
    }
    if (priceTicks > MAX_LOTS) {
      console.warn(`⚠️ ORDERBOOK: rounded price exceeds max tick range — skipping offer=${offer.offerId}`);
      if (rehydrateOnly && quarantineOffer(accountId, offer.offerId, `book-tick-overflow:${priceTicks.toString()}`)) continue;
      continue;
    }

    const liveAccount = hubState.accounts.get(accountId);
    const liveSwapOffer = liveAccount?.swapOffers?.get(offer.offerId);
    const hasConcreteLiveOffer =
      !!liveSwapOffer &&
      typeof liveSwapOffer.giveTokenId === 'number' &&
      typeof liveSwapOffer.wantTokenId === 'number' &&
      typeof liveSwapOffer.giveAmount === 'bigint' &&
      typeof liveSwapOffer.wantAmount === 'bigint';
    if (hasConcreteLiveOffer && liveSwapOffer.priceTicks !== priceTicks) {
      const liveGiveAmount = liveSwapOffer.quantizedGive ?? liveSwapOffer.giveAmount;
      const requantizedOffer = requantizeRemainingSwapAtPrice(
        liveSwapOffer.giveTokenId,
        liveSwapOffer.wantTokenId,
        liveGiveAmount,
        priceTicks,
      );
      if (!requantizedOffer) {
        console.warn(`⚠️ ORDERBOOK: book-grid repricing dropped offer to zero — skipping offer=${offer.offerId}`);
        if (rehydrateOnly) {
          quarantineOffer(accountId, offer.offerId, `book-grid-reprice-zero:${priceTicks.toString()}`);
          continue;
        }
      } else {
        liveSwapOffer.priceTicks = priceTicks;
        liveSwapOffer.giveAmount = requantizedOffer.effectiveGive;
        liveSwapOffer.wantAmount = requantizedOffer.effectiveWant;
        liveSwapOffer.quantizedGive = requantizedOffer.effectiveGive;
        liveSwapOffer.quantizedWant = requantizedOffer.effectiveWant;
        offer.priceTicks = priceTicks;
        offer.giveAmount = requantizedOffer.effectiveGive;
        offer.wantAmount = requantizedOffer.effectiveWant;
      }
    }

    // Price deviation guard: reject orders that cross too far from best available
    const bestBid = getBestBid(book);
    const bestAsk = getBestAsk(book);
    const REJECT_BPS = SWAP_CONSTANTS.PRICE_REJECT_BPS;
    const BPS_BASE = SWAP_CONSTANTS.BPS_BASE;
    if (side === 0 && bestAsk !== null) {
      // BUY: reject if limit price > bestAsk * (1 + REJECT_BPS/BPS_BASE)
      const maxAllowed = bestAsk + ((bestAsk * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
      if (priceTicks > maxAllowed) {
        console.warn(`⚠️ ORDERBOOK: BUY price ${priceTicks.toString()} exceeds ${REJECT_BPS/100}% above best ask ${bestAsk.toString()} — rejecting offer=${offer.offerId}`);
        if (rehydrateOnly) {
          quarantineOffer(accountId, offer.offerId, `buy-price-above-band:${priceTicks.toString()}`);
          continue;
        }
        mempoolOps.push({ accountId, tx: { type: 'swap_resolve', data: { offerId: offer.offerId, fillRatio: 0, cancelRemainder: true } } });
        continue;
      }
    }
    if (side === 1 && bestBid !== null) {
      // SELL: reject if limit price < bestBid * (1 - REJECT_BPS/BPS_BASE)
      const minAllowed = bestBid - ((bestBid * BigInt(REJECT_BPS)) / BigInt(BPS_BASE));
      if (priceTicks < minAllowed) {
        console.warn(`⚠️ ORDERBOOK: SELL price ${priceTicks.toString()} below ${REJECT_BPS/100}% under best bid ${bestBid.toString()} — rejecting offer=${offer.offerId}`);
        if (rehydrateOnly) {
          quarantineOffer(accountId, offer.offerId, `sell-price-below-band:${priceTicks.toString()}`);
          continue;
        }
        mempoolOps.push({ accountId, tx: { type: 'swap_resolve', data: { offerId: offer.offerId, fillRatio: 0, cancelRemainder: true } } });
        continue;
      }
    }

    const makerId = offer.makerIsLeft ? offer.fromEntity : offer.toEntity;
    const namespacedOrderId = `${accountId}:${offer.offerId}`;
    console.log(`📊 ORDERBOOK ADD: maker=${formatEntityId(makerId)}, orderId=${namespacedOrderId.slice(-20)}, side=${side}, price=${priceTicks}, qty=${qtyLots}`);

    const result = applyCommand(book, {
      kind: 0,
      ownerId: makerId,
      orderId: namespacedOrderId,
      side,
      tif: offer.timeInForce,
      postOnly: rehydrateOnly,
      priceTicks,
      qtyLots: Number(qtyLots),
      minFillRatio: offer.minFillRatio,
    });

    book = result.state;
    // AUDIT FIX (CRITICAL-5): Cache updated book for next offer in same batch
    bookCache.set(bookKey, book);
    bookUpdates.push({ pairId: bookKey, book });

    const rejectEvents = result.events.filter(
      (event) => event.type === 'REJECT' && event.orderId === namespacedOrderId,
    );
    const offerRejectedWithoutFill = rejectEvents.length > 0;
    if (offerRejectedWithoutFill) {
      const rejectReasons = rejectEvents.map((event) => event.reason).filter(Boolean).join(', ');
      console.warn(
        `⚠️ ORDERBOOK REJECT: offer=${offer.offerId} account=${accountId.slice(-8)} side=${side} price=${priceTicks.toString()} qty=${qtyLots.toString()} bestBid=${String(bestBid)} bestAsk=${String(bestAsk)} reason=${rejectReasons || 'unknown'}`,
      );
      if (rehydrateOnly) {
        quarantineOffer(accountId, offer.offerId, `post-only-reject:${rejectReasons || 'unknown'}`);
        continue;
      }
      mempoolOps.push({
        accountId,
        tx: {
          type: 'swap_resolve',
          data: {
            offerId: offer.offerId,
            fillRatio: 0,
            cancelRemainder: true,
          },
        },
      });
      console.log(`📤 ORDERBOOK: Queued swap_resolve(cancelRemainder) for rejected offer ${offer.offerId.slice(-8)}`);
      continue;
    }

    if (rehydrateOnly) {
      continue;
    }

    // Process trade events
    const fillsPerOrder = new Map<string, {
      filledLots: number;
      originalLots: number;
      weightedCost: bigint;
    }>();

    for (const event of result.events) {
      if (event.type === 'TRADE') {
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

        console.log(`📊 ORDERBOOK TRADE: ${extractOfferId(event.makerOrderId)} ↔ ${extractOfferId(event.takerOrderId)} @ ${event.price}, qty=${event.qty}`);
      }
    }

    // Emit swap_resolve for each filled order
    for (const [namespacedOrderId, { filledLots, originalLots, weightedCost }] of fillsPerOrder) {
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
        throw new Error(
          `ORDERBOOK_ACCOUNT_LOOKUP_FAILED: offer=${offerId} accountId=${accountId} ` +
          `known=[${Array.from(hubState.accounts.keys()).join(',')}]`,
        );
      }
      console.log(`✅ ORDERBOOK-LOOKUP: Found account for ${accountId.slice(-8)}, generating swap_resolve`);

      const filledBig = BigInt(filledLots);
      const executionBaseWei = filledBig * SWAP_LOT_SCALE;
      const executionQuoteWei = (weightedCost * SWAP_LOT_SCALE) / ORDERBOOK_PRICE_SCALE;

      const account = hubState.accounts.get(accountId);
      const swapOffer = account?.swapOffers?.get(offerId);
      const offerForExecution = swapOffer ?? offer;
      const orderStillInBook = book.orderIdToIdx.has(namespacedOrderId) &&
        book.orderActive[book.orderIdToIdx.get(namespacedOrderId)!];
      const resolveData = buildSwapResolveDataFromOrderbookFill(
        offerForExecution,
        executionBaseWei,
        executionQuoteWei,
        !orderStillInBook,
      );

      mempoolOps.push({
        accountId,
        tx: {
          type: 'swap_resolve',
          data: {
            offerId,
            ...resolveData,
          },
        },
      });
      console.log(
        `📤 ORDERBOOK: Queued swap_resolve for ${offerId.slice(-8)}, fill=${(resolveData.fillRatio / MAX_SWAP_FILL_RATIO * 100).toFixed(1)}%, cancel=${!orderStillInBook}`,
      );
    }
  }

  return { mempoolOps, bookUpdates, quarantinedOffers };
}

/**
 * Process swap cancels through hub's orderbook
 */
export function processOrderbookCancels(
  hubState: EntityState,
  cancels: SwapCancelRequestEvent[]
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const quarantinedOffers: MatchResult['quarantinedOffers'] = [];
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, bookUpdates, quarantinedOffers };

  for (const { offerId, accountId } of cancels) {
    const accountMachine = hubState.accounts.get(accountId);
    const hasOffer = Boolean(accountMachine?.swapOffers?.has(offerId));
    if (!hasOffer) continue;

    const namespacedOrderId = `${accountId}:${offerId}`;
    let orderbookCancelled = false;

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
      orderbookCancelled = true;
      break;
    }

    // Finalize cancellation at account level (releases hold + removes offer) via hub decision.
    // If order already gone from book but offer still exists in account, we still force cancelRemainder.
    mempoolOps.push({
      accountId,
      tx: {
        type: 'swap_resolve',
        data: {
          offerId,
          fillRatio: 0,
          cancelRemainder: true,
        },
      },
    });
    if (!orderbookCancelled) {
      console.log(`📊 ORDERBOOK: Offer ${offerId.slice(-8)} not active in book, forcing account-level cancel`);
    } else {
      console.log(`📤 ORDERBOOK: Queued swap_resolve(cancelRemainder) for ${offerId.slice(-8)}`);
    }
  }

  return { mempoolOps, bookUpdates, quarantinedOffers };
}
