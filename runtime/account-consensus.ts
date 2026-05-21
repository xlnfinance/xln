/**
 * XLN Account Consensus System
 *
 * Implements bilateral consensus between two entities for off-chain account settlement.
 * Based on old_src Channel.ts but adapted for entity-deterministic architecture.
 *
 * Key Concepts:
 * - AccountMachine: Bilateral state machine between two entities
 * - Giant Per-Token Table: Map<tokenId, Delta> like old_src channels
 * - Global Credit Limits: USD-denominated credit limits (simplified)
 * - Frame-Based Consensus: Bilateral agreement on account state changes
 * - Event Bubbling: Account events bubble up to E-Machine for entity messages
 */

import type {
  AccountMachine,
  AccountFrame,
  AccountTx,
  AccountInput,
  Env,
  EntityState,
  Delta,
  EntityReplica,
} from './types';
import {
  cloneAccountFrame,
  cloneAccountMachine,
  getAccountPerspective,
  removeCommittedTxsFromMempool,
} from './state-helpers';
import { isLeft } from './account-utils';
import { signAccountFrame } from './account-crypto';
import { cryptoHash as hash, formatEntityId, HEAVY_LOGS } from './utils';
import { safeStringify } from './serialization-utils';
import { validateAccountFrame as validateAccountFrameStrict } from './validation-utils';
import { processAccountTx } from './account-tx/apply';
import { appendAccountFrameHistoryView, getAccountFrameHistoryView, markStorageAccountDirty, recordAccountFrameHistory } from './env-events';
import { assertAccountFrameDeltaIntegrity, deriveAccountFrameOffdeltas, deriveAccountFrameTokenIds } from './account-frame';
import { createStructuredLogger, shortHash, shortId, shouldLogFullPayloads } from './logger';
import {
  assertNoUnilateralSettlementMutation,
  captureSettlementVector,
  getDepositoryAddress,
  isAddress20,
  isEntityId32,
  kickHubRebalanceAfterFrameFinalize,
  prependUniqueMempoolTxs,
  runPostFrameAutoRebalanceCheck,
  shouldIncludeToken,
  summarizeDeltasForLog,
} from './account-consensus-helpers';
// NOTE: Settlements now use SettlementWorkspace flow (see entity-tx/handlers/settle.ts)

// Removed createValidAccountSnapshot - using simplified AccountSnapshot interface

// === CONSTANTS ===
const MEMPOOL_LIMIT = 1000;
const MAX_ACCOUNT_FRAME_TXS = 100;
const accountLog = createStructuredLogger('account');
const MAX_FRAME_TIMESTAMP_DRIFT_MS = 300000; // 5 minutes
const MAX_FRAME_SIZE_BYTES = 1048576; // 1MB frame size limit (Bitcoin block size standard)

// === VALIDATION ===

/**
 * Validate account frame (frame-level validation)
 */
export function validateAccountFrame(
  frame: AccountFrame,
  currentTimestamp?: number,
  previousFrameTimestamp?: number,
): boolean {
  if (frame.height < 0) return false;
  if (typeof frame.jHeight !== 'number' || frame.jHeight < 0) return false;
  if (frame.accountTxs.length > MAX_ACCOUNT_FRAME_TXS) return false;
  try {
    assertAccountFrameDeltaIntegrity(frame, `AccountFrame#${frame.height}`);
  } catch (error) {
    console.warn(`❌ Invalid account frame delta integrity: ${(error as Error).message}`);
    return false;
  }

  // CRITICAL: Timestamp validation for HTLC safety
  if (currentTimestamp !== undefined) {
    // Check drift (prevent clock manipulation)
    if (Math.abs(frame.timestamp - currentTimestamp) > MAX_FRAME_TIMESTAMP_DRIFT_MS) {
      console.log(`❌ Frame timestamp drift too large: ${frame.timestamp} vs ${currentTimestamp}`);
      return false;
    }

    // Ensure non-decreasing timestamps (prevent time-travel attacks on HTLCs)
    // Allow equal timestamps (batched frames), but reject backwards movement
    if (previousFrameTimestamp !== undefined && frame.timestamp < previousFrameTimestamp) {
      console.log(
        `❌ Frame timestamp went backwards: ${frame.timestamp} < ${previousFrameTimestamp} (delta: ${previousFrameTimestamp - frame.timestamp}ms)`,
      );
      return false;
    }
  }

  return true;
}

// Counter-based replay protection REMOVED — frame chain (height + prevFrameHash) handles replay.
// nonce is kept for on-chain operations only (dispute proofs, settlements).

// === FRAME HASH COMPUTATION ===

async function createFrameHash(frame: AccountFrame): Promise<string> {
  assertAccountFrameDeltaIntegrity(frame, `AccountFrame#${frame.height}`);
  // CRITICAL: Use keccak256 for EVM compatibility (Channel.ts:585, 744)
  // Include prevFrameHash to chain frames together (prevents signature replay)
  const { ethers } = await import('ethers');

  // Encode FULL frame structure including all delta fields (2024 pattern)
  const frameData = {
    height: frame.height,
    timestamp: frame.timestamp,
    jHeight: frame.jHeight,
    prevFrameHash: frame.prevFrameHash, // Chain linkage
    accountTxs: frame.accountTxs.map(tx => ({
      type: tx.type,
      data: tx.data,
    })),
    // Include full shared delta state in frame hash.
    // collateral/ondelta are shared values and must stay identical across peers.
    // If they diverge, frame consensus must fail hard.
    deltas: frame.deltas.map(delta => ({
      tokenId: delta.tokenId,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      leftCreditLimit: delta.leftCreditLimit.toString(),
      rightCreditLimit: delta.rightCreditLimit.toString(),
      leftAllowance: delta.leftAllowance.toString(),
      rightAllowance: delta.rightAllowance.toString(),
      leftHold: (delta.leftHold || 0n).toString(),
      rightHold: (delta.rightHold || 0n).toString(),
    })),
  };

  // Use keccak256 like 2024 Channel.ts (not truncated hash20)
  const encoded = safeStringify(frameData); // Deterministic JSON encoding
  return ethers.keccak256(ethers.toUtf8Bytes(encoded));
}

export async function computeFrameHash(frame: AccountFrame): Promise<string> {
  return createFrameHash(frame);
}

// === TRANSACTION PROCESSING ===

// Transaction processing now delegated to account-tx/apply.ts (modular handlers)
// See: src/account-tx/handlers/* for individual transaction handlers

// === FRAME CONSENSUS ===

/**
 * Propose account frame (like old_src Channel consensus)
 */
