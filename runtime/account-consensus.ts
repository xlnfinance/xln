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

import type { AccountMachine, AccountFrame, AccountTx, AccountInput, AccountInputProposal, AccountInputAck, Env, EntityState, Delta, EntityReplica, Result } from './types';
import { Ok, Err, isOk, isErr } from './types';

/** Type guard: input has frame-level consensus fields (proposal or ack) */
function isFrameInput(input: AccountInput): input is AccountInputProposal | AccountInputAck {
  return input.type === 'proposal' || input.type === 'ack';
}
import { cloneAccountMachine, getAccountPerspective } from './state-helpers';
import { isLeft } from './account-utils';
import { signAccountFrame, verifyAccountSignature } from './account-crypto';
import { cryptoHash as hash, formatEntityId, HEAVY_LOGS } from './utils';
import { logError } from './logger';
import { safeStringify } from './serialization-utils';
import { validateAccountFrame as validateAccountFrameStrict } from './validation-utils';
import { processAccountTx } from './account-tx/apply';
// NOTE: Settlements now use SettlementWorkspace flow (see entity-tx/handlers/settle.ts)

// Removed createValidAccountSnapshot - using simplified AccountSnapshot interface

// === CONSTANTS ===
const MEMPOOL_LIMIT = 1000;

/**
 * Get depositoryAddress from environment (BrowserVM or active J-replica)
 * CRITICAL for replay protection - domain separator for signatures
 */
function getDepositoryAddress(env: Env): string {
  console.log(`🔍 GET-DEPOSITORY-ADDRESS CALLED`);
  // Try BrowserVM first (most common)
  if (env.browserVM) {
    const browserVM = env.browserVM;
    const getAddress = browserVM.getDepositoryAddress?.() || browserVM.browserVM?.getDepositoryAddress?.();
    console.log(`🔍 getDepositoryAddress: browserVM.getDepositoryAddress=${getAddress}`);
    if (getAddress && getAddress !== '0x0000000000000000000000000000000000000000') {
      return getAddress;
    }
  }

  // Try active jurisdiction
  if (env.activeJurisdiction) {
    const jReplica = env.jReplicas.get(env.activeJurisdiction);
    if (jReplica?.depositoryAddress) {
      return jReplica.depositoryAddress;
    }
    // Fallback to legacy contracts.depository
    if (jReplica?.contracts?.depository) {
      return jReplica.contracts.depository;
    }
  }

  // Fallback: first J-replica with depositoryAddress
  for (const jReplica of env.jReplicas.values()) {
    if (jReplica.depositoryAddress) {
      return jReplica.depositoryAddress;
    }
    // Fallback to legacy contracts.depository
    if (jReplica.contracts?.depository) {
      return jReplica.contracts.depository;
    }
  }

  // Last resort: return zero address (will fail verification but won't crash)
  console.warn('[account-consensus] ⚠️ No depositoryAddress found in env - using zero address (signatures will fail!)');
  return '0x0000000000000000000000000000000000000000';
}
const MAX_FRAME_TIMESTAMP_DRIFT_MS = 300000; // 5 minutes
const MAX_FRAME_SIZE_BYTES = 1048576; // 1MB frame size limit (Bitcoin block size standard)

function shouldIncludeToken(delta: Delta, totalDelta: bigint): boolean {
  const hasHolds = (delta.leftHtlcHold || 0n) !== 0n ||
                   (delta.rightHtlcHold || 0n) !== 0n ||
                   (delta.leftSwapHold || 0n) !== 0n ||
                   (delta.rightSwapHold || 0n) !== 0n ||
                   (delta.leftSettleHold || 0n) !== 0n ||
                   (delta.rightSettleHold || 0n) !== 0n;

  return !(totalDelta === 0n &&
           delta.leftCreditLimit === 0n &&
           delta.rightCreditLimit === 0n &&
           !hasHolds);
}

// === VALIDATION ===

/**
 * Validate account frame (frame-level validation)
 */
export function validateAccountFrame(
  frame: AccountFrame,
  currentTimestamp?: number,
  previousFrameTimestamp?: number
): boolean {
  if (frame.height < 0) return false;
  if (typeof frame.jHeight !== 'number' || frame.jHeight < 0) return false;
  if (frame.accountTxs.length > 100) return false;
  if (frame.tokenIds.length !== frame.deltas.length) return false;

  // CRITICAL: Timestamp validation for HTLC safety
  if (currentTimestamp !== undefined) {
    // Check drift (prevent clock manipulation)
    if (Math.abs(frame.timestamp - currentTimestamp) > MAX_FRAME_TIMESTAMP_DRIFT_MS) {
      console.log(`❌ Frame timestamp drift too large: ${frame.timestamp} vs ${currentTimestamp}`);
      return false;
    }

    // Ensure non-decreasing timestamps (prevent time-travel attacks on HTLCs)
    // Allow equal timestamps (batched frames), but reject backwards movement
    if (previousFrameTimestamp !== undefined && frame.timestamp < previousFrameTimestamp - 1000) {
      console.log(`❌ Frame timestamp went backwards significantly: ${frame.timestamp} < ${previousFrameTimestamp} (delta: ${previousFrameTimestamp - frame.timestamp}ms)`);
      return false;
    }
  }

  return true;
}

// Counter-based replay protection REMOVED — frame chain (height + prevFrameHash) handles replay.
// cooperativeNonce is kept for on-chain dispute domain only.

// === FRAME HASH COMPUTATION ===

async function createFrameHash(frame: AccountFrame): Promise<string> {
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
      data: tx.data
    })),
    tokenIds: frame.tokenIds,
    deltas: frame.deltas.map(d => d.toString()), // Quick access sums
    // AUDIT FIX: Include FULL delta state (credit limits, allowances, collateral, HTLC holds)
    fullDeltaStates: frame.fullDeltaStates?.map(delta => ({
      tokenId: delta.tokenId,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      leftCreditLimit: delta.leftCreditLimit.toString(),
      rightCreditLimit: delta.rightCreditLimit.toString(),
      leftAllowance: delta.leftAllowance.toString(),
      rightAllowance: delta.rightAllowance.toString(),
      leftHtlcHold: (delta.leftHtlcHold || 0n).toString(),   // HTLC holds
      rightHtlcHold: (delta.rightHtlcHold || 0n).toString(), // HTLC holds
      leftSwapHold: (delta.leftSwapHold || 0n).toString(),   // Swap holds
      rightSwapHold: (delta.rightSwapHold || 0n).toString(), // Swap holds
      leftSettleHold: (delta.leftSettleHold || 0n).toString(),   // Settlement holds
      rightSettleHold: (delta.rightSettleHold || 0n).toString(), // Settlement holds
    }))
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

// === RESULT TYPES ===
export interface ProposeSuccess {
  accountInput: AccountInput;
  events: string[];
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
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
  failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
}

export interface ProposeError {
  error: string;
  events: string[];
  failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
}

export interface HandleSuccess {
  response?: AccountInput;
  events: string[];
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
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  timedOutHashlocks?: string[];
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
}

export interface HandleError {
  error: string;
  events: string[];
}

/**
 * Propose account frame (like old_src Channel consensus)
 */
