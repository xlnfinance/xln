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
const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_HEX_20_RE = /^0x[0-9a-fA-F]{40}$/;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);
const isAddress20 = (value: unknown): value is string => typeof value === 'string' && ADDRESS_HEX_20_RE.test(value);

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
  const hasHolds =
    (delta.leftHtlcHold || 0n) !== 0n ||
    (delta.rightHtlcHold || 0n) !== 0n ||
    (delta.leftSwapHold || 0n) !== 0n ||
    (delta.rightSwapHold || 0n) !== 0n ||
    (delta.leftSettleHold || 0n) !== 0n ||
    (delta.rightSettleHold || 0n) !== 0n;

  return !(totalDelta === 0n && delta.leftCreditLimit === 0n && delta.rightCreditLimit === 0n && !hasHolds);
}

type SettlementVector = Map<number, { collateral: bigint; ondelta: bigint }>;

function captureSettlementVector(accountMachine: AccountMachine): SettlementVector {
  const out: SettlementVector = new Map();
  for (const [tokenId, delta] of accountMachine.deltas.entries()) {
    out.set(tokenId, { collateral: delta.collateral, ondelta: delta.ondelta });
  }
  return out;
}

function assertNoUnilateralSettlementMutation(
  accountMachine: AccountMachine,
  before: SettlementVector,
  tx: AccountTx,
  phase: string,
): void {
  if (tx.type === 'j_event_claim') return;
  for (const [tokenId, delta] of accountMachine.deltas.entries()) {
    const prev = before.get(tokenId);
    const prevCollateral = prev?.collateral ?? 0n;
    const prevOndelta = prev?.ondelta ?? 0n;
    // allow token creation with zero settlement fields
    if (!prev && delta.collateral === 0n && delta.ondelta === 0n) continue;
    if (delta.collateral !== prevCollateral || delta.ondelta !== prevOndelta) {
      throw new Error(
        `INVARIANT_VIOLATION[${phase}]: tx=${tx.type} mutated collateral/ondelta ` +
          `token=${tokenId} collateral ${prevCollateral}->${delta.collateral} ondelta ${prevOndelta}->${delta.ondelta}`,
      );
    }
  }
}

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
      console.log(
        `❌ Frame timestamp went backwards significantly: ${frame.timestamp} < ${previousFrameTimestamp} (delta: ${previousFrameTimestamp - frame.timestamp}ms)`,
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
    tokenIds: frame.tokenIds,
    deltas: frame.deltas.map(d => d.toString()), // Quick access sums
    // Include full shared delta state in frame hash.
    // collateral/ondelta are shared values and must stay identical across peers.
    // If they diverge, frame consensus must fail hard.
    fullDeltaStates: frame.fullDeltaStates?.map(delta => ({
      tokenId: delta.tokenId,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      leftCreditLimit: delta.leftCreditLimit.toString(),
      rightCreditLimit: delta.rightCreditLimit.toString(),
      leftAllowance: delta.leftAllowance.toString(),
      rightAllowance: delta.rightAllowance.toString(),
      leftHtlcHold: (delta.leftHtlcHold || 0n).toString(), // HTLC holds
      rightHtlcHold: (delta.rightHtlcHold || 0n).toString(), // HTLC holds
      leftSwapHold: (delta.leftSwapHold || 0n).toString(), // Swap holds
      rightSwapHold: (delta.rightSwapHold || 0n).toString(), // Swap holds
      leftSettleHold: (delta.leftSettleHold || 0n).toString(), // Settlement holds
      rightSettleHold: (delta.rightSettleHold || 0n).toString(), // Settlement holds
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
    minFillRatio: number;
  }>;
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
    console.log(`🚀 E-MACHINE: Proposing account frame for ${counterparty.slice(-4)}`);
    console.log(
      `🚀 E-MACHINE: Account state - mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, currentHeight=${accountMachine.currentHeight}`,
    );
  }

  const events: string[] = [];

  // Mempool size validation
  if (accountMachine.mempool.length > MEMPOOL_LIMIT) {
    console.log(`❌ E-MACHINE: Mempool overflow ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`);
    return { success: false, error: `Mempool overflow: ${accountMachine.mempool.length} > ${MEMPOOL_LIMIT}`, events };
  }

  if (accountMachine.mempool.length === 0) {
    console.log(`❌ E-MACHINE: No transactions in mempool to propose`);
    return { success: false, error: 'No transactions to propose', events };
  }

  // Check if we have a pending frame waiting for ACK
  if (accountMachine.pendingFrame) {
    if (!quiet)
      console.log(`⏳ E-MACHINE: Still waiting for ACK on pending frame #${accountMachine.pendingFrame.height}`);
    return { success: false, error: 'Waiting for ACK on pending frame', events };
  }

  // Deterministic j-claim handshake:
  // RIGHT side must wait for LEFT claim to be committed first.
  // This prevents simultaneous same-height j_event_claim proposals and LEFT-WINS loops.
  const proposerByLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
  const onlyJClaimsInMempool =
    accountMachine.mempool.length > 0 && accountMachine.mempool.every(tx => tx.type === 'j_event_claim');
  if (!proposerByLeft && onlyJClaimsInMempool) {
    const leftObs = accountMachine.leftJObservations || [];
    const hasMatchingLeftClaim = accountMachine.mempool.some(tx => {
      if (tx.type !== 'j_event_claim') return false;
      const key = `${tx.data.jHeight}:${tx.data.jBlockHash}`;
      return leftObs.some(obs => `${obs.jHeight}:${obs.jBlockHash}` === key);
    });
    if (!hasMatchingLeftClaim) {
      if (!quiet) {
        console.log(
          `⏳ RIGHT-J-CLAIM-GATE: waiting for LEFT claim before proposing ${accountMachine.mempool.length} right-side j_event_claim tx(s)`,
        );
      }
      return { success: false, error: 'Waiting for LEFT j_event_claim', events };
    }
  }

  if (!quiet) console.log(`✅ E-MACHINE: Creating frame with ${accountMachine.mempool.length} transactions...`);
  if (HEAVY_LOGS)
    console.log(
      `🔍 PROOF-HEADER: from=${formatEntityId(accountMachine.proofHeader.fromEntity)}, to=${formatEntityId(accountMachine.proofHeader.toEntity)}`,
    );

  // Clone account machine for validation
  const clonedMachine = cloneAccountMachine(accountMachine);
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
    minFillRatio: number;
  }> = [];
  const swapOffersCancelled: Array<{ offerId: string; accountId: string }> = [];

  if (HEAVY_LOGS)
    console.log(
      `🔍 MEMPOOL-BEFORE-PROCESS: ${accountMachine.mempool.length} txs:`,
      accountMachine.mempool.map(tx => tx.type),
    );

  const validTxs: typeof accountMachine.mempool = [];
  const failedHtlcLocks: Array<{ hashlock: string; reason: string }> = [];
  const txsToRemove: typeof accountMachine.mempool = [];

  for (const accountTx of accountMachine.mempool) {
    if (HEAVY_LOGS) console.log(`   🔍 Processing accountTx type=${accountTx.type}`);
    // Channel.ts: byLeft = proposer is left entity (frame-level, same on both sides).
    // Use normalized ordering helper (not raw string equality) to avoid casing-induced
    // divergence during WAL replay.
    const proposerByLeft = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
    const beforeSettlement = captureSettlementVector(clonedMachine);
    const result = await processAccountTx(
      clonedMachine,
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
    assertNoUnilateralSettlementMutation(clonedMachine, beforeSettlement, accountTx, 'propose/validate');

    validTxs.push(accountTx);
    allEvents.push(...result.events);

    // Collect revealed secrets for backward propagation
    if (HEAVY_LOGS)
      console.log(
        `🔍 TX-RESULT: type=${accountTx.type}, hasSecret=${!!result.secret}, hasHashlock=${!!result.hashlock}`,
      );
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
      console.log(
        `📊 FullDeltaStates:`,
        fullDeltaStates.map(d => ({
          tokenId: d.tokenId,
          collateral: d.collateral?.toString(),
          leftCreditLimit: d.leftCreditLimit?.toString(),
          rightCreditLimit: d.rightCreditLimit?.toString(),
        })),
      );
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
    tokenIds: finalTokenIds, // Use computed state from clonedMachine.deltas
    deltas: finalDeltas, // Quick access: ondelta+offdelta sums
    fullDeltaStates, // AUDIT FIX: Full Delta objects for dispute proofs
  };

  // Calculate state hash (frameData is properly typed AccountFrame)
  frameData.stateHash = await createFrameHash(frameData as AccountFrame);

  // Debug: log what's being hashed at creation time
  if (HEAVY_LOGS) {
    console.log(`[HASH-DEBUG] Frame creation for ${accountMachine.proofHeader.toEntity.slice(-4)}:`);
    console.log(`  height: ${frameData.height}`);
    console.log(`  timestamp: ${frameData.timestamp}`);
    console.log(`  jHeight: ${frameData.jHeight}`);
    console.log(`  prevFrameHash: ${frameData.prevFrameHash?.slice(0, 20)}...`);
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
  console.log(
    `✅ Frame size: ${frameSize} bytes (${((frameSize / MAX_FRAME_SIZE_BYTES) * 100).toFixed(2)}% of 1MB limit)`,
  );

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

  console.log(`🔐 HANKO-SIGN: entityId=${signingEntityId.slice(-4)} → signerId=${signingSignerId.slice(-4)}`);

  // Build hanko for account frame
  const { signHashesAsSingleEntity } = await import('./hanko-signing');
  // Sign frame hash for bilateral consensus
  const hankos = await signHashesAsSingleEntity(env, signingEntityId, signingSignerId, [newFrame.stateHash]);
  const frameHanko = hankos[0];
  if (!frameHanko) {
    return { success: false, error: 'Failed to build frame hanko', events };
  }
  accountMachine.currentFrameHanko = frameHanko;

  // Build dispute proof and sign it (CRITICAL: always sign dispute proof with every frame)
  // BUG FIX: Use clonedMachine (has NEW state after txs) NOT accountMachine (old state)
  if (!isEntityId32(clonedMachine.leftEntity) || !isEntityId32(clonedMachine.rightEntity)) {
    accountMachine.mempool = [];
    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;
    const left = String(clonedMachine.leftEntity);
    const right = String(clonedMachine.rightEntity);
    return {
      success: false,
      error: `INVALID_ACCOUNT_ENTITY_ID: left=${left} right=${right}`,
      events,
    };
  }

  const { buildAccountProofBody, createDisputeProofHash } = await import('./proof-builder');
  let depositoryAddress = getDepositoryAddress(env);
  if (!isAddress20(depositoryAddress)) {
    console.warn(`[account-consensus] ⚠️ Invalid depositoryAddress "${depositoryAddress}", using zero address`);
    depositoryAddress = '0x0000000000000000000000000000000000000000';
  }

  let proofResult: ReturnType<typeof buildAccountProofBody>;
  let disputeHash: string;
  try {
    console.log(
      `🔐 DISPUTE-SIGN: depositoryAddress=${depositoryAddress}, counterparty=${accountMachine.proofHeader.toEntity.slice(-4)}`,
    );
    proofResult = buildAccountProofBody(clonedMachine);
    disputeHash = createDisputeProofHash(clonedMachine, proofResult.proofBodyHash, depositoryAddress);
    console.log(
      `🔐 DISPUTE-SIGN: disputeHash=${disputeHash.slice(0, 18)}..., proofBodyHash=${proofResult.proofBodyHash.slice(0, 18)}...`,
    );
  } catch (error) {
    accountMachine.mempool = [];
    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;
    return {
      success: false,
      error: `DISPUTE_PROOF_BUILD_FAILED: ${(error as Error).message}`,
      events,
    };
  }

  const disputeHankos = await signHashesAsSingleEntity(env, signingEntityId, signingSignerId, [disputeHash]);
  const disputeHanko = disputeHankos[0];
  if (!disputeHanko) {
    return { success: false, error: 'Failed to build dispute hanko', events };
  }
  accountMachine.currentDisputeProofHanko = disputeHanko;
  accountMachine.currentDisputeProofNonce = clonedMachine.proofHeader.nonce;
  accountMachine.currentDisputeProofBodyHash = proofResult.proofBodyHash;
  if (!accountMachine.disputeProofNoncesByHash) {
    accountMachine.disputeProofNoncesByHash = {};
  }
  accountMachine.disputeProofNoncesByHash[proofResult.proofBodyHash] = clonedMachine.proofHeader.nonce;
  if (!accountMachine.disputeProofBodiesByHash) {
    accountMachine.disputeProofBodiesByHash = {};
  }
  accountMachine.disputeProofBodiesByHash[proofResult.proofBodyHash] = proofResult.proofBodyStruct;

  // NOTE: Settlements are now handled via SettlementWorkspace flow (entity-tx/handlers/settle.ts)
  // The old frame-level settlement signing was removed (deprecated buildSettlementDiffs)

  console.log(`✅ Signed frame + dispute proof for account ${accountMachine.proofHeader.toEntity.slice(-4)}`);

  // Set pending state (no longer storing clone - re-execution on commit)
  accountMachine.pendingFrame = newFrame;
  console.log(
    `🔒 PROPOSE: Account ${accountMachine.proofHeader.fromEntity.slice(-4)}:${accountMachine.proofHeader.toEntity.slice(-4)} pendingFrame=${newFrame.height}, txs=${newFrame.accountTxs.length}`,
  );

  // Clear mempool (failed txs already removed above)
  accountMachine.mempool = [];

  events.push(`🚀 Proposed frame ${newFrame.height} with ${newFrame.accountTxs.length} transactions`);

  const accountInput: AccountInput = {
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: newFrame.height,
    newAccountFrame: newFrame,
    newHanko: frameHanko, // Hanko on frame stateHash
    newDisputeHanko: disputeHanko, // Hanko on dispute proof hash
    newDisputeHash: disputeHash, // Full dispute hash (key in hankoWitness for quorum lookup)
    newDisputeProofBodyHash: proofResult.proofBodyHash, // ProofBodyHash that disputeHanko signs
    // NOTE: Settlement hankos now handled via SettlementWorkspace (entity-tx/handlers/settle.ts)
    disputeProofNonce: accountMachine.proofHeader.nonce, // nonce at which dispute proof was signed (before increment)
  };
  if (!skipNonceIncrement) ++accountMachine.proofHeader.nonce;
  accountMachine.pendingAccountInput = accountInput;

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
  swapOffersCancelled?: Array<{ offerId: string; accountId: string }>;
  timedOutHashlocks?: string[];
  // MULTI-SIGNER: Hashes that need entity-quorum signing
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
}> {
  const normalizedInputHeight =
    input.height === undefined || input.height === null ? undefined : Number(input.height as number | string);
  if (normalizedInputHeight !== undefined && !Number.isFinite(normalizedInputHeight)) {
    return { success: false, error: `Invalid account input height: ${String(input.height)}`, events: [] };
  }
  const replayMode = (env as Record<PropertyKey, unknown>)[Symbol.for('xln.runtime.env.replay.mode')] === true;
  console.log(
    `📨 A-MACHINE: Received AccountInput from ${input.fromEntityId.slice(-4)}, pendingFrame=${accountMachine.pendingFrame ? `h${accountMachine.pendingFrame.height}` : 'none'}, currentHeight=${accountMachine.currentHeight}`,
  );
  console.log(
    `📨 A-MACHINE INPUT: height=${normalizedInputHeight ?? 'none'}, hasACK=${!!input.prevHanko}, hasNewFrame=${!!input.newAccountFrame}`,
  );

  const events: string[] = [];
  const timedOutHashlocks: string[] = [];
  let ackProcessed = false;
  if (replayMode) {
    console.log(
      `[REPLAY][A-MACHINE] from=${input.fromEntityId.slice(-8)} to=${input.toEntityId.slice(-8)} ` +
        `height=${String(normalizedInputHeight ?? 'none')} hasACK=${Boolean(input.prevHanko)} hasNewFrame=${Boolean(input.newAccountFrame)} ` +
        `currentHeight=${accountMachine.currentHeight} pending=${accountMachine.pendingFrame?.height ?? 0}`,
    );
  }

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
    console.log(`✅ Received confirmation for pending frame ${ackHeight}`);
    console.log(`✅ ACK-DEBUG: fromEntity=${input.fromEntityId.slice(-4)}, toEntity=${input.toEntityId.slice(-4)}`);

    const frameHash = accountMachine.pendingFrame.stateHash;

    // HANKO ACK VERIFICATION: Verify hanko instead of single signature
    const ackHanko = input.prevHanko;
    if (!ackHanko) {
      return { success: false, error: 'Missing ACK hanko', events };
    }

    const expectedAckEntity = accountMachine.proofHeader.toEntity;
    console.log(`🔐 HANKO-ACK-VERIFY: Verifying ACK hanko for our pending frame`);
    const { verifyHankoForHash } = await import('./hanko-signing');
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
    console.log(`✅ HANKO-ACK-VERIFIED: ACK from ${(recoveredEntityId ?? expectedAckEntity).slice(-4)}`);

    // ACK is valid - proceed
    ackProcessed = true;
    {
      // CRITICAL DEBUG: Log what we're committing
      console.log(`🔒 COMMIT: Frame ${accountMachine.pendingFrame.height}`);
      console.log(`  Transactions: ${accountMachine.pendingFrame.accountTxs.length}`);
      console.log(`  Transactions detail:`, accountMachine.pendingFrame.accountTxs);
      console.log(`  TokenIds: ${accountMachine.pendingFrame.tokenIds.join(',')}`);
      console.log(`  Deltas: ${accountMachine.pendingFrame.deltas.map(d => `${d}`).join(',')}`);
      console.log(`  StateHash: ${frameHash.slice(0, 16)}...`);

      // PROPOSER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
      // This eliminates fragile manual field copying
      {
        const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
        console.log(
          `🔓 PROPOSER-COMMIT: Re-executing ${accountMachine.pendingFrame.accountTxs.length} txs for ${cpForLog.slice(-4)}`,
        );

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

        console.log(
          `💳 PROPOSER-COMMIT COMPLETE: Deltas after re-execution for ${cpForLog.slice(-4)}:`,
          Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
            tokenId,
            collateral: delta.collateral?.toString(),
            ondelta: delta.ondelta?.toString(),
            offdelta: delta.offdelta?.toString(),
            leftCreditLimit: delta.leftCreditLimit?.toString(),
            rightCreditLimit: delta.rightCreditLimit?.toString(),
          })),
        );

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
            const { verifyHankoForHash } = await import('./hanko-signing');
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
        accountMachine.frameHistory.push({ ...accountMachine.pendingFrame });
        // Cap history at 10 frames to prevent snapshot bloat
        if (accountMachine.frameHistory.length > 10) {
          accountMachine.frameHistory.shift();
        }
        console.log(
          `📚 Frame ${accountMachine.pendingFrame.height} added to history (total: ${accountMachine.frameHistory.length})`,
        );
      }

      // Clear pending state
      delete accountMachine.pendingFrame;
      delete accountMachine.pendingAccountInput;
      delete accountMachine.clonedForValidation;
      accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1); // Successful confirmation reduces rollback
      if (accountMachine.rollbackCount === 0) {
        delete accountMachine.lastRollbackFrameHash; // Reset deduplication on full resolution
      }

      console.log(
        `✅ PENDING-CLEARED: Frame ${ackHeight} confirmed, mempool now has ${accountMachine.mempool.length} txs: [${accountMachine.mempool.map(tx => tx.type).join(',')}]`,
      );
      events.push(`✅ Frame ${ackHeight} confirmed and committed`);

      // CRITICAL FIX: Chained Proposal - if mempool has items (e.g. j_event_claim), propose immediately
      if (!input.newAccountFrame) {
        if (accountMachine.mempool.length > 0) {
          console.log(
            `🚀 CHAINED-PROPOSAL: ACK received, mempool has ${accountMachine.mempool.length} txs - proposing next frame immediately`,
          );
          const proposeResult = await proposeAccountFrame(env, accountMachine);
          if (proposeResult.success && proposeResult.accountInput) {
            return {
              success: true,
              response: proposeResult.accountInput,
              events: [...events, ...proposeResult.events],
              timedOutHashlocks,
              ...(proposeResult.revealedSecrets && { revealedSecrets: proposeResult.revealedSecrets }),
              ...(proposeResult.swapOffersCreated && { swapOffersCreated: proposeResult.swapOffersCreated }),
              ...(proposeResult.swapOffersCancelled && { swapOffersCancelled: proposeResult.swapOffersCancelled }),
              ...(proposeResult.hashesToSign &&
                proposeResult.hashesToSign.length > 0 && { hashesToSign: proposeResult.hashesToSign }),
            };
          }
        }
        if (HEAVY_LOGS) console.log(`🔍 RETURN-ACK-ONLY: frame ${ackHeight} ACKed, no new frame bundled`);
        return { success: true, events, timedOutHashlocks };
      }
      // Fall through to process newAccountFrame below
      console.log(`📦 BATCHED-MESSAGE: ACK processed, now processing bundled new frame...`);
    }
  }

  // ACK for a pending frame must never be ignored (ACK-only or batched ACK+newFrame).
  if (input.prevHanko && !ackProcessed && accountMachine.pendingFrame) {
    const pending = accountMachine.pendingFrame.height;
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
    if (replayMode) {
      console.log(
        `[REPLAY][A-MACHINE] new frame path: receivedHeight=${input.newAccountFrame.height} ` +
          `current=${accountMachine.currentHeight} prev=${String(input.newAccountFrame.prevFrameHash).slice(0, 12)}`,
      );
    }
    const receivedFrame = input.newAccountFrame;

    // Replay-only recovery:
    // If we are one frame behind with a pendingFrame, deterministically commit it first.
    // This preserves frame-chain continuity when ACK and next frame were split across WAL frames.
    if (
      replayMode &&
      accountMachine.pendingFrame &&
      Number(receivedFrame.height) === Number(accountMachine.pendingFrame.height) + 1 &&
      Number(accountMachine.currentHeight) + 1 !== Number(receivedFrame.height)
    ) {
      console.warn(
        `[loadEnvFromDB][A-MACHINE] replay precommit pending frame ` +
          `pending=${accountMachine.pendingFrame.height} current=${accountMachine.currentHeight} incoming=${receivedFrame.height}`,
      );
      const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.currentFrame?.jHeight ?? 0;
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
          return {
            success: false,
            error: `Replay pending commit failed: ${tx.type} - ${commitResult.error}`,
            events,
          };
        }
        assertNoUnilateralSettlementMutation(accountMachine, beforeSettlement, tx, 'replay/precommit');
      }
      accountMachine.currentFrame = structuredClone(accountMachine.pendingFrame);
      accountMachine.currentHeight = accountMachine.pendingFrame.height;
      accountMachine.frameHistory.push({ ...accountMachine.pendingFrame });
      if (accountMachine.frameHistory.length > 10) accountMachine.frameHistory.shift();
      delete accountMachine.pendingFrame;
      delete accountMachine.pendingAccountInput;
      delete accountMachine.clonedForValidation;
      console.warn(
        `[loadEnvFromDB][A-MACHINE] replay precommit done ` +
          `current=${accountMachine.currentHeight} pending=${accountMachine.pendingFrame?.height ?? 0}`,
      );
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
      console.warn(`⚠️ FRAME-CHAIN: prevHash mismatch at height ${accountMachine.currentHeight}`);
      return {
        success: false,
        error: `Frame chain broken: prevFrameHash mismatch (expected ${expectedPrevFrameHash.slice(0, 16)}...)`,
        events,
      };
    }

    console.log(`✅ Frame chain verified: prevFrameHash matches frame ${accountMachine.currentHeight}`);

    // CHANNEL.TS REFERENCE: Lines 138-165 - Proper rollback logic for simultaneous proposals
    // Handle simultaneous proposals when both sides send same height
    if (accountMachine.pendingFrame && receivedFrame.height === accountMachine.pendingFrame.height) {
      console.log(`🔄 SIMULTANEOUS-PROPOSALS: Both proposed frame ${receivedFrame.height}`);

      // Deterministic tiebreaker: Left always wins (CHANNEL.TS REFERENCE: Line 140-157)
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      if (HEAVY_LOGS)
        console.log(
          `🔍 TIEBREAKER: fromEntity=${accountMachine.proofHeader.fromEntity.slice(-4)}, toEntity=${accountMachine.proofHeader.toEntity.slice(-4)}, isLeft=${isLeftEntity}`,
        );

      if (isLeftEntity) {
        // We are LEFT - ignore their frame, keep ours (deterministic tiebreaker)
        console.log(`📤 LEFT-WINS: Ignoring right's frame ${receivedFrame.height}, waiting for them to accept ours`);

        // EMIT EVENT: Track LEFT wins tiebreaker
        events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);
        env.info(
          'consensus',
          'LEFT-WINS',
          {
            fromEntity: accountMachine.proofHeader.fromEntity,
            toEntity: accountMachine.proofHeader.toEntity,
            height: receivedFrame.height,
          },
          accountMachine.proofHeader.fromEntity,
        );

        // CRITICAL FIX: Even though we ignore their frame, check mempool and send update if we have new txs
        // This prevents j_event_claims from getting stuck when both sides propose simultaneously
        if (accountMachine.mempool.length > 0) {
          console.log(
            `📤 LEFT-WINS-BUT-HAS-MEMPOOL: ${accountMachine.mempool.length} txs waiting - notifying counterparty`,
          );
          events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
          // Send a message with just mempool status so they know we have pending work
          // TODO: Determine if we should send frames or just signal
        }

        // STRICT CONSENSUS: ignored frame must not mutate local account state.
        // In particular, do not salvage j_event_claim from ignored RIGHT frame.
        // Shared-state inputs are allowed to advance only through committed frames.

        // This is NOT an error - it's correct consensus behavior (Channel.ts handlePendingBlock)
        return { success: true, events };
      } else {
        // We are RIGHT - rollback our frame, accept theirs
        // DEDUPLICATION: Check if we already rolled back this exact frame
        const receivedHash = receivedFrame.stateHash;
        if (accountMachine.lastRollbackFrameHash === receivedHash) {
          console.log(
            `⚠️ ROLLBACK-DEDUPE: Already rolled back for frame ${receivedHash.slice(0, 16)}... - ignoring duplicate`,
          );
          // Don't increment rollbackCount again, just process their frame
        } else if (accountMachine.rollbackCount === 0) {
          // First rollback - restore transactions to mempool before discarding frame
          let restoredTxCount = 0;
          if (accountMachine.pendingFrame) {
            restoredTxCount = accountMachine.pendingFrame.accountTxs.length;
            console.log(`📥 RIGHT-ROLLBACK: Restoring ${restoredTxCount} txs to mempool`);
            // CRITICAL: Re-add transactions to mempool (Channel.ts pattern)
            accountMachine.mempool.unshift(...accountMachine.pendingFrame.accountTxs);
            console.log(`📥 Mempool now has ${accountMachine.mempool.length} txs after rollback restore`);

            // EMIT EVENT: Track rollback for debugging
            events.push(
              `🔄 ROLLBACK: Discarded our frame ${accountMachine.pendingFrame.height}, restored ${restoredTxCount} txs to mempool`,
            );
            env.info(
              'consensus',
              'ROLLBACK',
              {
                fromEntity: accountMachine.proofHeader.fromEntity,
                toEntity: accountMachine.proofHeader.toEntity,
                height: accountMachine.pendingFrame.height,
                restoredTxCount,
              },
              accountMachine.proofHeader.fromEntity,
            );
          }

          delete accountMachine.pendingFrame;
          delete accountMachine.pendingAccountInput;
          delete accountMachine.clonedForValidation;
          accountMachine.rollbackCount++;
          accountMachine.lastRollbackFrameHash = receivedHash; // Track this rollback
          console.log(`📥 RIGHT-ROLLBACK: Accepting left's frame (rollbacks: ${accountMachine.rollbackCount})`);

          // EMIT EVENT: Track that we accepted LEFT's frame
          events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);

          // Continue to process their frame below
        } else {
          // Should never rollback twice (unless duplicate messages)
          console.warn(`⚠️ ROLLBACK-LIMIT: ${accountMachine.rollbackCount}x - consensus stalled`);
          return { success: false, error: 'Multiple rollbacks detected - consensus failure', events };
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

    console.log(
      `🔐 HANKO-VERIFY: Verifying hanko for frame ${receivedFrame.height} from ${input.fromEntityId.slice(-4)}`,
    );

    // Verify hanko - CRITICAL: Must verify fromEntityId is the signer with board validation
    const { verifyHankoForHash } = await import('./hanko-signing');
    const { valid, entityId: recoveredEntityId } = await verifyHankoForHash(
      hankoToVerify,
      receivedFrame.stateHash,
      input.fromEntityId,
      env,
    );

    if (!valid || !recoveredEntityId) {
      return { success: false, error: `Invalid hanko signature from ${input.fromEntityId.slice(-4)}`, events };
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
    console.log(
      `   TXs to process: ${receivedFrame.accountTxs.length} - [${receivedFrame.accountTxs.map(tx => tx.type).join(', ')}]`,
    );
    for (const [tokenId, delta] of clonedMachine.deltas.entries()) {
      console.log(
        `   Initial delta[${tokenId}]: ondelta=${delta.ondelta}, offdelta=${delta.offdelta}, collateral=${delta.collateral}`,
      );
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

    if (HEAVY_LOGS)
      console.log(
        `🔍 RECEIVER: Computed ${ourFinalTokenIds.length} tokens after filtering: [${ourFinalTokenIds.join(', ')}]`,
      );

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
    console.log(
      `   Our tokenIds: [${ourFinalTokenIds.join(', ')}], deltas: [${ourFinalDeltas.map(d => d.toString()).join(', ')}]`,
    );
    console.log(
      `   Their tokenIds: [${receivedFrame.tokenIds.join(', ')}], deltas: [${receivedFrame.deltas.map(d => d.toString()).join(', ')}]`,
    );
    console.log(`  Our computed:  ${ourComputedState.slice(0, 32)}...`);
    console.log(`  Their claimed: ${theirClaimedState.slice(0, 32)}...`);

    if (ourComputedState !== theirClaimedState) {
      // Compact error - full dump only if DEBUG enabled
      console.warn(
        `⚠️ CONSENSUS: Frame ${receivedFrame.height} - state mismatch (our: ${ourComputedState.slice(0, 16)}... vs their: ${theirClaimedState.slice(0, 16)}...)`,
      );
      return { success: false, error: `Bilateral consensus failure - states don't match`, events };
    }

    // SECURITY FIX: Verify BILATERAL fields in fullDeltaStates (prevents state injection attack)
    // ondelta/collateral may differ due to J-event timing, but bilateral fields MUST match:
    // - offdelta: Set by bilateral payments
    // - creditLimit: Set by bilateral set_credit_limit tx
    // - allowance: Set by bilateral transactions
    const theirFullDeltaStates = receivedFrame.fullDeltaStates || [];
    if (ourFullDeltaStates.length !== theirFullDeltaStates.length) {
      console.warn(
        `⚠️ SECURITY: fullDeltaStates count mismatch (our: ${ourFullDeltaStates.length}, their: ${theirFullDeltaStates.length})`,
      );
      return { success: false, error: `Bilateral state injection detected - delta count mismatch`, events };
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
        return { success: false, error: `Bilateral state injection detected - credit/allowance mismatch`, events };
      }
    }

    if (HEAVY_LOGS) console.log(`🔍 ABOUT-TO-VERIFY-HASH: Computing frame hash...`);
    // Duplex-safe hash validation:
    // - bilateral fields are enforced above (offdelta/limits/allowances)
    // - unilateral fields (collateral/ondelta) may lag between peers until claims converge
    //   so hash must be recomputed from sender payload, not receiver-local unilateral state
    if (HEAVY_LOGS) console.log(`🔍 COMPUTING-HASH: Creating hash for frame ${receivedFrame.height}...`);
    const recomputedSenderHash = await createFrameHash({
      height: receivedFrame.height,
      timestamp: receivedFrame.timestamp,
      jHeight: receivedFrame.jHeight,
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      tokenIds: receivedFrame.tokenIds,
      deltas: receivedFrame.deltas,
      fullDeltaStates: theirFullDeltaStates,
      stateHash: '', // Computed by createFrameHash
      byLeft: receivedFrame.byLeft,
    });

    if (recomputedSenderHash !== receivedFrame.stateHash) {
      console.warn(`⚠️ SECURITY: Frame hash mismatch after validation`);
      console.warn(`   Recomputed: ${recomputedSenderHash.slice(0, 16)}...`);
      console.warn(`   Claimed:    ${receivedFrame.stateHash.slice(0, 16)}...`);
      return { success: false, error: `Frame hash verification failed - dispute proof mismatch`, events };
    }

    console.log(`✅ CONSENSUS-SUCCESS: Both sides computed identical state for frame ${receivedFrame.height}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSENSUS PRINCIPLE: strict on bilateral fields, tolerant on unilateral lag
    // ═══════════════════════════════════════════════════════════════════════════
    // 1) Bilateral fields (offdelta/limits/allowances) MUST match our execution.
    // 2) Sender frame hash must be self-consistent.
    // 3) Unilateral fields (collateral/ondelta) may temporarily differ until
    //    j_event_claims converge and are finalized 2-of-2 in account state.
    // ═══════════════════════════════════════════════════════════════════════════

    // Emit bilateral consensus event - use OUR computed values
    env.emit('BilateralFrameCommitted', {
      fromEntity: input.fromEntityId,
      toEntity: accountMachine.proofHeader.fromEntity,
      height: receivedFrame.height,
      txCount: receivedFrame.accountTxs.length,
      tokenIds: ourFinalTokenIds, // OUR computed tokenIds
      stateHash: receivedFrame.stateHash,
    });

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

    console.log(
      `💳 RECEIVER-COMMIT COMPLETE: Deltas after re-execution for ${cpForCommitLog.slice(-4)}:`,
      Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
        tokenId,
        collateral: delta.collateral?.toString(),
        leftCreditLimit: delta.leftCreditLimit?.toString(),
        rightCreditLimit: delta.rightCreditLimit?.toString(),
        ondelta: delta.ondelta?.toString(),
        offdelta: delta.offdelta?.toString(),
      })),
    );

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
    if (replayMode) {
      console.log(
        `[REPLAY][A-MACHINE] committed frame=${receivedFrame.height} ` +
          `newCurrentHeight=${accountMachine.currentHeight} accountTxs=${receivedFrame.accountTxs.length}`,
      );
    }
    // Store counterparty dispute metadata on COMMIT (verified, frame accepted)
    if (input.newDisputeHanko && !ackProcessed && input.disputeProofNonce !== undefined && input.newDisputeHash) {
      const { verifyHankoForHash } = await import('./hanko-signing');
      const { valid: disputeValid } = await verifyHankoForHash(
        input.newDisputeHanko,
        input.newDisputeHash,
        input.fromEntityId,
        env,
      );
      if (disputeValid) {
        accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
        accountMachine.counterpartyDisputeProofNonce = input.disputeProofNonce;
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
    accountMachine.frameHistory.push({ ...receivedFrame });
    // Cap history at 10 frames to prevent snapshot bloat
    if (accountMachine.frameHistory.length > 10) {
      accountMachine.frameHistory.shift();
    }
    console.log(
      `📚 Frame ${receivedFrame.height} accepted and added to history (total: ${accountMachine.frameHistory.length})`,
    );

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // POST-FRAME AUTO-REBALANCE CHECK
    // After frame commit, check if uncollateralized debt exceeds softLimit.
    // If yes, auto-queue request_collateral + fee into mempool.
    // User is ALWAYS online here (just processed an inbound frame).
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      const { checkAutoRebalance } = await import('./account-tx/handlers/request-collateral');
      const p2p = (env as any)?.runtimeState?.p2p;
      const emitRebalanceDebug = (payload: Record<string, unknown>) => {
        if (p2p && typeof p2p.sendDebugEvent === 'function') {
          p2p.sendDebugEvent({
            level: 'info',
            code: 'REB_STEP',
            step: 1,
            accountId: input.fromEntityId,
            frameHeight: receivedFrame.height,
            ...payload,
          });
        }
      };
      const ourReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ourEntityId);
      const counterpartyReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === input.fromEntityId);
      const ourIsHub = !!ourReplica?.state?.hubRebalanceConfig;
      const counterpartyIdLower = String(input.fromEntityId || '').toLowerCase();
      const counterpartyProfile = env.gossip?.getProfiles?.().find(
        (p: any) => String(p?.entityId || '').toLowerCase() === counterpartyIdLower,
      );
      const counterpartyCaps = Array.isArray(counterpartyProfile?.capabilities)
        ? (counterpartyProfile?.capabilities as string[])
        : [];
      const counterpartyProfileIsHub =
        counterpartyProfile?.metadata?.isHub === true ||
        counterpartyCaps.includes('hub') ||
        counterpartyCaps.includes('routing');
      const counterpartyIsHub =
        !!counterpartyReplica?.state?.hubRebalanceConfig ||
        counterpartyProfileIsHub;

      const emitSkip = (reason: string) => {
        console.log(
          `ℹ️ AUTO-REBALANCE: skipped (${reason}) after frame ${receivedFrame.height} ` +
          `(policyCount=${accountMachine.rebalancePolicy?.size || 0})`,
        );
        emitRebalanceDebug({
          status: 'skipped',
          event: 'request_not_queued',
          reason,
          policyCount: accountMachine.rebalancePolicy?.size || 0,
          hasPendingFrame: !!accountMachine.pendingFrame,
        });
      };

      if (ourIsHub) {
        emitSkip('our-entity-is-hub');
      } else if (!counterpartyIsHub) {
        emitSkip('counterparty-not-hub');
      } else {
        const parseBigIntMaybe = (value: unknown): bigint | undefined => {
          if (value === undefined || value === null) return undefined;
          try {
            return typeof value === 'bigint' ? value : BigInt(value as any);
          } catch {
            return undefined;
          }
        };
        const parseNumberMaybe = (value: unknown): number | undefined => {
          if (value === undefined || value === null) return undefined;
          const n = Number(value);
          return Number.isFinite(n) && n > 0 ? n : undefined;
        };

        const hubConfig = counterpartyReplica?.state?.hubRebalanceConfig;
        const accountPolicy = accountMachine.counterpartyRebalanceFeePolicy;
        const baseFee =
          accountPolicy?.baseFee ??
          parseBigIntMaybe(hubConfig?.rebalanceBaseFee) ??
          parseBigIntMaybe(counterpartyProfile?.metadata?.rebalanceBaseFee);
        const liquidityFeeBps =
          accountPolicy?.liquidityFeeBps ??
          parseBigIntMaybe(hubConfig?.rebalanceLiquidityFeeBps) ??
          parseBigIntMaybe(counterpartyProfile?.metadata?.rebalanceLiquidityFeeBps) ??
          parseBigIntMaybe(hubConfig?.minFeeBps);
        const gasFee =
          accountPolicy?.gasFee ??
          parseBigIntMaybe(hubConfig?.rebalanceGasFee) ??
          parseBigIntMaybe(counterpartyProfile?.metadata?.rebalanceGasFee) ??
          0n;
        const policyVersion =
          accountPolicy?.policyVersion ??
          parseNumberMaybe(hubConfig?.policyVersion) ??
          parseNumberMaybe(counterpartyProfile?.metadata?.policyVersion) ??
          1;

        if (baseFee === undefined || liquidityFeeBps === undefined) {
          emitSkip('missing-hub-fee-policy');
        } else {
          const rebalanceTxs = checkAutoRebalance(accountMachine, ourEntityId, input.fromEntityId, {
            policyVersion,
            baseFee,
            liquidityFeeBps,
            gasFee,
          });
          if (rebalanceTxs.length > 0) {
            for (const tx of rebalanceTxs) {
              accountMachine.mempool.push(tx);
            }
            console.log(
              `🔄 AUTO-REBALANCE: Queued ${rebalanceTxs.length} request_collateral txs after frame ${receivedFrame.height}`,
            );
            emitRebalanceDebug({
              status: 'ok',
              event: 'request_queued',
              txCount: rebalanceTxs.length,
              tokenIds: rebalanceTxs
                .map((tx: any) => tx?.data?.tokenId)
                .filter((v: unknown) => typeof v === 'number'),
            });
          } else {
            emitSkip('fee-policy-or-threshold');
          }
        }
      }
    } catch (rebalanceErr) {
      // Non-fatal: rebalance check failure shouldn't break frame processing
      console.warn(`⚠️ Auto-rebalance check failed (non-fatal):`, (rebalanceErr as Error).message);
    }

    // Send confirmation (ACK) using HANKO
    const ackEntityId = accountMachine.proofHeader.fromEntity;
    const ackReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ackEntityId);
    const ackSignerId = ackReplica?.state.config.validators[0];
    if (!ackSignerId) {
      return { success: false, error: `Cannot find signerId for ACK from ${ackEntityId.slice(-4)}`, events };
    }

    console.log(`🔐 HANKO-ACK: entityId=${ackEntityId.slice(-4)} → signerId=${ackSignerId.slice(-4)}`);

    // Build ACK hanko
    const { signHashesAsSingleEntity } = await import('./hanko-signing');
    const ackHankos = await signHashesAsSingleEntity(env, ackEntityId, ackSignerId, [receivedFrame.stateHash]);
    const confirmationHanko = ackHankos[0];
    if (!confirmationHanko) {
      return { success: false, error: 'Failed to build ACK hanko', events };
    }

    console.log(
      `📤 ACK-SEND: Preparing ACK for frame ${receivedFrame.height} from ${accountMachine.proofHeader.fromEntity.slice(-4)} to ${input.fromEntityId.slice(-4)}`,
    );

    // CHANNEL.TS PATTERN (Lines 576-612): Batch ACK + new frame in same message!
    // Check if we should batch BEFORE incrementing nonce
    let batchedWithNewFrame = false;
    let proposeResult: Awaited<ReturnType<typeof proposeAccountFrame>> | undefined;
    // Build dispute proof hanko for ACK response (always include current state's dispute proof)
    const { buildAccountProofBody: buildProof, createDisputeProofHash: createHash } = await import('./proof-builder');
    const ackDepositoryAddress = getDepositoryAddress(env);
    const ackProofResult = buildProof(accountMachine);
    const ackDisputeHash = createHash(accountMachine, ackProofResult.proofBodyHash, ackDepositoryAddress);
    const ackDisputeHankos = await signHashesAsSingleEntity(env, ackEntityId, ackSignerId, [ackDisputeHash]);
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

    const response: AccountInput = {
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedFrame.height,
      prevHanko: confirmationHanko, // Hanko ACK on their frame
      ...(ackDisputeHanko && { newDisputeHanko: ackDisputeHanko }), // My dispute proof hanko (current state)
      newDisputeHash: ackDisputeHash, // Full dispute hash (key in hankoWitness for quorum lookup)
      newDisputeProofBodyHash: ackProofResult.proofBodyHash, // ProofBodyHash that ackDisputeHanko signs
      disputeProofNonce: ackSignedNonce, // nonce at which ACK's dispute proof was signed
    };

    if (HEAVY_LOGS)
      console.log(
        `🔍 BATCH-CHECK for account ${input.fromEntityId.slice(-4)}: mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, mempoolTxs=[${accountMachine.mempool.map(tx => tx.type).join(',')}]`,
      );
    if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
      console.log(`📦 BATCH-OPTIMIZATION: Sending ACK + new frame in single message (Channel.ts pattern)`);

      // Pass skipNonceIncrement=true since we'll increment for the whole batch below
      proposeResult = await proposeAccountFrame(env, accountMachine, true);

      if (proposeResult.success && proposeResult.accountInput) {
        batchedWithNewFrame = true;
        // Merge ACK and new proposal into same AccountInput
        if (proposeResult.accountInput.newAccountFrame) {
          response.newAccountFrame = proposeResult.accountInput.newAccountFrame;
        }
        if (proposeResult.accountInput.newHanko) {
          response.newHanko = proposeResult.accountInput.newHanko;
        }
        // DON'T overwrite response.newDisputeHanko (it's ACK's dispute hanko for current committed state)
        // Proposal's newDisputeHanko will be delivered when proposal commits, not now
        // This preserves ACK's dispute hanko for last agreed state

        const newFrameId = proposeResult.accountInput.newAccountFrame?.height || 0;
        console.log(`✅ Batched ACK for frame ${receivedFrame.height} + proposal for frame ${newFrameId}`);
        events.push(`📤 Batched ACK + frame ${newFrameId}`);
      }
    }

    if (!batchedWithNewFrame && ackDisputeHanko) {
      accountMachine.currentDisputeProofHanko = ackDisputeHanko;
      accountMachine.currentDisputeProofNonce = ackSignedNonce;
      accountMachine.currentDisputeProofBodyHash = ackProofResult.proofBodyHash;
    }

    // Increment nonce for this message (on-chain nonce for dispute proofs / settlements)
    ++accountMachine.proofHeader.nonce;
    console.log(`🔢 nonce: ${accountMachine.proofHeader.nonce} (batched=${batchedWithNewFrame})`);

    // Merge revealed secrets from BOTH incoming frame AND proposed frame
    const allRevealedSecrets = [
      ...revealedSecrets, // From incoming frame (line 493)
      ...(proposeResult?.revealedSecrets || []), // From our proposed frame (if batched)
    ];

    // Merge swap offers from BOTH incoming frame AND proposed frame
    const allSwapOffersCreated = [...swapOffersCreated, ...(proposeResult?.swapOffersCreated || [])];
    const allSwapOffersCancelled = [...swapOffersCancelled, ...(proposeResult?.swapOffersCancelled || [])];

    // Collect hashes that need entity-quorum signing (multi-signer support)
    const hashesToSign: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }> = [
      {
        hash: receivedFrame.stateHash,
        type: 'accountFrame',
        context: `account:${input.fromEntityId.slice(-8)}:ack:${receivedFrame.height}`,
      },
      { hash: ackDisputeHash, type: 'dispute', context: `account:${input.fromEntityId.slice(-8)}:ack-dispute` },
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
      swapOffersCancelled: allSwapOffersCancelled,
      timedOutHashlocks,
      ...(hashesToSign.length > 0 && { hashesToSign }),
    };
  }

  // ACK inputs must never be silently ignored; this causes replay divergence.
  if (input.prevHanko && !ackProcessed && !input.newAccountFrame) {
    const pending = accountMachine.pendingFrame?.height ?? 'none';
    return {
      success: false,
      error: `Unmatched ACK: height=${String(normalizedInputHeight ?? 'none')} pending=${String(pending)}`,
      events,
    };
  }

  if (HEAVY_LOGS) console.log(`🔍 RETURN-NO-RESPONSE: No response object`);
  return { success: true, events, swapOffersCreated: [], swapOffersCancelled: [], timedOutHashlocks };
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
  const should = accountMachine.mempool.length > 0 && !accountMachine.pendingFrame;
  console.error(
    `   shouldProposeFrame: mempool=${accountMachine.mempool.length}, pending=${!!accountMachine.pendingFrame}, result=${should}`,
  );
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

  // Create proof structure compatible with Depository.sol (legacy format)
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