export async function proposeAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
  skipNonceIncrement: boolean = false,
  entityJHeight?: number, // Optional: J-height from entity state for HTLC consensus
): Promise<{
  success: boolean;
  accountInput?: AccountInput;
  events: string[];
  error?: string;
  revealedSecrets?: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated?: Array<{
    offerId: string;
    makerIsLeft: boolean;
    fromEntity: string;
    toEntity: string;
    accountId?: string;
    giveTokenId: number;
    giveAmount: bigint;
	    wantTokenId: number;
	    wantAmount: bigint;
	    priceTicks?: bigint | undefined;
	    timeInForce?: 0 | 1 | 2 | undefined;
	    minFillRatio: number;
	  }>;
  swapCancelRequests?: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  // MULTI-SIGNER: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
  // Failed HTLC locks that need backward cancellation via htlcRoutes
  failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
}> {
  // Derive counterparty from canonical left/right
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  const quiet = env.quietRuntimeLogs === true;
  if (!quiet) {
    accountLog.debug('proposal.start', {
      counterparty: shortId(counterparty),
      mempool: accountMachine.mempool.length,
      pendingFrame: Boolean(accountMachine.pendingFrame),
      height: accountMachine.currentHeight,
    });
  }

  const events: string[] = [];

  // Mempool size validation
  if (accountMachine.mempool.length > MEMPOOL_LIMIT) {
    accountLog.warn('proposal.mempool_overflow', { mempool: accountMachine.mempool.length, limit: MEMPOOL_LIMIT });
    return { success: false, error: `Mempool overflow: ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`, events };
  }

  if (accountMachine.mempool.length === 0) {
    accountLog.debug('proposal.empty_mempool');
    return { success: false, error: 'No transactions to propose', events };
  }

  // Check if we have a pending frame waiting for ACK
  if (accountMachine.pendingFrame) {
    if (!quiet) accountLog.debug('proposal.waiting_ack', { pendingHeight: accountMachine.pendingFrame.height });
    return { success: false, error: 'Waiting for ACK on pending frame', events };
  }

  // IMPORTANT: Do NOT gate RIGHT-side j_event_claim proposals on presence of a
  // previously committed LEFT claim.
  //
  // Correct model:
  // 1. Each side may observe the same J-event independently.
  // 2. Each side is allowed to propose its own j_event_claim account frame.
  // 3. Those claims are stored in account state as left/right observations.
  // 4. tryFinalizeAccountJEvents() is the ONLY place that may require 2-of-2
  //    agreement and finalize the unilateral settlement fields.
  //
  // If proposal logic blocks one side until the other side's claim is already
  // committed, bilateral rebalance can deadlock at "Waiting for LEFT claim":
  // the second observation never enters account state, so the 2-of-2 matcher
  // never sees both sides. Same-height races are handled by the normal
  // simultaneous-proposal rollback/tiebreaker path below, not by a special
  // j_event_claim gate here.

  const proposalWindow = accountMachine.mempool.slice(0, MAX_ACCOUNT_FRAME_TXS);
  if (!quiet) {
    accountLog.info('proposal.frame_create', {
      txs: proposalWindow.map(tx => tx.type),
      mempool: accountMachine.mempool.length,
      frameMax: MAX_ACCOUNT_FRAME_TXS,
    });
  }
  if (HEAVY_LOGS)
    console.log(
      `🔍 PROOF-HEADER: from=${formatEntityId(accountMachine.proofHeader.fromEntity)}, to=${formatEntityId(accountMachine.proofHeader.toEntity)}`,
    );

  // Clone account machine for validation
  let clonedMachine = cloneAccountMachine(accountMachine);
  // NOTE: proofHeader.nonce is NOT set here — it's incremented per-message, not per-frame

  // Deterministic J-height for account frame hashing:
  // Use account-level finalized J-height (consensus state), not live replica tip.
  // Replica tip can drift between runtime sessions and break WAL replay hashes.
  const frameJHeight = entityJHeight ?? accountMachine.lastFinalizedJHeight ?? 0;

  // Process all transactions on the clone
  const allEvents: string[] = [];
  const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
  // AUDIT FIX (CRITICAL-1): SwapOfferEvent carries makerIsLeft + fromEntity/toEntity
  // Entity handler will enrich with accountId based on its own perspective
  const swapOffersCreated: Array<{
    offerId: string;
    makerIsLeft: boolean;
    fromEntity: string;
    toEntity: string;
    accountId?: string; // Enriched by entity handler
	    giveTokenId: number;
	    giveAmount: bigint;
	    wantTokenId: number;
	    wantAmount: bigint;
	    priceTicks?: bigint | undefined;
	    timeInForce?: 0 | 1 | 2 | undefined;
	    minFillRatio: number;
	  }> = [];
  const swapCancelRequests: Array<{ offerId: string; accountId: string }> = [];
  const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

  if (HEAVY_LOGS)
    console.log(
      `🔍 MEMPOOL-BEFORE-PROCESS: proposalWindow=${proposalWindow.length}/${accountMachine.mempool.length} txs:`,
      proposalWindow.map(tx => tx.type),
    );

  const validTxs: typeof accountMachine.mempool = [];
  const failedHtlcLocks: Array<{ hashlock: string; reason: string }> = [];
  const txsToRemove: typeof accountMachine.mempool = [];

  for (const accountTx of proposalWindow) {
    if (HEAVY_LOGS) console.log(`   🔍 Processing accountTx type=${accountTx.type}`);
    // Channel.ts: byLeft = proposer is left entity (frame-level, same on both sides).
    // Use normalized ordering helper (not raw string equality) to avoid casing-induced
    // divergence during WAL replay.
    const proposerByLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
    const txMachine = cloneAccountMachine(clonedMachine);
    const beforeSettlement = captureSettlementVector(txMachine);
    const result = await processAccountTx(
      txMachine,
      accountTx,
      proposerByLeft,
      env.timestamp, // Will be replaced by frame.timestamp during commit
      frameJHeight, // Entity's synced J-height
      true, // isValidation = true (on clone, skip persistent state updates)
      env,
    );

    if (!result.success) {
      // Skip failed tx — remove from mempool, don't abort entire proposal
      txsToRemove.push(accountTx);
      console.log(`⚠️ Skipping failed tx: ${accountTx.type} (${result.error})`);

      // Track failed HTLC locks for backward cancellation
      if (accountTx.type === 'htlc_lock') {
        failedHtlcLocks.push({
          hashlock: accountTx.data.hashlock,
          reason: result.error || 'validation_failed',
        });
        console.log(`⬅️ Failed htlc_lock queued for cancel: hashlock=${accountTx.data.hashlock.slice(0, 12)}...`);
      }
      continue; // Skip to next tx
    }
    assertNoUnilateralSettlementMutation(txMachine, beforeSettlement, accountTx, 'propose/validate');
    clonedMachine = txMachine;

    validTxs.push(accountTx);
    allEvents.push(...result.events);

    // Collect revealed secrets for backward propagation
    if (HEAVY_LOGS)
      console.log(
        `🔍 TX-RESULT: type=${accountTx.type}, hasSecret=${!!result.secret}, hasHashlock=${!!result.hashlock}`,
      );
    if (result.secret && result.hashlock) {
      revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
    }

    // Collect swap offers for orderbook integration
    if (result.swapOfferCreated) {
      swapOffersCreated.push(result.swapOfferCreated);
    }

    // Collect cancel requests for hub orderbook cancellation flow
    if (result.swapOfferCancelRequested) {
      swapCancelRequests.push({
        ...result.swapOfferCancelRequested,
        accountId: accountMachine.proofHeader.toEntity,
      });
    }

    // Collect finalized cancellations for open-offer/orderbook cleanup
    if (result.swapOfferCancelled) {
      swapOffersCancelled.push(result.swapOfferCancelled);
    }
  }

  // Use the same fingerprint-based removal primitive as committed-tx cleanup.
  // This avoids relying on object identity across validation/replay paths.
  accountMachine.mempool = removeCommittedTxsFromMempool(accountMachine.mempool, txsToRemove);
  markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // If no valid txs remain after filtering, return early
  if (validTxs.length === 0) {
    const earlyResult: {
      success: false;
      error: string;
      events: string[];
      failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
    } = {
      success: false,
      error: 'All transactions failed validation',
      events: allEvents,
    };
    if (failedHtlcLocks.length > 0) earlyResult.failedHtlcLocks = failedHtlcLocks;
    return earlyResult;
  }

  const finalDeltas: Delta[] = [];

  // Sort by tokenId for deterministic ordering
  const sortedTokens = Array.from(clonedMachine.deltas.entries()).sort((a, b) => a[0] - b[0]);

  for (const [tokenId, delta] of sortedTokens) {
    // CONSENSUS FIX: Only include tokens that were actually used in transactions
    // This prevents mismatch when one side creates empty delta entries
    // CRITICAL: Use offdelta ONLY for frame comparison (not ondelta)
    // ondelta is set by J-events which have timing dependencies (bilateral finalization)
    // offdelta is set by bilateral transactions (deterministic)
    const totalDelta = delta.offdelta;

    // Skip tokens with zero delta AND zero limits AND zero holds (never used)
    // CRITICAL: Include tokens with HTLC/swap holds even if delta/limits/collateral are zero
    // NOTE: Collateral changes from j_events are included separately in frame validation
    // Only skip if delta, limits, AND holds are all zero
    // Collateral is omitted here because j_events can set it during frame processing
    if (!shouldIncludeToken(delta, totalDelta)) {
      if (HEAVY_LOGS) console.log(`⏭️  Skipping unused token ${tokenId} from frame (zero delta/limits/holds)`);
      continue;
    }

    finalDeltas.push({ ...delta });
  }

  // Determine if we're left entity (for byLeft field)
  const weAreLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // Ensure monotonic timestamps within account (HTLC safety + multi-runtime compatibility)
  // In multi-runtime P2P scenarios, different runtimes may have different clock rates
  // We ensure frames always have increasing timestamps within an account chain
  const previousTimestamp = accountMachine.currentFrame?.timestamp ?? 0;
  const frameTimestamp = Math.max(env.timestamp, previousTimestamp + 1);
  if (frameTimestamp > env.timestamp && HEAVY_LOGS) {
    console.log(
      `⚡ TIMESTAMP-SYNC: Using monotonic timestamp ${frameTimestamp} (prev=${previousTimestamp}, env=${env.timestamp})`,
    );
  }

  // Create account frame matching the real AccountFrame interface
  // CRITICAL: Deep-copy accountTxs to prevent mutation issues (j_event_claim data can be modified later)
  // Use structuredClone to preserve BigInt values
  // NOTE: Use validTxs (filtered) not accountMachine.mempool (may contain failed txs)
  const accountTxsCopy = structuredClone([...validTxs]);
  const frameData = {
    height: accountMachine.currentHeight + 1,
    timestamp: frameTimestamp, // MONOTONIC: max(env.timestamp, prev+1) for multi-runtime safety
    jHeight: frameJHeight, // CRITICAL: J-height for HTLC consensus
    accountTxs: accountTxsCopy,
    // CRITICAL: Use stored stateHash from currentFrame (set during commit)
    prevFrameHash: accountMachine.currentHeight === 0 ? 'genesis' : accountMachine.currentFrame.stateHash || '',
    stateHash: '', // Will be filled after hash calculation
    byLeft: weAreLeft, // Who proposed this frame
    deltas: finalDeltas,
  };

  // Calculate state hash (frameData is properly typed AccountFrame)
  frameData.stateHash = await createFrameHash(frameData as AccountFrame);

  // VALIDATE AT SOURCE: Guaranteed type safety from this point forward
  let newFrame: AccountFrame;
  try {
    newFrame = validateAccountFrameStrict(frameData, 'proposeAccountFrame');
  } catch (error) {
    console.warn(`⚠️ Frame validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      error: `Frame validation failed: ${(error as Error).message}`,
      events,
    };
  }

  // Validate frame size (Bitcoin 1MB block limit)
  const frameSize = safeStringify(newFrame).length;
  if (frameSize > MAX_FRAME_SIZE_BYTES) {
    console.warn(`⚠️ Frame too large: ${frameSize} bytes`);
    return {
      success: false,
      error: `Frame exceeds 1MB limit: ${frameSize} bytes`,
      events,
    };
  }
  if (!quiet) {
    console.log(
      `✅ Frame size: ${frameSize} bytes (${((frameSize / MAX_FRAME_SIZE_BYTES) * 100).toFixed(2)}% of 1MB limit)`,
    );
  }

  // Generate HANKO signature - CRITICAL: Use signerId, not entityId
  // For single-signer entities, build hanko with single EOA signature
  const signingEntityId = accountMachine.proofHeader.fromEntity;
  const signingReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === signingEntityId);
  if (!signingReplica) {
    return { success: false, error: `Cannot find replica for entity ${signingEntityId.slice(-4)}`, events };
  }
  const signingSignerId = signingReplica.state.config.validators[0]; // Single-signer: use first validator
  if (!signingSignerId) {
    return { success: false, error: `Entity ${signingEntityId.slice(-4)} has no validators`, events };
  }

  if (!quiet) accountLog.debug('hanko.sign', { entity: shortId(signingEntityId), signer: shortId(signingSignerId) });

  // Build hanko for account frame
  const { signEntityHashes } = await import('./hanko/signing');
  // Sign frame hash for bilateral consensus
  const hankos = await signEntityHashes(env, signingEntityId, signingSignerId, [newFrame.stateHash]);
  const frameHanko = hankos[0];
  if (!frameHanko) {
    return { success: false, error: 'Failed to build frame hanko', events };
  }
  accountMachine.currentFrameHanko = frameHanko;

  // Build dispute proof and sign it (CRITICAL: always sign dispute proof with every frame)
  // BUG FIX: Use clonedMachine (has NEW state after txs) NOT accountMachine (old state)
  if (!isEntityId32(clonedMachine.leftEntity) || !isEntityId32(clonedMachine.rightEntity)) {
    const left = String(clonedMachine.leftEntity);
    const right = String(clonedMachine.rightEntity);
    return {
      success: false,
      error: `INVALID_ACCOUNT_ENTITY_ID: left=${left} right=${right}`,
      events,
    };
  }

  const { buildAccountProofBody, createDisputeProofHash } = await import('./proof-builder');
  const depositoryAddress = getDepositoryAddress(env);
  if (!isAddress20(depositoryAddress)) {
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: MISSING_DEPOSITORY_ADDRESS`,
      events,
    };
  }

  let proofResult: ReturnType<typeof buildAccountProofBody>;
  let disputeHash: string;
  try {
    if (!quiet) {
      console.log(
        `🔐 DISPUTE-SIGN: depositoryAddress=${depositoryAddress}, counterparty=${accountMachine.proofHeader.toEntity.slice(-4)}`,
      );
    }
    proofResult = buildAccountProofBody(clonedMachine);
    disputeHash = createDisputeProofHash(clonedMachine, proofResult.proofBodyHash, depositoryAddress);
    if (!quiet) {
      console.log(
        `🔐 DISPUTE-SIGN: disputeHash=${disputeHash.slice(0, 18)}..., proofBodyHash=${proofResult.proofBodyHash.slice(0, 18)}...`,
      );
    }
  } catch (error) {
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: ${(error as Error).message}`,
      events,
    };
  }

  const disputeHankos = await signEntityHashes(env, signingEntityId, signingSignerId, [disputeHash]);
  const disputeHanko = disputeHankos[0];
  if (!disputeHanko) {
    return { success: false, error: 'Failed to build dispute hanko', events };
  }
  accountMachine.currentDisputeProofHanko = disputeHanko;
  accountMachine.currentDisputeProofNonce = clonedMachine.proofHeader.nonce;
  accountMachine.currentDisputeProofBodyHash = proofResult.proofBodyHash;
  accountMachine.currentDisputeHash = disputeHash;
  if (!accountMachine.disputeProofNoncesByHash) {
    accountMachine.disputeProofNoncesByHash = {};
  }
  accountMachine.disputeProofNoncesByHash[proofResult.proofBodyHash] = clonedMachine.proofHeader.nonce;
  if (!accountMachine.disputeProofBodiesByHash) {
    accountMachine.disputeProofBodiesByHash = {};
  }
  accountMachine.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;

  // Settlements are handled via SettlementWorkspace flow (entity-tx/handlers/settle.ts).

  // Set pending state (no longer storing clone - re-execution on commit)
  accountMachine.pendingFrame = newFrame;
  markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // Remove only the transactions that actually made it into the proposed frame.
  // This function is async and can yield while hashing/signing; late arrivals must
  // remain queued for the next frame instead of being silently wiped by position.
  accountMachine.mempool = removeCommittedTxsFromMempool(accountMachine.mempool, newFrame.accountTxs);

  events.push(`🚀 Proposed frame ${newFrame.height} with ${newFrame.accountTxs.length} transactions`);

  const outboundFrame = cloneAccountFrame(newFrame);
  const reusableAck = accountMachine.lastOutboundFrameAck;
  const shouldBundlePreviousAck =
    !!reusableAck &&
    reusableAck.counterpartyEntityId.toLowerCase() === accountMachine.proofHeader.toEntity.toLowerCase() &&
    Number(reusableAck.height) === Number(newFrame.height) - 1 &&
    Number(accountMachine.currentHeight) === Number(reusableAck.height);
  const accountInput: AccountInput = shouldBundlePreviousAck ? {
    kind: 'frame_ack',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: reusableAck.height,
    prevHanko: reusableAck.prevHanko,
    newAccountFrame: outboundFrame,
    newHanko: frameHanko,
    newDisputeHanko: disputeHanko,
    newDisputeHash: disputeHash,
    newDisputeProofBodyHash: proofResult.proofBodyHash,
    disputeProofNonce: accountMachine.proofHeader.nonce,
  } : {
    kind: 'frame',
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: newFrame.height,
    newAccountFrame: outboundFrame,
    newHanko: frameHanko, // Hanko on frame stateHash
    newDisputeHanko: disputeHanko, // Hanko on dispute proof hash
    newDisputeHash: disputeHash, // Full dispute hash (key in hankoWitness for quorum lookup)
    newDisputeProofBodyHash: proofResult.proofBodyHash, // ProofBodyHash that disputeHanko signs
    // NOTE: Settlement hankos now handled via SettlementWorkspace (entity-tx/handlers/settle.ts)
    disputeProofNonce: accountMachine.proofHeader.nonce, // nonce at which dispute proof was signed (before increment)
  };
  if (!shouldBundlePreviousAck && reusableAck && Number(reusableAck.height) < Number(accountMachine.currentHeight)) {
    delete accountMachine.lastOutboundFrameAck;
  }
  if (!skipNonceIncrement) ++accountMachine.proofHeader.nonce;
  accountMachine.pendingAccountInput = structuredClone(accountInput);

  // Collect hashes for entity-quorum signing (multi-signer support)
  const hashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [
    {
      hash: newFrame.stateHash,
      type: 'accountFrame',
      context: `account:${counterparty.slice(-8)}:frame:${newFrame.height}`,
    },
    { hash: disputeHash, type: 'dispute', context: `account:${counterparty.slice(-8)}:dispute` },
  ];

  const finalResult: Awaited<ReturnType<typeof proposeAccountFrame>> = {
    success: true,
    accountInput,
    events,
    revealedSecrets,
    swapOffersCreated,
    swapCancelRequests,
    swapOffersCancelled,
    hashesToSign,
  };
  if (failedHtlcLocks.length > 0) finalResult.failedHtlcLocks = failedHtlcLocks;
  return finalResult;
}

/**
 * Handle received AccountInput (bilateral consensus)
 */
export async function handleAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput,
): Promise<{
  success: boolean;
  response?: AccountInput;
  events: string[];
  error?: string;
  approvalNeeded?: AccountTx;
  revealedSecrets?: Array<{ secret: string; hashlock: string }>;
  swapOffersCreated?: Array<{
    offerId: string;
    makerIsLeft: boolean;
    fromEntity: string;
    toEntity: string;
    accountId?: string;
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    minFillRatio: number;
  }>;
  swapCancelRequests?: Array<{ offerId: string; accountId: string }>;
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  timedOutHashlocks?: string[];
  committedFrames?: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }>;
  // MULTI-SIGNER: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
}> {
  const normalizedInputHeight =
    input.height === undefined || input.height === null ? undefined : Number(input.height as number | string);
  if (normalizedInputHeight !== undefined && !Number.isFinite(normalizedInputHeight)) {
    return { success: false, error: `Invalid account input height: ${String(input.height)}`, events: [] };
  }
  const committedFrames: Array<{ frame: AccountFrame; committedViaNewFrame: boolean }> = [];

  const events: string[] = [];
  const timedOutHashlocks: string[] = [];
  let ackProcessed = false;
  const describeAccountState = () => ({
    currentHeight: Number(accountMachine.currentHeight ?? 0),
    currentHash: accountMachine.currentFrame?.stateHash ?? null,
    currentPrev: accountMachine.currentFrame?.prevFrameHash ?? null,
    currentTimestamp: Number(accountMachine.currentFrame?.timestamp ?? 0),
    pendingHeight: Number(accountMachine.pendingFrame?.height ?? 0),
    pendingHash: accountMachine.pendingFrame?.stateHash ?? null,
    pendingPrev: accountMachine.pendingFrame?.prevFrameHash ?? null,
    pendingTimestamp: Number(accountMachine.pendingFrame?.timestamp ?? 0),
    frameHistoryTail: getAccountFrameHistoryView(accountMachine).slice(-3).map((frame) => ({
      height: Number(frame?.height ?? 0),
      stateHash: frame?.stateHash ?? null,
      prevFrameHash: frame?.prevFrameHash ?? null,
    })),
  });
  // Replay protection: frame chain (height + prevFrameHash) checked at :836
  // ACK replay protection: pendingFrame cleared on commit, so replayed ACK fails pendingFrame check

  if (input.newDisputeHanko !== undefined && input.newDisputeHanko !== null) {
    if (typeof input.newDisputeHanko !== 'string') {
      return { success: false, error: 'Invalid dispute hanko type', events };
    }
    const hankoHex = input.newDisputeHanko.toLowerCase();
    const normalized = hankoHex.startsWith('0x') ? hankoHex.slice(2) : hankoHex;
    if (normalized.length === 0) {
      return { success: false, error: 'Invalid dispute hanko (empty)', events };
    }
    if (normalized.length % 2 !== 0) {
      return { success: false, error: 'Invalid dispute hanko (odd length)', events };
    }
  }

  const pendingHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const bundledNewFrameHeight =
    input.newAccountFrame === undefined || input.newAccountFrame === null
      ? undefined
      : Number(input.newAccountFrame.height);
  const ackTargetsPendingFrame =
    Boolean(input.prevHanko) &&
    Boolean(accountMachine.pendingFrame) &&
    // Normal ACK-only message.
    (normalizedInputHeight === pendingHeight ||
      // BATCHED message: ACK for pending frame + next proposed frame.
      (bundledNewFrameHeight !== undefined && bundledNewFrameHeight === pendingHeight + 1));
  const ackHeight = ackTargetsPendingFrame ? pendingHeight : normalizedInputHeight;

  // Handle pending frame confirmation
  if (accountMachine.pendingFrame && ackHeight === accountMachine.pendingFrame.height && input.prevHanko) {
    if (HEAVY_LOGS) console.log(`✅ ACK-DEBUG: fromEntity=${input.fromEntityId.slice(-4)}, toEntity=${input.toEntityId.slice(-4)}`);

    const frameHash = accountMachine.pendingFrame.stateHash;

    // HANKO ACK VERIFICATION: Verify hanko instead of single signature
    const ackHanko = input.prevHanko;
    if (!ackHanko) {
      return { success: false, error: 'Missing ACK hanko', events };
    }

    const expectedAckEntity = accountMachine.proofHeader.toEntity;
    accountLog.debug('hanko.ack.verify', { height: ackHeight, frame: shortHash(frameHash) });
    const { verifyHankoForHash } = await import('./hanko/signing');
    const verifyResult = await verifyHankoForHash(ackHanko, frameHash, expectedAckEntity, env);
    const valid = verifyResult.valid;
    const recoveredEntityId = verifyResult.entityId;
    if (!valid) {
      return { success: false, error: 'Invalid ACK hanko signature', events };
    }

    if (!recoveredEntityId || recoveredEntityId.toLowerCase() !== expectedAckEntity.toLowerCase()) {
      return {
        success: false,
        error: `ACK hanko entityId mismatch: got ${recoveredEntityId?.slice(-4)}, expected ${expectedAckEntity.slice(-4)}`,
        events,
      };
    }
    accountLog.debug('hanko.ack.verified', { from: shortId(recoveredEntityId ?? expectedAckEntity), height: ackHeight });

    // ACK is valid - proceed
    ackProcessed = true;
    {
      const tokenIds = deriveAccountFrameTokenIds(accountMachine.pendingFrame);
      const txTypes = accountMachine.pendingFrame.accountTxs.map(tx => tx.type);
      accountLog.debug('frame.commit', {
        height: accountMachine.pendingFrame.height,
        txs: txTypes,
        tokens: tokenIds,
        state: shortHash(frameHash),
      });
      if (shouldLogFullPayloads()) {
        accountLog.trace('frame.commit.payload', {
          txs: accountMachine.pendingFrame.accountTxs,
          offdeltas: deriveAccountFrameOffdeltas(accountMachine.pendingFrame).map(d => d.toString()),
        });
      }

      // PROPOSER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
      // This eliminates fragile manual field copying
      {
        const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
        accountLog.debug('frame.reexecute', {
          height: accountMachine.pendingFrame.height,
          counterparty: shortId(cpForLog),
          txs: accountMachine.pendingFrame.accountTxs.length,
        });

        // Re-execute all frame txs on REAL accountMachine (deterministic)
        // CRITICAL: Use frame.timestamp for determinism (HTLC validation must use agreed consensus time)
        const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.currentHeight;
        for (const tx of accountMachine.pendingFrame.accountTxs) {
          const beforeSettlement = captureSettlementVector(accountMachine);
          const commitResult = await processAccountTx(
            accountMachine,
            tx,
            accountMachine.pendingFrame.byLeft!,
            accountMachine.pendingFrame.timestamp,
            pendingJHeight,
            false,
            env,
          );
          if (!commitResult.success) {
            console.error(`❌ PROPOSER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
            throw new Error(
              `Frame ${accountMachine.pendingFrame.height} commit failed: ${tx.type} - ${commitResult.error}`,
            );
          }
          assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'proposer/commit');
          if (commitResult.timedOutHashlock) {
            timedOutHashlocks.push(commitResult.timedOutHashlock);
          }
        }

        accountLog.debug('frame.commit.complete', {
          side: 'proposer',
          counterparty: shortId(cpForLog),
          height: accountMachine.pendingFrame.height,
          tokens: accountMachine.deltas.size,
        });
        if (shouldLogFullPayloads()) {
          accountLog.trace('frame.commit.deltas', {
            side: 'proposer',
            counterparty: shortId(cpForLog),
            deltas: summarizeDeltasForLog(accountMachine.deltas),
          });
        }

        // Clean up clone (no longer needed with re-execution)
        delete accountMachine.clonedForValidation;

        // CRITICAL: Deep-copy entire pendingFrame to prevent mutation issues
        accountMachine.currentFrame = structuredClone(accountMachine.pendingFrame);
        accountMachine.currentHeight = accountMachine.pendingFrame.height;
        if (input.newDisputeHanko) {
          if (input.disputeProofNonce === undefined || !input.newDisputeHash) {
            console.warn(
              `⚠️ ACK has newDisputeHanko but missing disputeProofNonce or newDisputeHash — skipping dispute metadata`,
            );
          } else {
            // Cryptographic binding: verify hanko actually signs the claimed dispute hash
            const { verifyHankoForHash } = await import('./hanko/signing');
            const { valid: disputeValid } = await verifyHankoForHash(
              input.newDisputeHanko,
              input.newDisputeHash,
              input.fromEntityId,
              env,
            );
            if (!disputeValid) {
              console.warn(`⚠️ ACK dispute hanko fails verification — skipping dispute metadata`);
            } else {
              accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
              const signedCooperativeNonce = input.disputeProofNonce;
              accountMachine.counterpartyDisputeProofNonce = signedCooperativeNonce;
              accountMachine.counterpartyDisputeHash = input.newDisputeHash;
              if (input.newDisputeProofBodyHash) {
                accountMachine.counterpartyDisputeProofBodyHash = input.newDisputeProofBodyHash;
                if (!accountMachine.disputeProofNoncesByHash) {
                  accountMachine.disputeProofNoncesByHash = {};
                }
                accountMachine.disputeProofNoncesByHash[input.newDisputeProofBodyHash] = signedCooperativeNonce;
              }
              accountLog.debug('hanko.dispute_ack_stored', { nonce: signedCooperativeNonce, from: shortId(input.fromEntityId) });
            }
          }
        }

	        const committedFrame = cloneAccountFrame(accountMachine.pendingFrame);
        committedFrames.push({ frame: committedFrame, committedViaNewFrame: false });
        recordAccountFrameHistory(env, {
          entityId: accountMachine.proofHeader.fromEntity,
          counterpartyId: input.fromEntityId,
          accountHeight: committedFrame.height,
          source: 'ackCommit',
          frame: committedFrame,
        });
        // Past bilateral frames are not future-consensus state. Keep only a
        // non-enumerable UI/debug view; durable history lives in the frame DB.
        appendAccountFrameHistoryView(accountMachine, committedFrame);
        accountLog.debug('frame.indexed', { source: 'ackCommit', height: accountMachine.pendingFrame.height });

      }

      // Clear pending state
      const committedHeight = accountMachine.pendingFrame.height;
      delete accountMachine.pendingFrame;
      delete accountMachine.pendingAccountInput;
      delete accountMachine.clonedForValidation;
      if (
        accountMachine.lastOutboundFrameAck &&
        Number(accountMachine.lastOutboundFrameAck.height) < Number(committedHeight)
      ) {
        delete accountMachine.lastOutboundFrameAck;
      }
      markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, input.fromEntityId);
      accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1); // Successful confirmation reduces rollback
      if (accountMachine.rollbackCount === 0) {
        delete accountMachine.lastRollbackFrameHash; // Reset deduplication on full resolution
      }

      events.push(`✅ Frame ${ackHeight} confirmed and committed`);

      // Run auto-rebalance only after pending frame is cleared.
      // Otherwise checkAutoRebalance self-skips with "pendingFrame exists".
      const ackAutoRebalanceTxs = await runPostFrameAutoRebalanceCheck(
        env,
        accountMachine,
        accountMachine.proofHeader.fromEntity,
        input.fromEntityId,
        committedHeight,
      );
      if (ackAutoRebalanceTxs.length > 0) {
        for (const tx of ackAutoRebalanceTxs) {
          accountMachine.mempool.push(tx);
        }
        events.push(`🔄 Auto-rebalance queued ${ackAutoRebalanceTxs.length} tx(s) after ACK commit`);
      }
      kickHubRebalanceAfterFrameFinalize(env, accountMachine.proofHeader.fromEntity);

      // CRITICAL FIX: Chained Proposal - if mempool has items (e.g. j_event_claim), propose immediately
      if (!input.newAccountFrame) {
        if (accountMachine.mempool.length > 0) {
          const proposeResult = await proposeAccountFrame(env, accountMachine);
          if (proposeResult.success && proposeResult.accountInput) {
            return {
              success: true,
              response: proposeResult.accountInput,
              events: [...events, ...proposeResult.events],
              timedOutHashlocks,
              ...(committedFrames.length > 0 && { committedFrames }),
              ...(proposeResult.revealedSecrets && { revealedSecrets: proposeResult.revealedSecrets }),
              ...(proposeResult.swapOffersCreated && { swapOffersCreated: proposeResult.swapOffersCreated }),
              ...(proposeResult.swapCancelRequests && { swapCancelRequests: proposeResult.swapCancelRequests }),
              ...(proposeResult.swapOffersCancelled && { swapOffersCancelled: proposeResult.swapOffersCancelled }),
              ...(proposeResult.hashesToSign &&
                proposeResult.hashesToSign.length > 0 && { hashesToSign: proposeResult.hashesToSign }),
            };
          }
        }
        if (HEAVY_LOGS) console.log(`🔍 RETURN-ACK-ONLY: frame ${ackHeight} ACKed, no new frame bundled`);
        return { success: true, events, timedOutHashlocks, ...(committedFrames.length > 0 && { committedFrames }) };
      }
      // Fall through to process newAccountFrame below
    }
  }

  const pendingFrameHeight = Number(accountMachine.pendingFrame?.height ?? 0);
  const isSameHeightSimultaneousProposal =
    Boolean(input.prevHanko) &&
    Boolean(input.newAccountFrame) &&
    pendingFrameHeight > 0 &&
    Number(input.newAccountFrame?.height ?? 0) === pendingFrameHeight &&
    Number(normalizedInputHeight ?? 0) === pendingFrameHeight - 1;

  // ACK for a pending frame must never be ignored unless this is the valid
  // same-height race case: peer ACKs the last committed frame and proposes the
  // same next height we already have pending. That path is resolved below by
  // the simultaneous-proposal handler.
  if (input.prevHanko && !ackProcessed && accountMachine.pendingFrame && !isSameHeightSimultaneousProposal) {
    const pending = accountMachine.pendingFrame.height;
    const staleAck =
      normalizedInputHeight !== undefined &&
      Number(normalizedInputHeight) > 0 &&
      Number(normalizedInputHeight) <= Number(accountMachine.currentHeight ?? 0);
    if (staleAck) {
      events.push(
        `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} (current=${String(accountMachine.currentHeight ?? 0)}, pending=${String(pending)})`,
      );
      return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
    }
    return {
      success: false,
      error:
        `Unmatched ACK with pending frame: ` +
        `inputHeight=${String(normalizedInputHeight ?? 'none')} ` +
        `pending=${String(pending)} ` +
        `newFrame=${String(input.newAccountFrame?.height ?? 'none')}`,
      events,
    };
  }

  // Handle new frame proposal
  if (input.newAccountFrame) {
    const receivedFrame = input.newAccountFrame;
    if (Number(receivedFrame.height) <= Number(accountMachine.currentHeight ?? 0)) {
      const cachedAck = accountMachine.lastOutboundFrameAck;
      const canReackCommittedFrame =
        Number(receivedFrame.height) === Number(accountMachine.currentHeight ?? 0) &&
        receivedFrame.stateHash === accountMachine.currentFrame?.stateHash &&
        !!cachedAck &&
        Number(cachedAck.height) === Number(receivedFrame.height) &&
        cachedAck.counterpartyEntityId.toLowerCase() === input.fromEntityId.toLowerCase();
      if (canReackCommittedFrame) {
        events.push(
          `↩️ Re-sent ACK for duplicate committed frame ${String(receivedFrame.height)}`,
        );
        return {
          success: true,
          response: {
            kind: 'ack',
            fromEntityId: accountMachine.proofHeader.fromEntity,
            toEntityId: input.fromEntityId,
            height: cachedAck.height,
            prevHanko: cachedAck.prevHanko,
          },
          events,
        };
      }
      events.push(
        `ℹ️ Ignored stale frame ${String(receivedFrame.height)} (current=${String(accountMachine.currentHeight ?? 0)})`,
      );
      return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
    }

    // Validate frame with timestamp checks (HTLC safety)
    const previousTimestamp = accountMachine.currentFrame?.timestamp;
    if (!validateAccountFrame(receivedFrame, env.timestamp, previousTimestamp)) {
      return { success: false, error: 'Invalid frame structure', events };
    }

    // CRITICAL: Verify prevFrameHash links to our current frame (prevent state fork)
    const expectedPrevFrameHash =
      accountMachine.currentHeight === 0 ? 'genesis' : accountMachine.currentFrame.stateHash || '';

    if (receivedFrame.prevFrameHash !== expectedPrevFrameHash) {
      const mismatchDebug = {
        inputFromEntityId: input.fromEntityId,
        inputToEntityId: input.toEntityId,
        inputHeight: normalizedInputHeight ?? null,
        receivedHeight: Number(receivedFrame.height ?? 0),
        receivedStateHash: receivedFrame.stateHash ?? null,
        receivedPrevFrameHash: receivedFrame.prevFrameHash ?? null,
        receivedTxTypes: receivedFrame.accountTxs.map((tx) => tx.type),
        expectedPrevFrameHash,
        account: describeAccountState(),
      };
      console.warn(`⚠️ FRAME-CHAIN: prevHash mismatch at height ${accountMachine.currentHeight}`);
      console.warn(`[A-MACHINE][FRAME-CHAIN-MISMATCH] ${safeStringify(mismatchDebug)}`);
      return {
        success: false,
        error:
          `Frame chain broken: prevFrameHash mismatch ` +
          `(expected ${expectedPrevFrameHash.slice(0, 16)}..., got ${String(receivedFrame.prevFrameHash).slice(0, 16)}..., ` +
          `current=${accountMachine.currentHeight}, pending=${Number(accountMachine.pendingFrame?.height ?? 0)})`,
        events,
      };
    }

    // CHANNEL.TS REFERENCE: Lines 138-165 - Proper rollback logic for simultaneous proposals
    // Handle simultaneous proposals when both sides send same height
    if (accountMachine.pendingFrame && receivedFrame.height === accountMachine.pendingFrame.height) {
      // Deterministic tiebreaker: Left always wins (CHANNEL.TS REFERENCE: Line 140-157)
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      if (HEAVY_LOGS)
        console.log(
          `🔍 TIEBREAKER: fromEntity=${accountMachine.proofHeader.fromEntity.slice(-4)}, toEntity=${accountMachine.proofHeader.toEntity.slice(-4)}, isLeft=${isLeftEntity}`,
        );

      if (isLeftEntity) {
        // We are LEFT - ignore their frame, keep ours (deterministic tiebreaker)
        // EMIT EVENT: Track LEFT wins tiebreaker
        events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
        // CRITICAL FIX: Even though we ignore their frame, check mempool and send update if we have new txs
        // This prevents j_event_claims from getting stuck when both sides propose simultaneously
        if (accountMachine.mempool.length > 0) {
          events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
        // The pending mempool remains local until RIGHT acknowledges our frame.
        }

        // STRICT CONSENSUS: ignored frame must not mutate local account state.
        // In particular, do not salvage j_event_claim from ignored RIGHT frame.
        // Shared-state inputs are allowed to advance only through committed frames.

        // This is NOT an error - it's correct consensus behavior (Channel.ts handlePendingBlock)
        return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
      } else {
        // We are RIGHT - rollback our frame, accept theirs
        // DEDUPLICATION: Check if we already rolled back this exact frame
        const receivedHash = receivedFrame.stateHash;
        if (accountMachine.lastRollbackFrameHash === receivedHash) {
          console.log(
            `⚠️ ROLLBACK-DEDUPE: Already rolled back for frame ${receivedHash.slice(0, 16)}... - ignoring duplicate`,
          );
          // Don't increment rollbackCount again, just process their frame
        } else {
          // Restore transactions to mempool before discarding frame.
          // IMPORTANT: allow repeated RIGHT rollbacks (same-height races can happen
          // under burst traffic); dedupe mempool to avoid tx duplication.
          let restoredTxCount = 0;
          if (accountMachine.pendingFrame) {
            restoredTxCount = accountMachine.pendingFrame.accountTxs.length;
            const uniqueRestored = prependUniqueMempoolTxs(accountMachine, accountMachine.pendingFrame.accountTxs);

            // EMIT EVENT: Track rollback for debugging
            events.push(
              `🔄 ROLLBACK: Discarded our frame ${accountMachine.pendingFrame.height}, restored ${uniqueRestored}/${restoredTxCount} txs to mempool`,
            );
          }

          delete accountMachine.pendingFrame;
          delete accountMachine.pendingAccountInput;
          delete accountMachine.clonedForValidation;
          markStorageAccountDirty(env, accountMachine.proofHeader.fromEntity, input.fromEntityId);
          accountMachine.rollbackCount = Math.max(1, accountMachine.rollbackCount + 1);
          accountMachine.lastRollbackFrameHash = receivedHash; // Track this rollback
          if (accountMachine.rollbackCount > 1) {
            console.warn(
              `⚠️ ROLLBACK-RETRY: repeated RIGHT rollback count=${accountMachine.rollbackCount} (continuing deterministically)`,
            );
          }

          // EMIT EVENT: Track that we accepted LEFT's frame
          events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);

          // Continue to process their frame below
        }
      }
    }

    // NOTE: rollbackCount decrement happens in ACK block (line 547) when pendingFrame confirmed
    // This ensures we only decrement once per rollback resolution (no double-decrement)

    // Verify frame sequence
    if (HEAVY_LOGS)
      console.log(
        `🔍 SEQUENCE-CHECK: receivedFrame.height=${receivedFrame.height}, currentHeight=${accountMachine.currentHeight}, expected=${accountMachine.currentHeight + 1}`,
      );
    if (receivedFrame.height !== accountMachine.currentHeight + 1) {
      console.log(
        `❌ Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`,
      );
      return {
        success: false,
        error: `Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`,
        events,
      };
    }

    // SECURITY: Verify signatures (REQUIRED for all frames)
    // HANKO VERIFICATION: Require hanko for all frames
    const hankoToVerify = input.newHanko;
    if (!hankoToVerify) {
      return { success: false, error: 'SECURITY: Frame must have hanko signature', events };
    }

    accountLog.debug('hanko.frame.verify', { height: receivedFrame.height, from: shortId(input.fromEntityId) });

    // Verify hanko - CRITICAL: Must verify fromEntityId is the signer with board validation
    const { verifyHankoForHash } = await import('./hanko/signing');
    const { valid, entityId: recoveredEntityId } = await verifyHankoForHash(
      hankoToVerify,
      receivedFrame.stateHash,
      input.fromEntityId,
      env,
    );

    if (!valid || !recoveredEntityId) {
      return { success: false, error: `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`, events };
    }

    accountLog.debug('hanko.frame.verified', { height: receivedFrame.height, from: shortId(recoveredEntityId) });

    // Store counterparty's frame hanko
    accountMachine.counterpartyFrameHanko = hankoToVerify;

    // Dispute metadata stored on COMMIT (not here) — input is in scope throughout

    // Get entity's synced J-height for deterministic HTLC validation
    const ourEntityId = accountMachine.proofHeader.fromEntity;
    const ourReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ourEntityId);
    const currentJHeight = ourReplica?.state.lastFinalizedJHeight || 0;
    const frameJHeight = receivedFrame.jHeight ?? currentJHeight;

    // Apply frame transactions to clone (as receiver)
    const clonedMachine = cloneAccountMachine(accountMachine);
    const processEvents: string[] = [];

    accountLog.debug('frame.receiver_validate', {
      height: receivedFrame.height,
      txs: receivedFrame.accountTxs.map(tx => tx.type),
    });
    if (shouldLogFullPayloads()) {
      accountLog.trace('frame.receiver_initial_deltas', {
        height: receivedFrame.height,
        deltas: summarizeDeltasForLog(clonedMachine.deltas),
      });
    }
    const revealedSecrets: Array<{ secret: string; hashlock: string }> = [];
    // AUDIT FIX (CRITICAL-1): SwapOfferEvent carries makerIsLeft + fromEntity/toEntity
    const swapOffersCreated: Array<{
      offerId: string;
      makerIsLeft: boolean;
      fromEntity: string;
      toEntity: string;
      accountId?: string;
      giveTokenId: number;
      giveAmount: bigint;
	      wantTokenId: number;
	      wantAmount: bigint;
	      priceTicks?: bigint | undefined;
	      timeInForce?: 0 | 1 | 2 | undefined;
	      minFillRatio: number;
	    }> = [];
    const swapCancelRequests: Array<{ offerId: string; accountId: string }> = [];
    const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

    for (const accountTx of receivedFrame.accountTxs) {
      // When receiving a frame, we process transactions from counterparty's perspective (incoming)
      // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
      const beforeSettlement = captureSettlementVector(clonedMachine);
      const result = await processAccountTx(
        clonedMachine,
        accountTx,
        receivedFrame.byLeft!, // Channel.ts: frame-level byLeft (same on both sides)
        receivedFrame.timestamp, // DETERMINISTIC: Use frame's consensus timestamp
        frameJHeight, // Frame's consensus J-height
        true, // isValidation = true (on clone, skip bilateral finalization)
        env,
      );
      if (!result.success) {
        return { success: false, error: `Frame application failed: ${result.error}`, events };
      }
      assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'receiver/validate');
      processEvents.push(...result.events);

      if (HEAVY_LOGS) console.log(`🔍 TX-PROCESSED: ${accountTx.type}, success=${result.success}`);
      // Collect revealed secrets (CRITICAL for multi-hop)
      if (result.secret && result.hashlock) {
        revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
      }
      if (result.timedOutHashlock) {
        timedOutHashlocks.push(result.timedOutHashlock);
      }

      // Collect swap offers for orderbook integration
      if (result.swapOfferCreated) {
        swapOffersCreated.push(result.swapOfferCreated);
      }
      if (result.swapOfferCancelRequested) {
        swapCancelRequests.push({
          ...result.swapOfferCancelRequested,
          accountId: input.fromEntityId,
        });
      }
      if (result.swapOfferCancelled) {
        swapOffersCancelled.push(result.swapOfferCancelled);
      }
    }

    // STATE VERIFICATION: Compare deltas directly (both sides compute identically)
    // Extract final state from clonedMachine after processing ALL transactions
    const ourFinalTokenIds: number[] = [];
    const ourFinalDeltas: Delta[] = [];

    const sortedOurTokens = Array.from(clonedMachine.deltas.entries()).sort((a, b) => a[0] - b[0]);
    for (const [tokenId, delta] of sortedOurTokens) {
      // CRITICAL: Use offdelta ONLY for frame comparison (same as proposer)
      // ondelta is set by J-events which have timing dependencies (bilateral finalization)
      // offdelta is set by bilateral transactions (deterministic)
      const totalDelta = delta.offdelta;

      // CONSENSUS FIX: Apply SAME filtering as proposer
      // Skip tokens with zero delta AND zero limits (never used)
      if (!shouldIncludeToken(delta, totalDelta)) {
        console.log(`⏭️  RECEIVER: Skipping unused token ${tokenId} from validation (zero delta/limits/holds)`);
        continue;
      }

      ourFinalTokenIds.push(tokenId);
      ourFinalDeltas.push({ ...delta });
    }

    if (HEAVY_LOGS)
      console.log(
        `🔍 RECEIVER: Computed ${ourFinalTokenIds.length} tokens after filtering: [${ourFinalTokenIds.join(', ')}]`,
      );

    const ourOffdeltas = deriveAccountFrameOffdeltas(ourFinalDeltas);
    const theirOffdeltas = deriveAccountFrameOffdeltas(receivedFrame);

    const ourComputedState = Buffer.from(ourOffdeltas.map(d => d.toString()).join(',')).toString('hex');
    const theirClaimedState = Buffer.from(theirOffdeltas.map(d => d.toString()).join(',')).toString('hex');

    accountLog.debug('frame.state_verify', {
      height: receivedFrame.height,
      ourTokens: ourFinalTokenIds.length,
      theirTokens: deriveAccountFrameTokenIds(receivedFrame).length,
      our: shortHash(ourComputedState),
      their: shortHash(theirClaimedState),
    });
    if (shouldLogFullPayloads()) {
      accountLog.trace('frame.state_verify_payload', {
        height: receivedFrame.height,
        ourTokenIds: ourFinalTokenIds,
        ourOffdeltas: ourOffdeltas.map(d => d.toString()),
        theirTokenIds: deriveAccountFrameTokenIds(receivedFrame),
        theirOffdeltas: theirOffdeltas.map(d => d.toString()),
      });
    }

    if (ourComputedState !== theirClaimedState) {
      // Compact error - full dump only if DEBUG enabled
      console.warn(
        `⚠️ CONSENSUS: Frame ${receivedFrame.height} - state mismatch (our: ${ourComputedState.slice(0, 16)}... vs their: ${theirClaimedState.slice(0, 16)}...)`,
      );
      return { success: false, error: `Bilateral consensus failure - states don't match`, events };
    }

    // SECURITY FIX: Verify BILATERAL fields in deltas (prevents state injection attack)
    // ondelta/collateral may differ due to J-event timing, but bilateral fields MUST match:
    // - offdelta: Set by bilateral payments
    // - creditLimit: Set by bilateral set_credit_limit tx
    // - allowance: Set by bilateral transactions
    const theirDeltas = receivedFrame.deltas;
    if (ourFinalDeltas.length !== theirDeltas.length) {
      console.warn(
        `⚠️ SECURITY: delta count mismatch (our: ${ourFinalDeltas.length}, their: ${theirDeltas.length})`,
      );
      return { success: false, error: `Bilateral state injection detected - delta count mismatch`, events };
    }

    for (let i = 0; i < ourFinalDeltas.length; i++) {
      const ours = ourFinalDeltas[i]!;
      const theirs = theirDeltas[i]!;

      // Compare BILATERAL fields only (ondelta/collateral may differ due to J-event timing)
      const bilateralMismatch =
        ours.offdelta !== theirs.offdelta ||
        ours.leftCreditLimit !== theirs.leftCreditLimit ||
        ours.rightCreditLimit !== theirs.rightCreditLimit ||
        ours.leftAllowance !== theirs.leftAllowance ||
        ours.rightAllowance !== theirs.rightAllowance ||
        (ours.leftHold ?? 0n) !== (theirs.leftHold ?? 0n) ||
        (ours.rightHold ?? 0n) !== (theirs.rightHold ?? 0n);

      if (bilateralMismatch) {
        console.warn(`⚠️ SECURITY: Bilateral field mismatch at token ${ours.tokenId}:`);
        console.warn(`   offdelta: our=${ours.offdelta}, their=${theirs.offdelta}`);
        console.warn(`   leftCreditLimit: our=${ours.leftCreditLimit}, their=${theirs.leftCreditLimit}`);
        console.warn(`   rightCreditLimit: our=${ours.rightCreditLimit}, their=${theirs.rightCreditLimit}`);
        console.warn(`   leftHold: our=${ours.leftHold ?? 0n}, their=${theirs.leftHold ?? 0n}`);
        console.warn(`   rightHold: our=${ours.rightHold ?? 0n}, their=${theirs.rightHold ?? 0n}`);
        return { success: false, error: `Bilateral state injection detected - credit/allowance mismatch`, events };
      }
    }

    if (HEAVY_LOGS) console.log(`🔍 ABOUT-TO-VERIFY-HASH: Computing frame hash...`);
    // Duplex-safe hash validation:
    // - bilateral fields are enforced above (offdelta/limits/allowances)
    // - unilateral fields (collateral/ondelta) may lag between peers until claims converge
    //   so hash must be recomputed from sender payload, not receiver-local unilateral state
    if (HEAVY_LOGS) console.log(`🔍 COMPUTING-HASH: Creating hash for frame ${receivedFrame.height}...`);
    const senderHashFrame: AccountFrame = {
      height: receivedFrame.height,
      timestamp: receivedFrame.timestamp,
      jHeight: receivedFrame.jHeight,
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      deltas: receivedFrame.deltas,
      stateHash: '', // Computed by createFrameHash
      ...(receivedFrame.byLeft === undefined ? {} : { byLeft: receivedFrame.byLeft }),
    };
    const recomputedSenderHash = await createFrameHash(senderHashFrame);

    if (recomputedSenderHash !== receivedFrame.stateHash) {
      console.warn(`⚠️ SECURITY: Frame hash mismatch after validation`);
      console.warn(`   Recomputed: ${recomputedSenderHash.slice(0, 16)}...`);
      console.warn(`   Claimed:    ${receivedFrame.stateHash.slice(0, 16)}...`);
      return { success: false, error: `Frame hash verification failed - dispute proof mismatch`, events };
    }

    accountLog.debug('frame.accept', {
      height: receivedFrame.height,
      from: shortId(input.fromEntityId),
      txs: receivedFrame.accountTxs.map(tx => tx.type),
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSENSUS PRINCIPLE: strict on bilateral fields, tolerant on unilateral lag
    // ═══════════════════════════════════════════════════════════════════════════
    // 1) Bilateral fields (offdelta/limits/allowances) MUST match our execution.
    // 2) Sender frame hash must be self-consistent.
    // 3) Unilateral fields (collateral/ondelta) may temporarily differ until
    //    j_event_claims converge and are finalized 2-of-2 in account state.
    // ═══════════════════════════════════════════════════════════════════════════

    // RECEIVER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
    // This eliminates fragile manual field copying
    const { counterparty: cpForCommitLog } = getAccountPerspective(accountMachine, ourEntityId);
    if (HEAVY_LOGS)
      console.log(
        `🔍 RECEIVER-COMMIT: Re-executing ${receivedFrame.accountTxs.length} txs for ${cpForCommitLog.slice(-4)}`,
      );

    // Re-execute all frame txs on REAL accountMachine (deterministic)
    // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
    for (const tx of receivedFrame.accountTxs) {
      // CRITICAL: Use frame.jHeight for HTLC checks (consensus-aligned height)
      const jHeightForCommit = receivedFrame.jHeight || accountMachine.currentHeight;
      const beforeSettlement = captureSettlementVector(accountMachine);
      const commitResult = await processAccountTx(
        accountMachine,
        tx,
        receivedFrame.byLeft!,
        receivedFrame.timestamp,
        jHeightForCommit,
        false,
        env,
      );

      // CRITICAL: Verify commit succeeded (Codex: prevent silent divergence)
      if (!commitResult.success) {
        console.error(`❌ RECEIVER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
        throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);
      }
      assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'receiver/commit');
    }

    accountLog.debug('frame.commit.complete', {
      side: 'receiver',
      counterparty: shortId(cpForCommitLog),
      height: receivedFrame.height,
      tokens: accountMachine.deltas.size,
    });
    if (shouldLogFullPayloads()) {
      accountLog.trace('frame.commit.deltas', {
        side: 'receiver',
        counterparty: shortId(cpForCommitLog),
        deltas: summarizeDeltasForLog(accountMachine.deltas),
      });
    }

    // CRITICAL: Copy pendingForward for multi-hop routing
    if (clonedMachine.pendingForward) {
      accountMachine.pendingForward = clonedMachine.pendingForward;
      console.log(
        `🔀 Copied pendingForward for multi-hop: route=[${clonedMachine.pendingForward.route.map(r => r.slice(-4)).join(',')}]`,
      );
    }

    // Persist sender frame for hash-chain continuity; shared state is still driven
    // by our own tx re-execution above.
    accountMachine.currentFrame = structuredClone(receivedFrame);
    accountMachine.currentHeight = receivedFrame.height;
    // Store counterparty dispute metadata on COMMIT (verified, frame accepted)
    if (input.newDisputeHanko && !ackProcessed && input.disputeProofNonce !== undefined && input.newDisputeHash) {
      const { verifyHankoForHash } = await import('./hanko/signing');
      const { valid: disputeValid } = await verifyHankoForHash(
        input.newDisputeHanko,
        input.newDisputeHash,
        input.fromEntityId,
        env,
      );
      if (disputeValid) {
        accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
        accountMachine.counterpartyDisputeProofNonce = input.disputeProofNonce;
        accountMachine.counterpartyDisputeHash = input.newDisputeHash;
        if (input.newDisputeProofBodyHash) {
          accountMachine.counterpartyDisputeProofBodyHash = input.newDisputeProofBodyHash;
          if (!accountMachine.disputeProofNoncesByHash) accountMachine.disputeProofNoncesByHash = {};
          accountMachine.disputeProofNoncesByHash[input.newDisputeProofBodyHash] = input.disputeProofNonce;
        }
        accountLog.debug('hanko.dispute_frame_stored', { height: receivedFrame.height, from: shortId(input.fromEntityId) });
      } else {
        console.warn(`⚠️ Dispute hanko verification failed on commit — skipping dispute metadata`);
      }
    }

    const committedFrame = cloneAccountFrame(receivedFrame);
    committedFrames.push({ frame: committedFrame, committedViaNewFrame: true });
    recordAccountFrameHistory(env, {
      entityId: accountMachine.proofHeader.fromEntity,
      counterpartyId: input.fromEntityId,
      accountHeight: committedFrame.height,
      source: 'peerCommit',
      frame: committedFrame,
    });
    // Past bilateral frames are not future-consensus state. Keep only a
    // non-enumerable UI/debug view; durable history lives in the frame DB.
    appendAccountFrameHistoryView(accountMachine, committedFrame);
    accountLog.debug('frame.indexed', { source: 'peerCommit', height: receivedFrame.height });

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // POST-FRAME AUTO-REBALANCE CHECK
    // After frame commit, check if uncollateralized debt exceeds r2cRequestSoftLimit.
    // If yes, auto-queue request_collateral + fee into mempool.
    // User is ALWAYS online here (just processed an inbound frame).
    // ═══════════════════════════════════════════════════════════════════════════
    const postCommitAutoRebalanceTxs = await runPostFrameAutoRebalanceCheck(
      env,
      accountMachine,
      ourEntityId,
      input.fromEntityId,
      receivedFrame.height,
    );
    if (postCommitAutoRebalanceTxs.length > 0) {
      for (const tx of postCommitAutoRebalanceTxs) {
        // Post-commit rebalance is a fresh follow-up account reaction. The
        // received frame is already committed; queuing new account txs into the
        // local mempool here is the correct "next proposal" path, not handler
        // mutation of an in-flight entity frame.
        accountMachine.mempool.push(tx);
      }
      events.push(`🔄 Auto-rebalance queued ${postCommitAutoRebalanceTxs.length} tx(s) after frame commit`);
    }
    kickHubRebalanceAfterFrameFinalize(env, ourEntityId);

    // Send confirmation (ACK) using HANKO
    const ackEntityId = accountMachine.proofHeader.fromEntity;
    const ackReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ackEntityId);
    const ackSignerId = ackReplica?.state.config.validators[0];
    if (!ackSignerId) {
      return { success: false, error: `Cannot find signerId for ACK from ${ackEntityId.slice(-4)}`, events };
    }

    accountLog.debug('hanko.ack.sign', { entity: shortId(ackEntityId), signer: shortId(ackSignerId), height: receivedFrame.height });

    // Build ACK hanko
    const { signEntityHashes } = await import('./hanko/signing');
    const ackHankos = await signEntityHashes(env, ackEntityId, ackSignerId, [receivedFrame.stateHash]);
    const confirmationHanko = ackHankos[0];
    if (!confirmationHanko) {
      return { success: false, error: 'Failed to build ACK hanko', events };
    }

    // CHANNEL.TS PATTERN (Lines 576-612): Batch ACK + new frame in same message!
    // Check if we should batch BEFORE incrementing nonce
    let batchedWithNewFrame = false;
    let proposeResult: Awaited<ReturnType<typeof proposeAccountFrame>> | undefined;
    // Build dispute proof hanko for ACK response (always include current state's dispute proof)
    const { buildAccountProofBody: buildProof, createDisputeProofHash: createHash } = await import('./proof-builder');
    const ackDepositoryAddress = getDepositoryAddress(env);
    if (!isAddress20(ackDepositoryAddress)) {
      return { success: false, error: 'ACK_DISPUTE_PROOF_BUILD_FAILED: MISSING_DEPOSITORY_ADDRESS', events };
    }
    const ackProofResult = buildProof(accountMachine);
    const ackDisputeHash = createHash(accountMachine, ackProofResult.proofBodyHash, ackDepositoryAddress);
    const ackDisputeHankos = await signEntityHashes(env, ackEntityId, ackSignerId, [ackDisputeHash]);
    const ackDisputeHanko = ackDisputeHankos[0];
    const ackSignedNonce = accountMachine.proofHeader.nonce;
    if (!accountMachine.disputeProofNoncesByHash) {
      accountMachine.disputeProofNoncesByHash = {};
    }
    accountMachine.disputeProofNoncesByHash[ackProofResult.proofBodyHash] = ackSignedNonce;
    if (!accountMachine.disputeProofBodiesByHash) {
      accountMachine.disputeProofBodiesByHash = {};
    }
    accountMachine.disputeProofBodiesByHash[ackProofResult.proofBodyHash] = ackProofResult.proofBodyStruct;

    const response = {
      kind: 'ack',
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedFrame.height,
      prevHanko: confirmationHanko, // Hanko ACK on their frame
      ...(ackDisputeHanko && { newDisputeHanko: ackDisputeHanko }), // My dispute proof hanko (current state)
      newDisputeHash: ackDisputeHash, // Full dispute hash (key in hankoWitness for quorum lookup)
      newDisputeProofBodyHash: ackProofResult.proofBodyHash, // ProofBodyHash that ackDisputeHanko signs
      disputeProofNonce: ackSignedNonce, // nonce at which ACK's dispute proof was signed
    } as AccountInput;
    const outboundAck = {
      height: receivedFrame.height,
      counterpartyEntityId: input.fromEntityId,
      prevHanko: confirmationHanko,
    };

    if (HEAVY_LOGS)
      console.log(
        `🔍 BATCH-CHECK for account ${input.fromEntityId.slice(-4)}: mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, mempoolTxs=[${accountMachine.mempool.map(tx => tx.type).join(',')}]`,
      );
    if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
      // Pass skipNonceIncrement=true since we'll increment for the whole batch below
      proposeResult = await proposeAccountFrame(env, accountMachine, true);

      if (proposeResult.success && proposeResult.accountInput) {
        batchedWithNewFrame = true;
        response.kind = 'frame_ack';
        // Merge ACK and new proposal into same AccountInput
        if (proposeResult.accountInput.newAccountFrame) {
          response.newAccountFrame = proposeResult.accountInput.newAccountFrame;
        }
        if (proposeResult.accountInput.newHanko) {
          response.newHanko = proposeResult.accountInput.newHanko;
        }
        // When ACK and next frame are bundled, the attached dispute proof must
        // describe the bundled proposal state. Sending ACK dispute metadata
        // alongside proposal frame data mixes hashes/nonces and poisons the
        // counterparty's stored dispute proof for the latest agreed state.
        if (proposeResult.accountInput.newDisputeHanko) {
          response.newDisputeHanko = proposeResult.accountInput.newDisputeHanko;
        } else {
          delete response.newDisputeHanko;
        }
        if (proposeResult.accountInput.newDisputeHash) {
          response.newDisputeHash = proposeResult.accountInput.newDisputeHash;
        } else {
          delete response.newDisputeHash;
        }
        if (proposeResult.accountInput.newDisputeProofBodyHash) {
          response.newDisputeProofBodyHash = proposeResult.accountInput.newDisputeProofBodyHash;
        } else {
          delete response.newDisputeProofBodyHash;
        }
        if (proposeResult.accountInput.disputeProofNonce !== undefined) {
          response.disputeProofNonce = proposeResult.accountInput.disputeProofNonce;
        } else {
          delete response.disputeProofNonce;
        }

        const newFrameId = proposeResult.accountInput.newAccountFrame?.height || 0;
        events.push(`📤 Batched ACK + frame ${newFrameId}`);
      }
    }

    if (!batchedWithNewFrame) {
      accountMachine.lastOutboundFrameAck = outboundAck;
      if (ackDisputeHanko) {
        accountMachine.currentDisputeProofHanko = ackDisputeHanko;
        accountMachine.currentDisputeProofNonce = ackSignedNonce;
        accountMachine.currentDisputeProofBodyHash = ackProofResult.proofBodyHash;
        accountMachine.currentDisputeHash = ackDisputeHash;
      }
    } else if (batchedWithNewFrame) {
      delete accountMachine.lastOutboundFrameAck;
    }

    // Increment nonce for this message (on-chain nonce for dispute proofs / settlements)
    ++accountMachine.proofHeader.nonce;

    // Merge revealed secrets from BOTH incoming frame AND proposed frame
    const allRevealedSecrets = [
      ...revealedSecrets, // From incoming frame (line 493)
      ...(proposeResult?.revealedSecrets || []), // From our proposed frame (if batched)
    ];

    // Merge swap offers from BOTH incoming frame AND proposed frame
    const allSwapOffersCreated = [...swapOffersCreated, ...(proposeResult?.swapOffersCreated || [])];
    const allSwapCancelRequests = [...swapCancelRequests, ...(proposeResult?.swapCancelRequests || [])];
    const allSwapOffersCancelled = [...swapOffersCancelled, ...(proposeResult?.swapOffersCancelled || [])];

    // Collect hashes that need entity-quorum signing (multi-signer support)
    const hashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [
      {
        hash: receivedFrame.stateHash,
        type: 'accountFrame',
        context: `account:${input.fromEntityId.slice(-8)}:ack:${receivedFrame.height}`,
      },
      ...(!batchedWithNewFrame
        ? [{ hash: ackDisputeHash, type: 'dispute' as const, context: `account:${input.fromEntityId.slice(-8)}:ack-dispute` }]
        : []),
      ...(proposeResult?.hashesToSign || []), // From batched proposal
    ];

    if (HEAVY_LOGS)
      console.log(
        `🔍 RETURN-RESPONSE: h=${response.height} prevHanko=${!!response.prevHanko} newFrame=${!!response.newAccountFrame}`,
      );
    return {
      success: true,
      response,
      events,
      revealedSecrets: allRevealedSecrets,
      swapOffersCreated: allSwapOffersCreated,
      swapCancelRequests: allSwapCancelRequests,
      swapOffersCancelled: allSwapOffersCancelled,
      timedOutHashlocks,
      ...(committedFrames.length > 0 && { committedFrames }),
      ...(hashesToSign.length > 0 && { hashesToSign }),
    };
  }

  // ACK inputs must never be silently ignored; this causes replay divergence.
  if (input.prevHanko && !ackProcessed && !input.newAccountFrame) {
    const pending = accountMachine.pendingFrame?.height ?? 'none';
    const staleAck =
      normalizedInputHeight !== undefined &&
      Number(normalizedInputHeight) > 0 &&
      Number(normalizedInputHeight) <= Number(accountMachine.currentHeight ?? 0);
    if (staleAck) {
      events.push(
        `ℹ️ Ignored stale ACK for frame ${String(normalizedInputHeight)} (current=${String(accountMachine.currentHeight ?? 0)}, pending=${String(pending)})`,
      );
      return { success: true, events, ...(committedFrames.length > 0 && { committedFrames }) };
    }
    return {
      success: false,
      error: `Unmatched ACK: height=${String(normalizedInputHeight ?? 'none')} pending=${String(pending)}`,
      events,
    };
  }

  if (HEAVY_LOGS) console.log(`🔍 RETURN-NO-RESPONSE: No response object`);
  return {
    success: true,
    events,
    swapOffersCreated: [],
    swapCancelRequests: [],
    swapOffersCancelled: [],
    timedOutHashlocks,
    ...(committedFrames.length > 0 && { committedFrames }),
  };
}

// === E-MACHINE INTEGRATION ===

/**
 * Add transaction to account mempool with limits
 */
export function addToAccountMempool(accountMachine: AccountMachine, accountTx: AccountTx): boolean {
  if (accountMachine.mempool.length >= MEMPOOL_LIMIT) {
    console.log(`❌ Mempool full: ${accountMachine.mempool.length} >= ${MEMPOOL_LIMIT}`);
    return false;
  }

  accountMachine.mempool.push(accountTx);
  return true;
}

/**
 * Check if account should auto-propose frame
 */
export function shouldProposeFrame(accountMachine: AccountMachine): boolean {
  // Should propose if:
  // 1. Has transactions in mempool
  // 2. No pending frame waiting for confirmation
  const should = accountMachine.mempool.length > 0 && !accountMachine.pendingFrame;
  if (HEAVY_LOGS) {
    console.log(
      `   shouldProposeFrame: mempool=${accountMachine.mempool.length}, pending=${!!accountMachine.pendingFrame}, result=${should}`,
    );
  }
  return should;
}

/**
 * Get accounts that should propose frames (for E-Machine auto-propose)
 * @param entityState - Entity state containing accounts to check
 */
export function getAccountsToProposeFrames(entityState: EntityState): string[] {
  const accountsToProposeFrames: string[] = [];

  // Check if accounts exists and is iterable
  if (!entityState.accounts || !(entityState.accounts instanceof Map)) {
    console.log(`⚠️ No accounts or accounts not a Map: ${typeof entityState.accounts}`);
    return accountsToProposeFrames;
  }

  for (const [accountKey, accountMachine] of entityState.accounts) {
    if (shouldProposeFrame(accountMachine)) {
      accountsToProposeFrames.push(accountKey);
    }
  }

  return accountsToProposeFrames;
}

// === PROOF GENERATION (for future J-Machine integration) ===

/**
 * Generate account proof for dispute resolution (like old_src Channel.getSubchannelProofs)
 * Must be ABI-compatible with Depository contract
 *
 * DUAL-TRACK APPROACH:
 * - proofBody: Simple internal representation (tokenIds + deltas)
 * - abiProofBody: ABI-encoded for on-chain disputes (includes transformers)
 */
export async function generateAccountProof(
  env: Env,
  accountMachine: AccountMachine,
): Promise<{
  proofHash: string;
  signature: string;
  abiEncodedProofBody?: string;
  abiProofBodyHash?: string;
}> {
  // Update simple proofBody with current state (like old_src does before signing)
  accountMachine.proofBody = {
    tokenIds: Array.from(accountMachine.deltas.keys()).sort((a, b) => a - b), // Deterministic order
    deltas: Array.from(accountMachine.deltas.keys())
      .sort((a, b) => a - b)
      .map(tokenId => {
        const delta = accountMachine.deltas.get(tokenId);
        if (!delta) {
          console.warn(`Missing delta for token ${tokenId}`);
          throw new Error(`Critical financial data missing: delta for token ${tokenId}`);
        }
        return delta.ondelta + delta.offdelta; // Total delta for each token
      }),
  };

  // Build ABI-encoded proofBody for on-chain disputes
  const { buildAccountProofBody } = await import('./proof-builder.js');
  const abiResult = buildAccountProofBody(accountMachine);

  // Store ABI-encoded proofBody for later dispute submission
  accountMachine.abiProofBody = {
    encodedProofBody: abiResult.encodedProofBody,
    proofBodyHash: abiResult.proofBodyHash,
    lastUpdatedHeight: accountMachine.currentHeight,
  };

  // Create proof structure expected by Depository.sol.
  const proofData = {
    fromEntity: accountMachine.proofHeader.fromEntity,
    toEntity: accountMachine.proofHeader.toEntity,
    nonce: accountMachine.proofHeader.nonce,
    tokenIds: accountMachine.proofBody.tokenIds,
    deltas: accountMachine.proofBody.deltas.map(d => d.toString()), // Convert BigInt for JSON
  };

  // Create deterministic proof hash using browser-compatible crypto
  const proofContent = safeStringify(proofData);
  const fullHash = await hash(proofContent);
  const proofHash = fullHash.slice(2); // Remove 0x prefix for compatibility

  // Generate hanko signature - CRITICAL: Use signerId, not entityId
  const proofEntityId = accountMachine.proofHeader.fromEntity;
  const proofReplica = Array.from(env.eReplicas.values()).find(
    (r: EntityReplica) => r.state.entityId === proofEntityId,
  );
  const proofSignerId = proofReplica?.state.config.validators[0];
  if (!proofSignerId) {
    throw new Error(`Cannot find signerId for proof from ${proofEntityId.slice(-4)}`);
  }
  console.log(`🔐 PROOF-SIGN: entityId=${proofEntityId.slice(-4)} → signerId=${proofSignerId.slice(-4)}`);
  const signature = signAccountFrame(env, proofSignerId, `0x${proofHash}`);

  // Store signature for later use
  accountMachine.hankoSignature = signature;

  console.log(`Generated account proof: ${accountMachine.proofBody.tokenIds.length} tokens`);
  console.log(`  Simple hash: 0x${proofHash.slice(0, 20)}...`);
  console.log(`  ABI hash: ${abiResult.proofBodyHash.slice(0, 20)}...`);
  console.log(`  Locks: ${accountMachine.locks.size}, Swaps: ${accountMachine.swapOffers.size}`);

  return {
    proofHash: `0x${proofHash}`,
    signature,
    abiEncodedProofBody: abiResult.encodedProofBody,
    abiProofBodyHash: abiResult.proofBodyHash,
  };
}