export async function proposeAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
  skipNonceIncrement: boolean = false,
  entityJHeight?: number // Optional: J-height from entity state for HTLC consensus
): Promise<Result<ProposeSuccess, ProposeError>> {
  // Derive counterparty from canonical left/right
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  const quiet = env.quietRuntimeLogs === true;
  if (!quiet) {
    console.log(`🚀 E-MACHINE: Proposing account frame for ${counterparty.slice(-4)}`);
    console.log(`🚀 E-MACHINE: Account state - mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.proposal}, currentHeight=${accountMachine.currentHeight}`);
  }

  const events: string[] = [];

  // Mempool size validation
  if (accountMachine.mempool.length > MEMPOOL_LIMIT) {
    console.log(`❌ E-MACHINE: Mempool overflow ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`);
    return Err({ error: `Mempool overflow: ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`, events });
  }

  if (accountMachine.mempool.length === 0) {
    console.log(`❌ E-MACHINE: No transactions in mempool to propose`);
    return Err({ error: 'No transactions to propose', events });
  }

  // Check if we have a pending frame waiting for ACK
  if (accountMachine.proposal) {
    if (!quiet) console.log(`⏳ E-MACHINE: Still waiting for ACK on pending frame #${accountMachine.proposal.pendingFrame.height}`);
    return Err({ error: 'Waiting for ACK on pending frame', events });
  }

  if (!quiet) console.log(`✅ E-MACHINE: Creating frame with ${accountMachine.mempool.length} transactions...`);
  if (HEAVY_LOGS) console.log(`🔍 PROOF-HEADER: from=${formatEntityId(accountMachine.proofHeader.fromEntity)}, to=${formatEntityId(accountMachine.proofHeader.toEntity)}`);

  // Clone account machine for validation
  const clonedMachine = cloneAccountMachine(accountMachine);
  // Dispute nonce tracks committed frame height for counter-dispute support
  clonedMachine.proofHeader.disputeNonce = accountMachine.currentHeight + 1;

  // Get entity's synced J-height for deterministic HTLC validation
  const ourEntityId = accountMachine.proofHeader.fromEntity;
  const ourReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ourEntityId);
  const currentJHeight = ourReplica?.state.lastFinalizedJHeight || 0;
  const frameJHeight = entityJHeight ?? currentJHeight;

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
    accountId?: string;  // Enriched by entity handler
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    minFillRatio: number;
  }> = [];
  const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

  if (HEAVY_LOGS) console.log(`🔍 MEMPOOL-BEFORE-PROCESS: ${accountMachine.mempool.length} txs:`, accountMachine.mempool.map(tx => tx.type));

  const validTxs: typeof accountMachine.mempool = [];
  const failedHtlcLocks: Array<{ hashlock: string; reason: string }> = [];
  const txsToRemove: typeof accountMachine.mempool = [];

  for (const accountTx of accountMachine.mempool) {
    if (HEAVY_LOGS) console.log(`   🔍 Processing accountTx type=${accountTx.type}`);
    // Channel.ts: byLeft = proposer is left entity (frame-level, same on both sides)
    const proposerByLeft = accountMachine.leftEntity === accountMachine.proofHeader.fromEntity;
    const result = await processAccountTx(
      clonedMachine,
      accountTx,
      proposerByLeft,
      env.timestamp, // Will be replaced by frame.timestamp during commit
      frameJHeight,  // Entity's synced J-height
      true // isValidation = true (on clone, skip persistent state updates)
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
        console.log(`⬅️ Failed htlc_lock queued for cancel: hashlock=${accountTx.data.hashlock.slice(0,12)}...`);
      }
      continue; // Skip to next tx
    }

    validTxs.push(accountTx);
    allEvents.push(...result.events);

    // Collect revealed secrets for backward propagation
    if (HEAVY_LOGS) console.log(`🔍 TX-RESULT: type=${accountTx.type}, hasSecret=${!!result.secret}, hasHashlock=${!!result.hashlock}`);
    if (result.secret && result.hashlock) {
      if (!quiet) console.log(`✅ Collected secret from ${accountTx.type}`);
      revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
    }

    // Collect swap offers for orderbook integration
    if (result.swapOfferCreated) {
      if (!quiet) console.log(`📊 Collected swap offer: ${result.swapOfferCreated.offerId}`);
      swapOffersCreated.push(result.swapOfferCreated);
    }

    // Collect cancelled offers for orderbook cleanup
    if (result.swapOfferCancelled) {
      if (!quiet) console.log(`📊 Collected swap cancel: ${result.swapOfferCancelled.offerId}`);
      swapOffersCancelled.push(result.swapOfferCancelled);
    }
  }

  // Remove failed txs from mempool
  for (const tx of txsToRemove) {
    const idx = accountMachine.mempool.indexOf(tx);
    if (idx >= 0) accountMachine.mempool.splice(idx, 1);
  }

  // If no valid txs remain after filtering, return early
  if (validTxs.length === 0) {
    return Err({
      error: 'All transactions failed validation',
      events: allEvents,
      ...(failedHtlcLocks.length > 0 ? { failedHtlcLocks } : {}),
    });
  }

  // CRITICAL FIX: Extract FULL delta state from clonedMachine.deltas (after processing)
  // Include ALL fields (credit limits, allowances, collateral) for dispute proofs
  const finalTokenIds: number[] = [];
  const finalDeltas: bigint[] = [];
  const fullDeltaStates: import('./types').Delta[] = [];

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

    finalTokenIds.push(tokenId);
    finalDeltas.push(totalDelta);
    // AUDIT FIX: Store FULL delta state (collateral, credit limits, allowances)
    fullDeltaStates.push({ ...delta });
  }

  if (!quiet) {
    console.log(`📊 Frame state after processing: ${finalTokenIds.length} tokens`);
    if (HEAVY_LOGS) {
      console.log(`📊 TokenIds: [${finalTokenIds.join(', ')}]`);
      console.log(`📊 Deltas: [${finalDeltas.map(d => d.toString()).join(', ')}]`);
      console.log(`📊 FullDeltaStates:`, fullDeltaStates.map(d => ({
        tokenId: d.tokenId,
        collateral: d.collateral?.toString(),
        leftCreditLimit: d.leftCreditLimit?.toString(),
        rightCreditLimit: d.rightCreditLimit?.toString(),
      })));
    }
  }

  // Determine if we're left entity (for byLeft field)
  const weAreLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  // Ensure monotonic timestamps within account (HTLC safety + multi-runtime compatibility)
  // In multi-runtime P2P scenarios, different runtimes may have different clock rates
  // We ensure frames always have increasing timestamps within an account chain
  const previousTimestamp = accountMachine.currentFrame?.timestamp ?? 0;
  const frameTimestamp = Math.max(env.timestamp, previousTimestamp + 1);
  if (frameTimestamp > env.timestamp && HEAVY_LOGS) {
    console.log(`⚡ TIMESTAMP-SYNC: Using monotonic timestamp ${frameTimestamp} (prev=${previousTimestamp}, env=${env.timestamp})`);
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
    prevFrameHash: accountMachine.currentHeight === 0
      ? 'genesis'
      : accountMachine.currentFrame.stateHash || '',
    stateHash: '', // Will be filled after hash calculation
    byLeft: weAreLeft, // Who proposed this frame
    tokenIds: finalTokenIds, // Use computed state from clonedMachine.deltas
    deltas: finalDeltas,      // Quick access: ondelta+offdelta sums
    fullDeltaStates          // AUDIT FIX: Full Delta objects for dispute proofs
  };

  // Calculate state hash (frameData is properly typed AccountFrame)
  frameData.stateHash = await createFrameHash(frameData as AccountFrame);

  // Debug: log what's being hashed at creation time
  if (HEAVY_LOGS) {
    console.log(`[HASH-DEBUG] Frame creation for ${accountMachine.proofHeader.toEntity.slice(-4)}:`);
    console.log(`  height: ${frameData.height}`);
    console.log(`  timestamp: ${frameData.timestamp}`);
    console.log(`  jHeight: ${frameData.jHeight}`);
    console.log(`  prevFrameHash: ${frameData.prevFrameHash?.slice(0,20)}...`);
    console.log(`  accountTxs count: ${frameData.accountTxs.length}`);
    console.log(`  accountTxs types: [${frameData.accountTxs.map(tx => tx.type).join(', ')}]`);
    console.log(`  tokenIds: [${frameData.tokenIds.join(', ')}]`);
    console.log(`  deltas: [${frameData.deltas.map(d => d.toString()).join(', ')}]`);
    console.log(`  fullDeltaStates count: ${fullDeltaStates.length}`);
    console.log(`  byLeft: ${frameData.byLeft}`);
    console.log(`  stateHash: ${frameData.stateHash}`);
  }

  // VALIDATE AT SOURCE: Guaranteed type safety from this point forward
  let newFrame: AccountFrame;
  try {
    newFrame = validateAccountFrameStrict(frameData, 'proposeAccountFrame');
  } catch (error) {
    console.warn(`⚠️ Frame validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return Err({
      error: `Frame validation failed: ${(error as Error).message}`,
      events,
    });
  }

  // Validate frame size (Bitcoin 1MB block limit)
  const frameSize = safeStringify(newFrame).length;
  if (frameSize > MAX_FRAME_SIZE_BYTES) {
    console.warn(`⚠️ Frame too large: ${frameSize} bytes`);
    return Err({
      error: `Frame exceeds 1MB limit: ${frameSize} bytes`,
      events,
    });
  }
  console.log(`✅ Frame size: ${frameSize} bytes (${(frameSize / MAX_FRAME_SIZE_BYTES * 100).toFixed(2)}% of 1MB limit)`);

  // Generate HANKO signature - CRITICAL: Use signerId, not entityId
  // For single-signer entities, build hanko with single EOA signature
  const signingEntityId = accountMachine.proofHeader.fromEntity;
  const signingReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === signingEntityId);
  if (!signingReplica) {
    return Err({ error: `Cannot find replica for entity ${signingEntityId.slice(-4)}`, events });
  }
  const signingSignerId = signingReplica.state.config.validators[0]; // Single-signer: use first validator
  if (!signingSignerId) {
    return Err({ error: `Entity ${signingEntityId.slice(-4)} has no validators`, events });
  }

  console.log(`🔐 HANKO-SIGN: entityId=${signingEntityId.slice(-4)} → signerId=${signingSignerId.slice(-4)}`);

  // Build hanko for account frame
  const { signHashesAsSingleEntity } = await import('./hanko-signing');
  // Sign frame hash for bilateral consensus
  const hankos = await signHashesAsSingleEntity(env, signingEntityId, signingSignerId, [newFrame.stateHash]);
  const frameHanko = hankos[0];
  if (!frameHanko) {
    return Err({ error: 'Failed to build frame hanko', events });
  }
  accountMachine.currentFrameHanko = frameHanko;

  // Build dispute proof and sign it (CRITICAL: always sign dispute proof with every frame)
  // BUG FIX: Use clonedMachine (has NEW state after txs) NOT accountMachine (old state)
  const { buildAccountProofBody, createDisputeProofHash } = await import('./proof-builder');
  const depositoryAddress = getDepositoryAddress(env);
  console.log(`🔐 DISPUTE-SIGN: depositoryAddress=${depositoryAddress}, counterparty=${accountMachine.proofHeader.toEntity.slice(-4)}`);
  const proofResult = buildAccountProofBody(clonedMachine);
  const disputeHash = createDisputeProofHash(clonedMachine, proofResult.proofBodyHash, depositoryAddress);
  console.log(`🔐 DISPUTE-SIGN: disputeHash=${disputeHash.slice(0, 18)}..., proofBodyHash=${proofResult.proofBodyHash.slice(0, 18)}...`);

  const disputeHankos = await signHashesAsSingleEntity(env, signingEntityId, signingSignerId, [disputeHash]);
  const disputeHanko = disputeHankos[0];
  if (!disputeHanko) {
    return Err({ error: 'Failed to build dispute hanko', events });
  }
  accountMachine.currentDisputeProofHanko = disputeHanko;
  accountMachine.currentDisputeProofCooperativeNonce = clonedMachine.proofHeader.cooperativeNonce;
  accountMachine.currentDisputeProofBodyHash = proofResult.proofBodyHash;
  if (!accountMachine.disputeProofNoncesByHash) {
    accountMachine.disputeProofNoncesByHash = {};
  }
  accountMachine.disputeProofNoncesByHash[proofResult.proofBodyHash] = clonedMachine.proofHeader.cooperativeNonce;
  if (!accountMachine.disputeProofBodiesByHash) {
    accountMachine.disputeProofBodiesByHash = {};
  }
  accountMachine.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;

  // NOTE: Settlements are now handled via SettlementWorkspace flow (entity-tx/handlers/settle.ts)
  // The old frame-level settlement signing was removed (deprecated buildSettlementDiffs)

  console.log(`✅ Signed frame + dispute proof for account ${accountMachine.proofHeader.toEntity.slice(-4)}`);

  // Clear mempool (failed txs already removed above)
  accountMachine.mempool = [];

  events.push(`🚀 Proposed frame ${newFrame.height} with ${newFrame.accountTxs.length} transactions`);

  const accountInput: AccountInput = {
    type: 'proposal' as const,
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: newFrame.height,
    newAccountFrame: newFrame,
    newHanko: frameHanko,         // Hanko on frame stateHash
    newDisputeHanko: disputeHanko, // Hanko on dispute proof hash
    newDisputeHash: disputeHash,   // Full dispute hash (key in hankoWitness for quorum lookup)
    newDisputeProofBodyHash: proofResult.proofBodyHash, // ProofBodyHash that disputeHanko signs
    // NOTE: Settlement hankos now handled via SettlementWorkspace (entity-tx/handlers/settle.ts)
    disputeProofNonce: accountMachine.proofHeader.cooperativeNonce, // nonce at which dispute proof was signed (before increment)
  };
  if (!skipNonceIncrement) ++accountMachine.proofHeader.cooperativeNonce;

  // Bundle all pending state into proposal
  accountMachine.proposal = {
    pendingFrame: newFrame,
    pendingSignatures: [],
    pendingAccountInput: accountInput,
  };
  console.log(`🔒 PROPOSE: Account ${accountMachine.proofHeader.fromEntity.slice(-4)}:${accountMachine.proofHeader.toEntity.slice(-4)} pendingFrame=${newFrame.height}, txs=${newFrame.accountTxs.length}`);

  // Collect hashes for entity-quorum signing (multi-signer support)
  const hashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [
    { hash: newFrame.stateHash, type: 'accountFrame', context: `account:${counterparty.slice(-8)}:frame:${newFrame.height}` },
    { hash: disputeHash, type: 'dispute', context: `account:${counterparty.slice(-8)}:dispute` },
  ];

  return Ok({
    accountInput, events, revealedSecrets, swapOffersCreated, swapOffersCancelled, hashesToSign,
    ...(failedHtlcLocks.length > 0 ? { failedHtlcLocks } : {}),
  });
}

/**
 * Handle received AccountInput (bilateral consensus)
 */
export async function handleAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput
): Promise<Result<HandleSuccess, HandleError>> {
  console.log(`📨 A-MACHINE: Received AccountInput from ${input.fromEntityId.slice(-4)}, type=${input.type}, pendingFrame=${accountMachine.proposal ? `h${accountMachine.proposal.pendingFrame.height}` : 'none'}, currentHeight=${accountMachine.currentHeight}`);
  console.log(`📨 A-MACHINE INPUT: type=${input.type}, height=${isFrameInput(input) ? input.height : 'none'}, hasACK=${input.type === 'ack'}, hasNewFrame=${isFrameInput(input) ? !!input.newAccountFrame : false}`);

  const events: string[] = [];
  const timedOutHashlocks: string[] = [];
  let ackProcessed = false;

  // Replay protection: frame chain (height + prevFrameHash) checked at :836
  // ACK replay protection: pendingFrame cleared on commit, so replayed ACK fails pendingFrame check

  if (isFrameInput(input) && input.newDisputeHanko !== undefined && input.newDisputeHanko !== null) {
    if (typeof input.newDisputeHanko !== 'string') {
      return Err({ error: 'Invalid dispute hanko type', events });
    }
    const hankoHex = input.newDisputeHanko.toLowerCase();
    const normalized = hankoHex.startsWith('0x') ? hankoHex.slice(2) : hankoHex;
    if (normalized.length === 0) {
      return Err({ error: 'Invalid dispute hanko (empty)', events });
    }
    if (normalized.length % 2 !== 0) {
      return Err({ error: 'Invalid dispute hanko (odd length)', events });
    }
  }

  // Handle pending frame confirmation
  if (accountMachine.proposal && input.type === 'ack' && input.height === accountMachine.proposal.pendingFrame.height && input.prevHanko) {
    console.log(`✅ Received confirmation for pending frame ${input.height}`);
    console.log(`✅ ACK-DEBUG: fromEntity=${input.fromEntityId.slice(-4)}, toEntity=${input.toEntityId.slice(-4)}`);

    const frameHash = accountMachine.proposal.pendingFrame.stateHash;

    // HANKO ACK VERIFICATION: Verify hanko instead of single signature
    const ackHanko = input.prevHanko;
    if (!ackHanko) {
      return Err({ error: 'Missing ACK hanko', events });
    }

    console.log(`🔐 HANKO-ACK-VERIFY: Verifying ACK hanko for our pending frame`);

    const { verifyHankoForHash } = await import('./hanko-signing');
    const expectedAckEntity = accountMachine.proofHeader.toEntity;
    const { valid, entityId: recoveredEntityId } = await verifyHankoForHash(ackHanko, frameHash, expectedAckEntity, env);

    if (!valid) {
      return Err({ error: 'Invalid ACK hanko signature', events });
    }

    if (!recoveredEntityId || recoveredEntityId.toLowerCase() !== expectedAckEntity.toLowerCase()) {
      return Err({ error: `ACK hanko entityId mismatch: got ${recoveredEntityId?.slice(-4)}, expected ${expectedAckEntity.slice(-4)}`, events });
    }

    console.log(`✅ HANKO-ACK-VERIFIED: ACK from ${recoveredEntityId.slice(-4)}`);

    // ACK is valid - proceed
    ackProcessed = true;
    {
      const pf = accountMachine.proposal!.pendingFrame;
      // CRITICAL DEBUG: Log what we're committing
      console.log(`🔒 COMMIT: Frame ${pf.height}`);
      console.log(`  Transactions: ${pf.accountTxs.length}`);
      console.log(`  Transactions detail:`, pf.accountTxs);
      console.log(`  TokenIds: ${pf.tokenIds.join(',')}`);
      console.log(`  Deltas: ${pf.deltas.map(d => `${d}`).join(',')}`);
      console.log(`  StateHash: ${frameHash.slice(0,16)}...`);

      // PROPOSER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
      // This eliminates fragile manual field copying
      {
        const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
        console.log(`🔓 PROPOSER-COMMIT: Re-executing ${pf.accountTxs.length} txs for ${cpForLog.slice(-4)}`);

        // Re-execute all frame txs on REAL accountMachine (deterministic)
        // CRITICAL: Use frame.timestamp for determinism (HTLC validation must use agreed consensus time)
        const pendingJHeight = pf.jHeight ?? accountMachine.currentHeight;
        for (const tx of pf.accountTxs) {
          const commitResult = await processAccountTx(accountMachine, tx, pf.byLeft!, pf.timestamp, pendingJHeight, false);
          if (!commitResult.success) {
            console.error(`❌ PROPOSER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
            throw new Error(`Frame ${pf.height} commit failed: ${tx.type} - ${commitResult.error}`);
          }
          if (commitResult.timedOutHashlock) {
            timedOutHashlocks.push(commitResult.timedOutHashlock);
          }
        }

        console.log(`💳 PROPOSER-COMMIT COMPLETE: Deltas after re-execution for ${cpForLog.slice(-4)}:`,
          Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
            tokenId,
            collateral: delta.collateral?.toString(),
            ondelta: delta.ondelta?.toString(),
            offdelta: delta.offdelta?.toString(),
            leftCreditLimit: delta.leftCreditLimit?.toString(),
            rightCreditLimit: delta.rightCreditLimit?.toString(),
          })));

        // CRITICAL: Deep-copy entire pendingFrame to prevent mutation issues
        accountMachine.currentFrame = structuredClone(pf);
        accountMachine.currentHeight = pf.height;
        accountMachine.proofHeader.disputeNonce = accountMachine.currentHeight;

        if (input.newDisputeHanko) {
          if (input.disputeProofNonce === undefined || !input.newDisputeHash) {
            console.warn(`⚠️ ACK has newDisputeHanko but missing disputeProofNonce or newDisputeHash — skipping dispute metadata`);
          } else {
            // Cryptographic binding: verify hanko actually signs the claimed dispute hash
            const { verifyHankoForHash } = await import('./hanko-signing');
            const { valid: disputeValid } = await verifyHankoForHash(input.newDisputeHanko, input.newDisputeHash, input.fromEntityId, env);
            if (!disputeValid) {
              console.warn(`⚠️ ACK dispute hanko fails verification — skipping dispute metadata`);
            } else {
              accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
              const signedCooperativeNonce = input.disputeProofNonce;
              accountMachine.counterpartyDisputeProofCooperativeNonce = signedCooperativeNonce;
              if (input.newDisputeProofBodyHash) {
                accountMachine.counterpartyDisputeProofBodyHash = input.newDisputeProofBodyHash;
                if (!accountMachine.disputeProofNoncesByHash) {
                  accountMachine.disputeProofNoncesByHash = {};
                }
                accountMachine.disputeProofNoncesByHash[input.newDisputeProofBodyHash] = signedCooperativeNonce;
              }
              console.log(`✅ Stored counterparty dispute hanko from ACK (verified)`);
            }
          }
        }

        // Store counterparty settlement signature
        if (input.newSettlementHanko) {
          accountMachine.counterpartySettlementHanko = input.newSettlementHanko;
          console.log(`✅ Stored counterparty settlement hanko from ACK`);
        }

        // Add confirmed frame to history
        accountMachine.frameHistory.push({...pf});
        // Cap history at 10 frames to prevent snapshot bloat
        if (accountMachine.frameHistory.length > 10) {
          accountMachine.frameHistory.shift();
        }
        console.log(`📚 Frame ${pf.height} added to history (total: ${accountMachine.frameHistory.length})`);
      }

      // Clear pending state
      delete accountMachine.proposal;
      accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1); // Successful confirmation reduces rollback
      if (accountMachine.rollbackCount === 0) {
        delete accountMachine.lastRollbackFrameHash; // Reset deduplication on full resolution
      }

      console.log(`✅ PENDING-CLEARED: Frame ${input.height} confirmed, mempool now has ${accountMachine.mempool.length} txs: [${accountMachine.mempool.map(tx => tx.type).join(',')}]`);
      events.push(`✅ Frame ${input.height} confirmed and committed`);

      // CRITICAL FIX: Chained Proposal - if mempool has items (e.g. j_event_claim), propose immediately
      if (!input.newAccountFrame) {
        if (accountMachine.mempool.length > 0) {
          console.log(`🚀 CHAINED-PROPOSAL: ACK received, mempool has ${accountMachine.mempool.length} txs - proposing next frame immediately`);
          const proposeResult = await proposeAccountFrame(env, accountMachine);
          if (isOk(proposeResult)) {
            const pv = proposeResult.value;
            return Ok({
              response: pv.accountInput,
              events: [...events, ...pv.events],
              timedOutHashlocks,
              ...(pv.revealedSecrets ? { revealedSecrets: pv.revealedSecrets } : {}),
              ...(pv.swapOffersCreated ? { swapOffersCreated: pv.swapOffersCreated } : {}),
              ...(pv.swapOffersCancelled ? { swapOffersCancelled: pv.swapOffersCancelled } : {}),
              ...(pv.hashesToSign && pv.hashesToSign.length > 0 ? { hashesToSign: pv.hashesToSign } : {}),
            });
          }
        }
        if (HEAVY_LOGS) console.log(`🔍 RETURN-ACK-ONLY: frame ${input.height} ACKed, no new frame bundled`);
        return Ok({ events, timedOutHashlocks });
      }
      // Fall through to process newAccountFrame below
      console.log(`📦 BATCHED-MESSAGE: ACK processed, now processing bundled new frame...`);
    }
  }

  // Handle new frame proposal (proposal or batched ack with newAccountFrame)
  if (isFrameInput(input) && input.newAccountFrame) {
    const receivedFrame = input.newAccountFrame;

    // Validate frame with timestamp checks (HTLC safety)
    const previousTimestamp = accountMachine.currentFrame?.timestamp;
    if (!validateAccountFrame(receivedFrame, env.timestamp, previousTimestamp)) {
      return Err({ error: 'Invalid frame structure', events });
    }

    // CRITICAL: Verify prevFrameHash links to our current frame (prevent state fork)
    const expectedPrevFrameHash = accountMachine.currentHeight === 0
      ? 'genesis'
      : accountMachine.currentFrame.stateHash || '';

    if (receivedFrame.prevFrameHash !== expectedPrevFrameHash) {
      console.warn(`⚠️ FRAME-CHAIN: prevHash mismatch at height ${accountMachine.currentHeight}`);
      return Err({
        error: `Frame chain broken: prevFrameHash mismatch (expected ${expectedPrevFrameHash.slice(0, 16)}...)`,
        events
      });
    }

    console.log(`✅ Frame chain verified: prevFrameHash matches frame ${accountMachine.currentHeight}`);

    // CHANNEL.TS REFERENCE: Lines 138-165 - Proper rollback logic for simultaneous proposals
    // Handle simultaneous proposals when both sides send same height
    if (accountMachine.proposal && receivedFrame.height === accountMachine.proposal.pendingFrame.height) {
      console.log(`🔄 SIMULTANEOUS-PROPOSALS: Both proposed frame ${receivedFrame.height}`);

      // Deterministic tiebreaker: Left always wins (CHANNEL.TS REFERENCE: Line 140-157)
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      if (HEAVY_LOGS) console.log(`🔍 TIEBREAKER: fromEntity=${accountMachine.proofHeader.fromEntity.slice(-4)}, toEntity=${accountMachine.proofHeader.toEntity.slice(-4)}, isLeft=${isLeftEntity}`);

      if (isLeftEntity) {
        // We are LEFT - ignore their frame, keep ours (deterministic tiebreaker)
        console.log(`📤 LEFT-WINS: Ignoring right's frame ${receivedFrame.height}, waiting for them to accept ours`);

        // EMIT EVENT: Track LEFT wins tiebreaker
        events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
        env.info('consensus', 'LEFT-WINS', {
          fromEntity: accountMachine.proofHeader.fromEntity,
          toEntity: accountMachine.proofHeader.toEntity,
          height: receivedFrame.height,
        }, accountMachine.proofHeader.fromEntity);

        // CRITICAL FIX: Even though we ignore their frame, check mempool and send update if we have new txs
        // This prevents j_event_claims from getting stuck when both sides propose simultaneously
        if (accountMachine.mempool.length > 0) {
          console.log(`📤 LEFT-WINS-BUT-HAS-MEMPOOL: ${accountMachine.mempool.length} txs waiting - notifying counterparty`);
          events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
          // Send a message with just mempool status so they know we have pending work
          // TODO: Determine if we should send frames or just signal
        }
        // This is NOT an error - it's correct consensus behavior (Channel.ts handlePendingBlock)
        return Ok({ events });
      } else {
        // We are RIGHT - rollback our frame, accept theirs
        // DEDUPLICATION: Check if we already rolled back this exact frame
        const receivedHash = receivedFrame.stateHash;
        if (accountMachine.lastRollbackFrameHash === receivedHash) {
          console.log(`⚠️ ROLLBACK-DEDUPE: Already rolled back for frame ${receivedHash.slice(0, 16)}... - ignoring duplicate`);
          // Don't increment rollbackCount again, just process their frame
        } else if (accountMachine.rollbackCount === 0) {
          // First rollback - restore transactions to mempool before discarding frame
          let restoredTxCount = 0;
          if (accountMachine.proposal) {
            const rpf = accountMachine.proposal.pendingFrame;
            restoredTxCount = rpf.accountTxs.length;
            console.log(`📥 RIGHT-ROLLBACK: Restoring ${restoredTxCount} txs to mempool`);
            // CRITICAL: Re-add transactions to mempool (Channel.ts pattern)
            accountMachine.mempool.unshift(...rpf.accountTxs);
            console.log(`📥 Mempool now has ${accountMachine.mempool.length} txs after rollback restore`);

            // EMIT EVENT: Track rollback for debugging
            events.push(`🔄 ROLLBACK: Discarded our frame ${rpf.height}, restored ${restoredTxCount} txs to mempool`);
            env.info('consensus', 'ROLLBACK', {
              fromEntity: accountMachine.proofHeader.fromEntity,
              toEntity: accountMachine.proofHeader.toEntity,
              height: rpf.height,
              restoredTxCount,
            }, accountMachine.proofHeader.fromEntity);
          }

          delete accountMachine.proposal;
          accountMachine.rollbackCount++;
          accountMachine.lastRollbackFrameHash = receivedHash; // Track this rollback
          console.log(`📥 RIGHT-ROLLBACK: Accepting left's frame (rollbacks: ${accountMachine.rollbackCount})`);

          // EMIT EVENT: Track that we accepted LEFT's frame
          events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);

          // Continue to process their frame below
        } else {
          // Should never rollback twice (unless duplicate messages)
          console.warn(`⚠️ ROLLBACK-LIMIT: ${accountMachine.rollbackCount}x - consensus stalled`);
          return Err({ error: 'Multiple rollbacks detected - consensus failure', events });
        }
      }
    }

    // NOTE: rollbackCount decrement happens in ACK block (line 547) when pendingFrame confirmed
    // This ensures we only decrement once per rollback resolution (no double-decrement)

    // Verify frame sequence
    if (HEAVY_LOGS) console.log(`🔍 SEQUENCE-CHECK: receivedFrame.height=${receivedFrame.height}, currentHeight=${accountMachine.currentHeight}, expected=${accountMachine.currentHeight + 1}`);
    if (receivedFrame.height !== accountMachine.currentHeight + 1) {
      console.log(`❌ Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`);
      return Err({ error: `Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`, events });
    }

    // SECURITY: Verify signatures (REQUIRED for all frames)
    // HANKO VERIFICATION: Require hanko for all frames
    const hankoToVerify = input.newHanko;
    if (!hankoToVerify) {
      return Err({ error: 'SECURITY: Frame must have hanko signature', events });
    }

    console.log(`🔐 HANKO-VERIFY: Verifying hanko for frame ${receivedFrame.height} from ${input.fromEntityId.slice(-4)}`);

    // Verify hanko - CRITICAL: Must verify fromEntityId is the signer with board validation
    const { verifyHankoForHash } = await import('./hanko-signing');
    const { valid, entityId: recoveredEntityId } = await verifyHankoForHash(hankoToVerify, receivedFrame.stateHash, input.fromEntityId, env);

    if (!valid || !recoveredEntityId) {
      return Err({ error: `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`, events });
    }

    console.log(`✅ HANKO-VERIFIED: Frame from ${recoveredEntityId.slice(-4)}`);

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

    // DEBUG: Log initial state and txs
    console.log(`🔍 FRAME-${receivedFrame.height} RECEIVER DEBUG:`);
    console.log(`   TXs to process: ${receivedFrame.accountTxs.length} - [${receivedFrame.accountTxs.map(tx => tx.type).join(', ')}]`);
    for (const [tokenId, delta] of clonedMachine.deltas.entries()) {
      console.log(`   Initial delta[${tokenId}]: ondelta=${delta.ondelta}, offdelta=${delta.offdelta}, collateral=${delta.collateral}`);
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
      minFillRatio: number;
    }> = [];
    const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

    for (const accountTx of receivedFrame.accountTxs) {
      // When receiving a frame, we process transactions from counterparty's perspective (incoming)
      // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
      const result = await processAccountTx(
        clonedMachine,
        accountTx,
        receivedFrame.byLeft!, // Channel.ts: frame-level byLeft (same on both sides)
        receivedFrame.timestamp, // DETERMINISTIC: Use frame's consensus timestamp
        frameJHeight,  // Frame's consensus J-height
        true // isValidation = true (on clone, skip bilateral finalization)
      );
      if (!result.success) {
        return Err({ error: `Frame application failed: ${result.error}`, events });
      }
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
      if (result.swapOfferCancelled) {
        swapOffersCancelled.push(result.swapOfferCancelled);
      }
    }

    // STATE VERIFICATION: Compare deltas directly (both sides compute identically)
    // Extract final state from clonedMachine after processing ALL transactions
    const ourFinalTokenIds: number[] = [];
    const ourFinalDeltas: bigint[] = [];

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
      ourFinalDeltas.push(totalDelta);
    }

    if (HEAVY_LOGS) console.log(`🔍 RECEIVER: Computed ${ourFinalTokenIds.length} tokens after filtering: [${ourFinalTokenIds.join(', ')}]`);

    // CRITICAL: Extract FULL delta states for hash verification (same as proposer does)
    // This ensures hash verification includes credit limits, collateral, allowances
    const ourFullDeltaStates: import('./types').Delta[] = [];
    for (const [tokenId, delta] of sortedOurTokens) {
      // CRITICAL: Use offdelta ONLY for filtering (same as delta comparison)
      const totalDelta = delta.offdelta;
      // Apply SAME filtering as proposer (skip unused tokens)
      if (!shouldIncludeToken(delta, totalDelta)) {
        continue;
      }
      ourFullDeltaStates.push({ ...delta });
    }

    const ourComputedState = Buffer.from(ourFinalDeltas.map(d => d.toString()).join(',')).toString('hex');
    const theirClaimedState = Buffer.from(receivedFrame.deltas.map(d => d.toString()).join(',')).toString('hex');

    // DEBUG: Show actual delta values
    console.log(`🔍 STATE-VERIFY Frame ${receivedFrame.height}:`);
    console.log(`   Our tokenIds: [${ourFinalTokenIds.join(', ')}], deltas: [${ourFinalDeltas.map(d => d.toString()).join(', ')}]`);
    console.log(`   Their tokenIds: [${receivedFrame.tokenIds.join(', ')}], deltas: [${receivedFrame.deltas.map(d => d.toString()).join(', ')}]`);
    console.log(`  Our computed:  ${ourComputedState.slice(0, 32)}...`);
    console.log(`  Their claimed: ${theirClaimedState.slice(0, 32)}...`);

    if (ourComputedState !== theirClaimedState) {
      // Compact error - full dump only if DEBUG enabled
      console.warn(`⚠️ CONSENSUS: Frame ${receivedFrame.height} - state mismatch (our: ${ourComputedState.slice(0,16)}... vs their: ${theirClaimedState.slice(0,16)}...)`);
      return Err({ error: `Bilateral consensus failure - states don't match`, events });
    }

    // SECURITY FIX: Verify BILATERAL fields in fullDeltaStates (prevents state injection attack)
    // ondelta/collateral may differ due to J-event timing, but bilateral fields MUST match:
    // - offdelta: Set by bilateral payments
    // - creditLimit: Set by bilateral set_credit_limit tx
    // - allowance: Set by bilateral transactions
    const theirFullDeltaStates = receivedFrame.fullDeltaStates || [];
    if (ourFullDeltaStates.length !== theirFullDeltaStates.length) {
      console.warn(`⚠️ SECURITY: fullDeltaStates count mismatch (our: ${ourFullDeltaStates.length}, their: ${theirFullDeltaStates.length})`);
      return Err({ error: `Bilateral state injection detected - delta count mismatch`, events });
    }

    for (let i = 0; i < ourFullDeltaStates.length; i++) {
      const ours = ourFullDeltaStates[i]!;
      const theirs = theirFullDeltaStates[i]!;

      // Compare BILATERAL fields only (ondelta/collateral may differ due to J-event timing)
      const bilateralMismatch =
        ours.offdelta !== theirs.offdelta ||
        ours.leftCreditLimit !== theirs.leftCreditLimit ||
        ours.rightCreditLimit !== theirs.rightCreditLimit ||
        ours.leftAllowance !== theirs.leftAllowance ||
        ours.rightAllowance !== theirs.rightAllowance;

      if (bilateralMismatch) {
        console.warn(`⚠️ SECURITY: Bilateral field mismatch at token ${ours.tokenId}:`);
        console.warn(`   offdelta: our=${ours.offdelta}, their=${theirs.offdelta}`);
        console.warn(`   leftCreditLimit: our=${ours.leftCreditLimit}, their=${theirs.leftCreditLimit}`);
        console.warn(`   rightCreditLimit: our=${ours.rightCreditLimit}, their=${theirs.rightCreditLimit}`);
        return Err({ error: `Bilateral state injection detected - credit/allowance mismatch`, events });
      }
    }

    if (HEAVY_LOGS) console.log(`🔍 ABOUT-TO-VERIFY-HASH: Computing frame hash...`);
    // SECURITY: Verify full frame hash (tokenIds + fullDeltaStates + deltas)
    // This prevents accepting frames with poisoned dispute proofs
    if (HEAVY_LOGS) console.log(`🔍 COMPUTING-HASH: Creating hash for frame ${receivedFrame.height}...`);
    // After bilateral field verification above, use OUR computed fullDeltaStates for hash
    // This ensures the stored frame has correct bilateral state
    const leftEntityId = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity)
      ? accountMachine.proofHeader.fromEntity
      : accountMachine.proofHeader.toEntity;
    const proposerIsLeft = input.fromEntityId === leftEntityId;

    const recomputedHash = await createFrameHash({
      height: receivedFrame.height,
      timestamp: receivedFrame.timestamp,
      jHeight: receivedFrame.jHeight,
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      tokenIds: ourFinalTokenIds, // Use OUR computed tokenIds
      deltas: ourFinalDeltas, // Use OUR computed deltas
      fullDeltaStates: ourFullDeltaStates, // Use OUR computed fullDeltaStates
      stateHash: '', // Computed by createFrameHash
      byLeft: proposerIsLeft,
    });

    if (recomputedHash !== receivedFrame.stateHash) {
      console.warn(`⚠️ SECURITY: Frame hash mismatch after validation`);
      console.warn(`   Recomputed: ${recomputedHash.slice(0,16)}...`);
      console.warn(`   Claimed:    ${receivedFrame.stateHash.slice(0,16)}...`);
      return Err({ error: `Frame hash verification failed - dispute proof mismatch`, events });
    }

    console.log(`✅ CONSENSUS-SUCCESS: Both sides computed identical state for frame ${receivedFrame.height}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // SECURITY PRINCIPLE: NEVER USE COUNTERPARTY-SUPPLIED STATE
    // ═══════════════════════════════════════════════════════════════════════════
    // We ALWAYS compute our own state from transaction execution and use THAT.
    // Counterparty's claimed state (receivedFrame.tokenIds/deltas/fullDeltaStates)
    // is ONLY used for comparison/debugging, NEVER stored or trusted.
    //
    // Why: An attacker could inject poisoned state (e.g., inflated creditLimit)
    // that passes transaction verification but corrupts our stored state.
    //
    // Safe to use from receivedFrame (inputs/metadata):
    //   - height, timestamp, jHeight, accountTxs, prevFrameHash
    // NEVER use (computed state - could be poisoned):
    //   - tokenIds, deltas, fullDeltaStates, stateHash (except for comparison)
    // ═══════════════════════════════════════════════════════════════════════════

    // Emit bilateral consensus event - use OUR computed values
    env.emit('BilateralFrameCommitted', {
      fromEntity: input.fromEntityId,
      toEntity: accountMachine.proofHeader.fromEntity,
      height: receivedFrame.height,
      txCount: receivedFrame.accountTxs.length,
      tokenIds: ourFinalTokenIds,  // OUR computed tokenIds
      stateHash: recomputedHash,   // OUR computed hash
    });

    // RECEIVER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
    // This eliminates fragile manual field copying
    const { counterparty: cpForCommitLog } = getAccountPerspective(accountMachine, ourEntityId);
    if (HEAVY_LOGS) console.log(`🔍 RECEIVER-COMMIT: Re-executing ${receivedFrame.accountTxs.length} txs for ${cpForCommitLog.slice(-4)}`);

    // Re-execute all frame txs on REAL accountMachine (deterministic)
    // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
    for (const tx of receivedFrame.accountTxs) {
      // CRITICAL: Use frame.jHeight for HTLC checks (consensus-aligned height)
      const jHeightForCommit = receivedFrame.jHeight || accountMachine.currentHeight;
      const commitResult = await processAccountTx(accountMachine, tx, receivedFrame.byLeft!, receivedFrame.timestamp, jHeightForCommit, false);

      // CRITICAL: Verify commit succeeded (Codex: prevent silent divergence)
      if (!commitResult.success) {
        console.error(`❌ RECEIVER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
        throw new Error(`Frame ${receivedFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);
      }
    }

    console.log(`💳 RECEIVER-COMMIT COMPLETE: Deltas after re-execution for ${cpForCommitLog.slice(-4)}:`,
      Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
        tokenId,
        collateral: delta.collateral?.toString(),
        leftCreditLimit: delta.leftCreditLimit?.toString(),
        rightCreditLimit: delta.rightCreditLimit?.toString(),
        ondelta: delta.ondelta?.toString(),
        offdelta: delta.offdelta?.toString(),
      })));

    // CRITICAL: Copy pendingForward for multi-hop routing
    if (clonedMachine.pendingForward) {
      accountMachine.pendingForward = clonedMachine.pendingForward;
      console.log(`🔀 Copied pendingForward for multi-hop: route=[${clonedMachine.pendingForward.route.map(r => r.slice(-4)).join(',')}]`);
    }

    // SECURITY FIX: Use OUR computed state (verified to match bilateral fields)
    // This prevents storing attacker-injected creditLimit/allowance values
    // The recomputedHash was computed from OUR values, so stateHash must match
    // CRITICAL: Deep-copy to prevent mutation issues
    accountMachine.currentFrame = structuredClone({
      height: receivedFrame.height,
      timestamp: receivedFrame.timestamp,
      jHeight: receivedFrame.jHeight,
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      tokenIds: ourFinalTokenIds, // Use OUR computed tokenIds
      deltas: ourFinalDeltas, // Use OUR computed deltas
      stateHash: recomputedHash, // Use hash computed from OUR values
      byLeft: proposerIsLeft, // Compute proposer side locally
      fullDeltaStates: ourFullDeltaStates, // Use OUR verified fullDeltaStates
    });
    accountMachine.currentHeight = receivedFrame.height;
    accountMachine.proofHeader.disputeNonce = accountMachine.currentHeight;

    // Store counterparty dispute metadata on COMMIT (verified, frame accepted)
    if (input.newDisputeHanko && !ackProcessed && input.disputeProofNonce !== undefined && input.newDisputeHash) {
      const { verifyHankoForHash } = await import('./hanko-signing');
      const { valid: disputeValid } = await verifyHankoForHash(input.newDisputeHanko, input.newDisputeHash, input.fromEntityId, env);
      if (disputeValid) {
        accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
        accountMachine.counterpartyDisputeProofCooperativeNonce = input.disputeProofNonce;
        if (input.newDisputeProofBodyHash) {
          accountMachine.counterpartyDisputeProofBodyHash = input.newDisputeProofBodyHash;
          if (!accountMachine.disputeProofNoncesByHash) accountMachine.disputeProofNoncesByHash = {};
          accountMachine.disputeProofNoncesByHash[input.newDisputeProofBodyHash] = input.disputeProofNonce;
        }
        console.log(`✅ Stored counterparty dispute hanko on commit (frame ${receivedFrame.height})`);
      } else {
        console.warn(`⚠️ Dispute hanko verification failed on commit — skipping dispute metadata`);
      }
    }

    // Add accepted frame to history
    accountMachine.frameHistory.push({...receivedFrame});
    // Cap history at 10 frames to prevent snapshot bloat
    if (accountMachine.frameHistory.length > 10) {
      accountMachine.frameHistory.shift();
    }
    console.log(`📚 Frame ${receivedFrame.height} accepted and added to history (total: ${accountMachine.frameHistory.length})`);

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

    // Send confirmation (ACK) using HANKO
    const ackEntityId = accountMachine.proofHeader.fromEntity;
    const ackReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ackEntityId);
    const ackSignerId = ackReplica?.state.config.validators[0];
    if (!ackSignerId) {
      return Err({ error: `Cannot find signerId for ACK from ${ackEntityId.slice(-4)}`, events });
    }

    console.log(`🔐 HANKO-ACK: entityId=${ackEntityId.slice(-4)} → signerId=${ackSignerId.slice(-4)}`);

    // Build ACK hanko
    const { signHashesAsSingleEntity } = await import('./hanko-signing');
    const ackHankos = await signHashesAsSingleEntity(env, ackEntityId, ackSignerId, [receivedFrame.stateHash]);
    const confirmationHanko = ackHankos[0];
    if (!confirmationHanko) {
      return Err({ error: 'Failed to build ACK hanko', events });
    }

    console.log(`📤 ACK-SEND: Preparing ACK for frame ${receivedFrame.height} from ${accountMachine.proofHeader.fromEntity.slice(-4)} to ${input.fromEntityId.slice(-4)}`);

    // CHANNEL.TS PATTERN (Lines 576-612): Batch ACK + new frame in same message!
    // Check if we should batch BEFORE incrementing cooperativeNonce
    let batchedWithNewFrame = false;
    let proposeResult: Result<ProposeSuccess, ProposeError> | undefined;
    // Build dispute proof hanko for ACK response (always include current state's dispute proof)
    const { buildAccountProofBody: buildProof, createDisputeProofHash: createHash } = await import('./proof-builder');
    const ackDepositoryAddress = getDepositoryAddress(env);
    const ackProofResult = buildProof(accountMachine);
    const ackDisputeHash = createHash(accountMachine, ackProofResult.proofBodyHash, ackDepositoryAddress);
    const ackDisputeHankos = await signHashesAsSingleEntity(env, ackEntityId, ackSignerId, [ackDisputeHash]);
    const ackDisputeHanko = ackDisputeHankos[0];
    const ackSignedCooperativeNonce = accountMachine.proofHeader.cooperativeNonce;
    if (!accountMachine.disputeProofNoncesByHash) {
      accountMachine.disputeProofNoncesByHash = {};
    }
    accountMachine.disputeProofNoncesByHash[ackProofResult.proofBodyHash] = ackSignedCooperativeNonce;
    if (!accountMachine.disputeProofBodiesByHash) {
      accountMachine.disputeProofBodiesByHash = {};
    }
    accountMachine.disputeProofBodiesByHash[ackProofResult.proofBodyHash] = ackProofResult.proofBodyStruct;

    const response: AccountInputAck = {
      type: 'ack' as const,
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedFrame.height,
      prevHanko: confirmationHanko,       // Hanko ACK on their frame
      ...(ackDisputeHanko ? { newDisputeHanko: ackDisputeHanko } : {}),   // My dispute proof hanko (current state)
      newDisputeHash: ackDisputeHash,     // Full dispute hash (key in hankoWitness for quorum lookup)
      newDisputeProofBodyHash: ackProofResult.proofBodyHash, // ProofBodyHash that ackDisputeHanko signs
      disputeProofNonce: ackSignedCooperativeNonce, // nonce at which ACK's dispute proof was signed
    };

    if (HEAVY_LOGS) console.log(`🔍 BATCH-CHECK for account ${input.fromEntityId.slice(-4)}: mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.proposal}, mempoolTxs=[${accountMachine.mempool.map(tx => tx.type).join(',')}]`);
    if (accountMachine.mempool.length > 0 && !accountMachine.proposal) {
      console.log(`📦 BATCH-OPTIMIZATION: Sending ACK + new frame in single message (Channel.ts pattern)`);

      // Pass skipNonceIncrement=true since we'll increment for the whole batch below
      proposeResult = await proposeAccountFrame(env, accountMachine, true);

      if (isOk(proposeResult) && proposeResult.value.accountInput.type === 'proposal') {
        batchedWithNewFrame = true;
        // Merge ACK and new proposal into same AccountInput
        const proposal = proposeResult.value.accountInput;
        response.newAccountFrame = proposal.newAccountFrame;
        response.newHanko = proposal.newHanko;
        // DON'T overwrite response.newDisputeHanko (it's ACK's dispute hanko for current committed state)
        // Proposal's newDisputeHanko will be delivered when proposal commits, not now
        // This preserves ACK's dispute hanko for last agreed state

        const newFrameId = proposal.newAccountFrame.height;
        console.log(`✅ Batched ACK for frame ${receivedFrame.height} + proposal for frame ${newFrameId}`);
        events.push(`📤 Batched ACK + frame ${newFrameId}`);
      }
    }

    if (!batchedWithNewFrame && ackDisputeHanko) {
      accountMachine.currentDisputeProofHanko = ackDisputeHanko;
      accountMachine.currentDisputeProofCooperativeNonce = ackSignedCooperativeNonce;
      accountMachine.currentDisputeProofBodyHash = ackProofResult.proofBodyHash;
    }

    // Increment cooperativeNonce for this message (dispute domain nonce)
    ++accountMachine.proofHeader.cooperativeNonce;
    console.log(`🔢 cooperativeNonce: ${accountMachine.proofHeader.cooperativeNonce} (batched=${batchedWithNewFrame})`);

    // Extract Ok value from proposeResult (if batched and successful)
    const proposedOk = proposeResult && isOk(proposeResult) ? proposeResult.value : undefined;

    // Merge revealed secrets from BOTH incoming frame AND proposed frame
    const allRevealedSecrets = [
      ...revealedSecrets, // From incoming frame (line 493)
      ...(proposedOk?.revealedSecrets || []) // From our proposed frame (if batched)
    ];

    // Merge swap offers from BOTH incoming frame AND proposed frame
    const allSwapOffersCreated = [
      ...swapOffersCreated,
      ...(proposedOk?.swapOffersCreated || [])
    ];
    const allSwapOffersCancelled = [
      ...swapOffersCancelled,
      ...(proposedOk?.swapOffersCancelled || [])
    ];

    // Collect hashes that need entity-quorum signing (multi-signer support)
    const hashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [
      { hash: receivedFrame.stateHash, type: 'accountFrame', context: `account:${input.fromEntityId.slice(-8)}:ack:${receivedFrame.height}` },
      { hash: ackDisputeHash, type: 'dispute', context: `account:${input.fromEntityId.slice(-8)}:ack-dispute` },
      ...(proposedOk?.hashesToSign || []) // From batched proposal
    ];

    if (HEAVY_LOGS) console.log(`🔍 RETURN-RESPONSE: h=${response.height} prevHanko=${!!response.prevHanko} newFrame=${!!response.newAccountFrame}`);
    return Ok({
      response, events,
      revealedSecrets: allRevealedSecrets,
      swapOffersCreated: allSwapOffersCreated,
      swapOffersCancelled: allSwapOffersCancelled,
      timedOutHashlocks,
      ...(hashesToSign.length > 0 ? { hashesToSign } : {}),
    });
  }

  if (HEAVY_LOGS) console.log(`🔍 RETURN-NO-RESPONSE: No response object`);
  return Ok({ events, swapOffersCreated: [], swapOffersCancelled: [], timedOutHashlocks });
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
  console.log(`📥 Added ${accountTx.type} to mempool (${accountMachine.mempool.length}/${MEMPOOL_LIMIT})`);
  return true;
}

/**
 * Check if account should auto-propose frame
 */
export function shouldProposeFrame(accountMachine: AccountMachine): boolean {
  // Should propose if:
  // 1. Has transactions in mempool
  // 2. No pending frame waiting for confirmation
  const should = accountMachine.mempool.length > 0 && !accountMachine.proposal;
  console.error(`   shouldProposeFrame: mempool=${accountMachine.mempool.length}, pending=${!!accountMachine.proposal}, result=${should}`);
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
export async function generateAccountProof(env: Env, accountMachine: AccountMachine): Promise<{
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

  // Create proof structure compatible with Depository.sol (legacy format)
  const proofData = {
    fromEntity: accountMachine.proofHeader.fromEntity,
    toEntity: accountMachine.proofHeader.toEntity,
    cooperativeNonce: accountMachine.proofHeader.cooperativeNonce,
    disputeNonce: accountMachine.proofHeader.disputeNonce,
    tokenIds: accountMachine.proofBody.tokenIds,
    deltas: accountMachine.proofBody.deltas.map(d => d.toString()), // Convert BigInt for JSON
  };

  // Create deterministic proof hash using browser-compatible crypto
  const proofContent = safeStringify(proofData);
  const fullHash = await hash(proofContent);
  const proofHash = fullHash.slice(2); // Remove 0x prefix for compatibility

  // Generate hanko signature - CRITICAL: Use signerId, not entityId
  const proofEntityId = accountMachine.proofHeader.fromEntity;
  const proofReplica = Array.from(env.eReplicas.values()).find((r: EntityReplica) => r.state.entityId === proofEntityId);
  const proofSignerId = proofReplica?.state.config.validators[0];
  if (!proofSignerId) {
    throw new Error(`Cannot find signerId for proof from ${proofEntityId.slice(-4)}`);
  }
  console.log(`🔐 PROOF-SIGN: entityId=${proofEntityId.slice(-4)} → signerId=${proofSignerId.slice(-4)}`);
  const signature = signAccountFrame(env, proofSignerId, `0x${proofHash}`);

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
