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

import { AccountMachine, AccountFrame, AccountTx, AccountInput, Env, EntityState, Delta } from './types';
import { cloneAccountMachine, getAccountPerspective } from './state-helpers';
import { isLeft } from './account-utils';
import { signAccountFrame, verifyAccountSignature } from './account-crypto';
import { cryptoHash as hash, formatEntityId } from './utils';
import { logError } from './logger';
import { safeStringify } from './serialization-utils';
import { validateAccountFrame as validateAccountFrameStrict } from './validation-utils';
import { processAccountTx } from './account-tx/apply';

// Removed createValidAccountSnapshot - using simplified AccountSnapshot interface

// === CONSTANTS ===
const MEMPOOL_LIMIT = 1000;
const MAX_MESSAGE_COUNTER = 1000000;
const MAX_FRAME_TIMESTAMP_DRIFT_MS = 300000; // 5 minutes
const MAX_FRAME_SIZE_BYTES = 1048576; // 1MB frame size limit (Bitcoin block size standard)

function shouldIncludeToken(delta: Delta, totalDelta: bigint): boolean {
  const hasHolds = (delta.leftHtlcHold || 0n) !== 0n ||
                   (delta.rightHtlcHold || 0n) !== 0n ||
                   (delta.leftSwapHold || 0n) !== 0n ||
                   (delta.rightSwapHold || 0n) !== 0n;

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

/**
 * Validate message counter (strict replay protection)
 * Counter must be EXACTLY ackedTransitions + 1 (sequential, no gaps allowed)
 */
export function validateMessageCounter(accountMachine: AccountMachine, counter: number): boolean {
  if (counter <= 0 || counter > MAX_MESSAGE_COUNTER) {
    console.log(`❌ Counter out of range: ${counter} (must be 1-${MAX_MESSAGE_COUNTER})`);
    return false;
  }

  // CRITICAL: Enforce STRICT sequential increment (no gaps, no replays, no skips)
  const expectedCounter = accountMachine.ackedTransitions + 1;
  if (counter !== expectedCounter) {
    console.log(`❌ Counter violation: got ${counter}, expected ${expectedCounter} (ackedTransitions=${accountMachine.ackedTransitions})`);
    return false;
  }

  return true;
}

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
    }))
  };

  // Use keccak256 like 2024 Channel.ts (not truncated hash20)
  const encoded = safeStringify(frameData); // Deterministic JSON encoding
  return ethers.keccak256(ethers.toUtf8Bytes(encoded));
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
  skipCounterIncrement: boolean = false,
  entityJHeight?: number // Optional: J-height from entity state for HTLC consensus
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
}> {
  // Derive counterparty from canonical left/right
  const myEntityId = accountMachine.proofHeader.fromEntity;
  const { counterparty } = getAccountPerspective(accountMachine, myEntityId);
  console.log(`🚀 E-MACHINE: Proposing account frame for ${counterparty.slice(-4)}`);
  console.log(`🚀 E-MACHINE: Account state - mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, currentHeight=${accountMachine.currentHeight}`);
  console.log(`🚀 E-MACHINE: Mempool contents:`, accountMachine.mempool.map(tx => tx.type));

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
    console.log(`⏳ E-MACHINE: Still waiting for ACK on pending frame #${accountMachine.pendingFrame.height}`);
    return { success: false, error: 'Waiting for ACK on pending frame', events };
  }

  console.log(`✅ E-MACHINE: Creating frame with ${accountMachine.mempool.length} transactions...`);
  console.log(`🔍 PROOF-HEADER: from=${formatEntityId(accountMachine.proofHeader.fromEntity)}, to=${formatEntityId(accountMachine.proofHeader.toEntity)}`);

  // Clone account machine for validation
  const clonedMachine = cloneAccountMachine(accountMachine);

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

  console.log(`🔍 MEMPOOL-BEFORE-PROCESS: ${accountMachine.mempool.length} txs:`, accountMachine.mempool.map(tx => tx.type));

  for (const accountTx of accountMachine.mempool) {
    console.log(`   🔍 Processing accountTx type=${accountTx.type}`);
    const result = await processAccountTx(
      clonedMachine,
      accountTx,
      true, // Processing our own transactions
      env.timestamp, // Will be replaced by frame.timestamp during commit
      frameJHeight,  // Entity's synced J-height
      true // isValidation = true (on clone, skip persistent state updates)
    );

    if (!result.success) {
      // CRITICAL: Remove failed tx from mempool to prevent blocking future proposals
      const failedIndex = accountMachine.mempool.indexOf(accountTx);
      if (failedIndex >= 0) {
        accountMachine.mempool.splice(failedIndex, 1);
        console.log(`⚠️ Removed failed tx from mempool: ${accountTx.type} (${result.error})`);
      }
      return { success: false, error: `Tx validation failed: ${result.error}`, events: allEvents };
    }

    allEvents.push(...result.events);

    // Collect revealed secrets for backward propagation
    console.log(`🔍 TX-RESULT: type=${accountTx.type}, hasSecret=${!!result.secret}, hasHashlock=${!!result.hashlock}`);
    if (result.secret && result.hashlock) {
      console.log(`✅ Collected secret from ${accountTx.type}`);
      revealedSecrets.push({ secret: result.secret, hashlock: result.hashlock });
    }

    // Collect swap offers for orderbook integration
    if (result.swapOfferCreated) {
      console.log(`📊 Collected swap offer: ${result.swapOfferCreated.offerId}`);
      swapOffersCreated.push(result.swapOfferCreated);
    }

    // Collect cancelled offers for orderbook cleanup
    if (result.swapOfferCancelled) {
      console.log(`📊 Collected swap cancel: ${result.swapOfferCancelled.offerId}`);
      swapOffersCancelled.push(result.swapOfferCancelled);
    }
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
    const totalDelta = delta.ondelta + delta.offdelta;

    // Skip tokens with zero delta AND zero limits AND zero holds (never used)
    // CRITICAL: Include tokens with HTLC/swap holds even if delta/limits/collateral are zero
    // NOTE: Collateral changes from j_events are included separately in frame validation
    // Only skip if delta, limits, AND holds are all zero
    // Collateral is omitted here because j_events can set it during frame processing
    if (!shouldIncludeToken(delta, totalDelta)) {
      console.log(`⏭️  Skipping unused token ${tokenId} from frame (zero delta/limits/holds)`);
      continue;
    }

    finalTokenIds.push(tokenId);
    finalDeltas.push(totalDelta);
    // AUDIT FIX: Store FULL delta state (collateral, credit limits, allowances)
    fullDeltaStates.push({ ...delta });
  }

  console.log(`📊 Frame state after processing: ${finalTokenIds.length} tokens`);
  console.log(`📊 TokenIds: [${finalTokenIds.join(', ')}]`);
  console.log(`📊 Deltas: [${finalDeltas.map(d => d.toString()).join(', ')}]`);
  console.log(`📊 FullDeltaStates:`, fullDeltaStates.map(d => ({
    tokenId: d.tokenId,
    collateral: d.collateral?.toString(),
    leftCreditLimit: d.leftCreditLimit?.toString(),
    rightCreditLimit: d.rightCreditLimit?.toString(),
  })));

  // Determine if we're left entity (for byLeft field)
  const weAreLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;

  // Validate timestamp before creating frame (HTLC safety - prevent time manipulation)
  const previousTimestamp = accountMachine.currentFrame?.timestamp;
  if (previousTimestamp !== undefined && env.timestamp < previousTimestamp) {
    console.log(`❌ E-MACHINE: Cannot propose - timestamp regression: ${env.timestamp} < ${previousTimestamp}`);
    return { success: false, error: 'Timestamp went backwards', events };
  }

  // Create account frame matching the real AccountFrame interface
  const frameData = {
    height: accountMachine.currentHeight + 1,
    timestamp: env.timestamp, // DETERMINISTIC: Copy from runtime machine
    jHeight: frameJHeight, // CRITICAL: J-height for HTLC consensus
    accountTxs: [...accountMachine.mempool],
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
  console.log(`✅ Frame size: ${frameSize} bytes (${(frameSize / MAX_FRAME_SIZE_BYTES * 100).toFixed(2)}% of 1MB limit)`);

  // Generate signature
  const signature = signAccountFrame(accountMachine.proofHeader.fromEntity, newFrame.stateHash);

  // Set pending state (no longer storing clone - re-execution on commit)
  accountMachine.pendingFrame = newFrame;
  accountMachine.sentTransitions = accountMachine.mempool.length;
  console.log(`🔒 PROPOSE: Account ${accountMachine.proofHeader.fromEntity.slice(-4)}:${accountMachine.proofHeader.toEntity.slice(-4)} pendingFrame=${newFrame.height}, txs=${newFrame.accountTxs.length}`);

  // Clear mempool
  accountMachine.mempool = [];

  events.push(`🚀 Proposed frame ${newFrame.height} with ${newFrame.accountTxs.length} transactions`);

  const accountInput: AccountInput = {
    fromEntityId: accountMachine.proofHeader.fromEntity,
    toEntityId: accountMachine.proofHeader.toEntity,
    height: newFrame.height,
    newAccountFrame: newFrame,
    newSignatures: [signature],
    counter: skipCounterIncrement ? accountMachine.proofHeader.cooperativeNonce : ++accountMachine.proofHeader.cooperativeNonce,
  };

  return { success: true, accountInput, events, revealedSecrets, swapOffersCreated, swapOffersCancelled };
}

/**
 * Handle received AccountInput (bilateral consensus)
 */
export async function handleAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput
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
}> {
  console.log(`📨 A-MACHINE: Received AccountInput from ${input.fromEntityId.slice(-4)}, pendingFrame=${accountMachine.pendingFrame ? `h${accountMachine.pendingFrame.height}` : 'none'}, currentHeight=${accountMachine.currentHeight}`);
  console.log(`📨 A-MACHINE INPUT: height=${input.height || 'none'}, hasACK=${!!input.prevSignatures}, hasNewFrame=${!!input.newAccountFrame}, counter=${input.counter}`);

  const events: string[] = [];
  const timedOutHashlocks: string[] = [];

  // CRITICAL: Counter validation (replay protection) - ALWAYS enforce, no frame 0 exemption
  if (input.counter !== undefined) {
    // SPECIAL CASE: If this is an ACK for our pendingFrame, allow counter flexibility
    // When we proposed pendingFrame, we incremented cooperativeNonce (counter), but ackedTransitions
    // hasn't been updated yet (only updated when ACK arrives). So ACK counter can be > ackedTransitions+1.
    const isACKForPendingFrame = accountMachine.pendingFrame
      && input.height === accountMachine.pendingFrame.height
      && input.prevSignatures
      && input.prevSignatures.length > 0;

    let counterValid: boolean;
    if (isACKForPendingFrame) {
      // For ACKs, counter should match or exceed ackedTransitions (to account for our proposal increment)
      // Just validate it's in valid range and not going backwards
      counterValid = input.counter > 0 && input.counter <= MAX_MESSAGE_COUNTER && input.counter >= accountMachine.ackedTransitions;
      console.log(`🔍 Counter validation (ACK for pendingFrame): ${input.counter} vs acked=${accountMachine.ackedTransitions}, valid=${counterValid}`);
    } else {
      counterValid = validateMessageCounter(accountMachine, input.counter);
      console.log(`🔍 Counter validation: ${input.counter} vs acked=${accountMachine.ackedTransitions}, height=${accountMachine.currentHeight}, valid=${counterValid}`);
    }

    if (!counterValid) {
      return { success: false, error: `Replay attack detected: counter ${input.counter} invalid (expected ${accountMachine.ackedTransitions + 1})`, events };
    }

    // DoS FIX: Update counter AFTER signature verification (moved below)
    // If we update here, attacker can desync counters with invalid signatures
  } else {
    // Counter is REQUIRED for all messages (replay protection)
    return { success: false, error: 'Missing counter - replay protection requires sequential counter', events };
  }

  // Handle pending frame confirmation
  if (accountMachine.pendingFrame && input.height === accountMachine.pendingFrame.height && input.prevSignatures) {
    console.log(`✅ Received confirmation for pending frame ${input.height}`);
    console.log(`✅ ACK-DEBUG: fromEntity=${input.fromEntityId.slice(-4)}, toEntity=${input.toEntityId.slice(-4)}, counter=${input.counter}`);

    const frameHash = accountMachine.pendingFrame.stateHash;
    const expectedSigner = accountMachine.proofHeader.toEntity;

    const signature = input.prevSignatures[0];
    if (input.prevSignatures.length > 0 && signature && verifyAccountSignature(expectedSigner, frameHash, signature)) {
      // DoS FIX: Update counter AFTER signature verified (prevents counter desync attacks)
      if (input.counter !== undefined) {
        accountMachine.ackedTransitions = input.counter;
        console.log(`✅ ACK-BLOCK COUNTER-UPDATE: ackedTransitions now ${accountMachine.ackedTransitions} (from ACK processing)`);
      }

      // CRITICAL DEBUG: Log what we're committing
      console.log(`🔒 COMMIT: Frame ${accountMachine.pendingFrame.height}`);
      console.log(`  Transactions: ${accountMachine.pendingFrame.accountTxs.length}`);
      console.log(`  Transactions detail:`, accountMachine.pendingFrame.accountTxs);
      console.log(`  TokenIds: ${accountMachine.pendingFrame.tokenIds.join(',')}`);
      console.log(`  Deltas: ${accountMachine.pendingFrame.deltas.map(d => `${d}`).join(',')}`);
      console.log(`  StateHash: ${frameHash.slice(0,16)}...`);

      // PROPOSER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
      // This eliminates fragile manual field copying
      {
        const { counterparty: cpForLog } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
        console.log(`🔓 PROPOSER-COMMIT: Re-executing ${accountMachine.pendingFrame.accountTxs.length} txs for ${cpForLog.slice(-4)}`);

        // Re-execute all frame txs on REAL accountMachine (deterministic)
        // CRITICAL: Use frame.timestamp for determinism (HTLC validation must use agreed consensus time)
        const pendingJHeight = accountMachine.pendingFrame.jHeight ?? accountMachine.currentHeight;
        for (const tx of accountMachine.pendingFrame.accountTxs) {
          const commitResult = await processAccountTx(accountMachine, tx, true, accountMachine.pendingFrame.timestamp, pendingJHeight);
          if (!commitResult.success) {
            console.error(`❌ PROPOSER-COMMIT FAILED for tx type=${tx.type}: ${commitResult.error}`);
            throw new Error(`Frame ${accountMachine.pendingFrame.height} commit failed: ${tx.type} - ${commitResult.error}`);
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

        // Clean up clone (no longer needed with re-execution)
        delete accountMachine.clonedForValidation;

        accountMachine.currentFrame = {
          height: accountMachine.pendingFrame.height,
          timestamp: accountMachine.pendingFrame.timestamp,
          jHeight: accountMachine.pendingFrame.jHeight,
          accountTxs: accountMachine.pendingFrame.accountTxs,
          prevFrameHash: accountMachine.pendingFrame.prevFrameHash,
          tokenIds: accountMachine.pendingFrame.tokenIds,
          deltas: accountMachine.pendingFrame.deltas,
          stateHash: accountMachine.pendingFrame.stateHash,
          byLeft: accountMachine.pendingFrame.byLeft,
        };
        accountMachine.currentHeight = accountMachine.pendingFrame.height;

        // Add confirmed frame to history
        accountMachine.frameHistory.push({...accountMachine.pendingFrame});
        // Cap history at 10 frames to prevent snapshot bloat
        if (accountMachine.frameHistory.length > 10) {
          accountMachine.frameHistory.shift();
        }
        console.log(`📚 Frame ${accountMachine.pendingFrame.height} added to history (total: ${accountMachine.frameHistory.length})`);
      }

      // Clear pending state
      delete accountMachine.pendingFrame;
      accountMachine.sentTransitions = 0;
      delete accountMachine.clonedForValidation;
      accountMachine.rollbackCount = Math.max(0, accountMachine.rollbackCount - 1); // Successful confirmation reduces rollback

      console.log(`✅ PENDING-CLEARED: Frame ${input.height} confirmed, mempool now has ${accountMachine.mempool.length} txs: [${accountMachine.mempool.map(tx => tx.type).join(',')}]`);
      events.push(`✅ Frame ${input.height} confirmed and committed`);

      // CRITICAL FIX: Chained Proposal - if mempool has items (e.g. j_event_claim), propose immediately
      if (!input.newAccountFrame) {
        if (accountMachine.mempool.length > 0) {
          console.log(`🚀 CHAINED-PROPOSAL: ACK received, mempool has ${accountMachine.mempool.length} txs - proposing next frame immediately`);
          const proposeResult = await proposeAccountFrame(env, accountMachine);
          if (proposeResult.success && proposeResult.accountInput) {
            return {
              success: true,
              response: proposeResult.accountInput,
              events: [...events, ...proposeResult.events],
              revealedSecrets: proposeResult.revealedSecrets,
              swapOffersCreated: proposeResult.swapOffersCreated,
              swapOffersCancelled: proposeResult.swapOffersCancelled,
              timedOutHashlocks
            };
          }
        }
        console.log(`🔍 RETURN-ACK-ONLY: frame ${input.height} ACKed, no new frame bundled`);
        return { success: true, events, timedOutHashlocks };
      }
      // Fall through to process newAccountFrame below
      console.log(`📦 BATCHED-MESSAGE: ACK processed, now processing bundled new frame...`);
    } else {
      return { success: false, error: 'Invalid confirmation signature', events };
    }
  }

  // Handle new frame proposal
  if (input.newAccountFrame) {
    const receivedFrame = input.newAccountFrame;

    // Validate frame with timestamp checks (HTLC safety)
    const previousTimestamp = accountMachine.currentFrame?.timestamp;
    if (!validateAccountFrame(receivedFrame, env.timestamp, previousTimestamp)) {
      return { success: false, error: 'Invalid frame structure', events };
    }

    // CRITICAL: Verify prevFrameHash links to our current frame (prevent state fork)
    const expectedPrevFrameHash = accountMachine.currentHeight === 0
      ? 'genesis'
      : accountMachine.currentFrame.stateHash || '';

    if (receivedFrame.prevFrameHash !== expectedPrevFrameHash) {
      console.warn(`⚠️ FRAME-CHAIN: prevHash mismatch at height ${accountMachine.currentHeight}`);
      return {
        success: false,
        error: `Frame chain broken: prevFrameHash mismatch (expected ${expectedPrevFrameHash.slice(0, 16)}...)`,
        events
      };
    }

    console.log(`✅ Frame chain verified: prevFrameHash matches frame ${accountMachine.currentHeight}`);

    // CHANNEL.TS REFERENCE: Lines 138-165 - Proper rollback logic for simultaneous proposals
    // Handle simultaneous proposals when both sides send same height
    if (accountMachine.pendingFrame && receivedFrame.height === accountMachine.pendingFrame.height) {
      console.log(`🔄 SIMULTANEOUS-PROPOSALS: Both proposed frame ${receivedFrame.height}`);

      // Deterministic tiebreaker: Left always wins (CHANNEL.TS REFERENCE: Line 140-157)
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      console.log(`🔍 TIEBREAKER: fromEntity=${accountMachine.proofHeader.fromEntity.slice(-4)}, toEntity=${accountMachine.proofHeader.toEntity.slice(-4)}, isLeft=${isLeftEntity}`);

      if (isLeftEntity) {
        // We are LEFT - ignore their frame, keep ours (deterministic tiebreaker)
        console.log(`📤 LEFT-WINS: Ignoring right's frame ${receivedFrame.height}, waiting for them to accept ours`);

        // EMIT EVENT: Track LEFT wins tiebreaker
        events.push(`📤 LEFT-WINS: Ignored RIGHT's frame ${receivedFrame.height} (waiting for their ACK)`);

        // CRITICAL FIX: Even though we ignore their frame, check mempool and send update if we have new txs
        // This prevents j_event_claims from getting stuck when both sides propose simultaneously
        if (accountMachine.mempool.length > 0) {
          console.log(`📤 LEFT-WINS-BUT-HAS-MEMPOOL: ${accountMachine.mempool.length} txs waiting - notifying counterparty`);
          events.push(`⚠️ LEFT has ${accountMachine.mempool.length} pending txs while waiting for RIGHT's ACK`);
          // Send a message with just mempool status so they know we have pending work
          // TODO: Determine if we should send frames or just signal
        }
        // This is NOT an error - it's correct consensus behavior (Channel.ts handlePendingBlock)
        return { success: true, events };
      } else {
        // We are RIGHT - rollback our frame, accept theirs
        if (accountMachine.rollbackCount === 0) {
          // First rollback - restore transactions to mempool before discarding frame
          let restoredTxCount = 0;
          if (accountMachine.pendingFrame) {
            restoredTxCount = accountMachine.pendingFrame.accountTxs.length;
            console.log(`📥 RIGHT-ROLLBACK: Restoring ${restoredTxCount} txs to mempool`);
            // CRITICAL: Re-add transactions to mempool (Channel.ts pattern)
            accountMachine.mempool.unshift(...accountMachine.pendingFrame.accountTxs);
            console.log(`📥 Mempool now has ${accountMachine.mempool.length} txs after rollback restore`);

            // EMIT EVENT: Track rollback for debugging
            events.push(`🔄 ROLLBACK: Discarded our frame ${accountMachine.pendingFrame.height}, restored ${restoredTxCount} txs to mempool`);
          }

          accountMachine.sentTransitions = 0;
          delete accountMachine.pendingFrame;
          delete accountMachine.clonedForValidation;
          accountMachine.rollbackCount++;
          console.log(`📥 RIGHT-ROLLBACK: Accepting left's frame (rollbacks: ${accountMachine.rollbackCount})`);

          // EMIT EVENT: Track that we accepted LEFT's frame
          events.push(`📥 Accepted LEFT's frame ${receivedFrame.height} (we are RIGHT, deterministic tiebreaker)`);

          // Continue to process their frame below
        } else {
          // Should never rollback twice
          console.warn(`⚠️ ROLLBACK-LIMIT: ${accountMachine.rollbackCount}x - consensus stalled`);
          return { success: false, error: 'Multiple rollbacks detected - consensus failure', events };
        }
      }
    }

    // CHANNEL.TS REFERENCE: Lines 161-164 - Decrement rollbacks on successful confirmation
    if (accountMachine.pendingFrame && receivedFrame.height === accountMachine.currentHeight + 1 && accountMachine.rollbackCount > 0) {
      // They accepted our frame after we had rollbacks - decrement
      accountMachine.rollbackCount--;
      console.log(`✅ ROLLBACK-RESOLVED: They accepted our frame (rollbacks: ${accountMachine.rollbackCount})`);
    }

    // Verify frame sequence
    console.log(`🔍 SEQUENCE-CHECK: receivedFrame.height=${receivedFrame.height}, currentHeight=${accountMachine.currentHeight}, expected=${accountMachine.currentHeight + 1}`);
    if (receivedFrame.height !== accountMachine.currentHeight + 1) {
      console.log(`❌ Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`);
      return { success: false, error: `Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`, events };
    }

    // SECURITY: Verify signatures (REQUIRED for all frames)
    console.log(`🔍 SIG-CHECK: hasSignatures=${!!(input.newSignatures && input.newSignatures.length > 0)}`);
    if (!input.newSignatures || input.newSignatures.length === 0) {
      return { success: false, error: 'SECURITY: Frame must have signatures', events };
    }

    const signature = input.newSignatures[0];
    if (!signature) {
      return { success: false, error: 'Missing signature in newSignatures array', events };
    }
    const isValid = verifyAccountSignature(input.fromEntityId, receivedFrame.stateHash, signature);
    if (!isValid) {
      return { success: false, error: 'Invalid frame signature', events };
    }
    console.log(`✅ SIG-VERIFIED`);

    // Get entity's synced J-height for deterministic HTLC validation
    const ourEntityId = accountMachine.proofHeader.fromEntity;
    const ourReplica = Array.from(env.eReplicas.values()).find(r => r.state.entityId === ourEntityId);
    const currentJHeight = ourReplica?.state.lastFinalizedJHeight || 0;
    const frameJHeight = receivedFrame.jHeight ?? currentJHeight;

    // Apply frame transactions to clone (as receiver)
    const clonedMachine = cloneAccountMachine(accountMachine);
    const processEvents: string[] = [];
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
        false, // Processing their transactions = incoming
        receivedFrame.timestamp, // DETERMINISTIC: Use frame's consensus timestamp
        frameJHeight,  // Frame's consensus J-height
        true // isValidation = true (on clone, skip bilateral finalization)
      );
      if (!result.success) {
        return { success: false, error: `Frame application failed: ${result.error}`, events };
      }
      processEvents.push(...result.events);

      console.log(`🔍 TX-PROCESSED: ${accountTx.type}, success=${result.success}`);
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
      const totalDelta = delta.ondelta + delta.offdelta;

      // CONSENSUS FIX: Apply SAME filtering as proposer
      // Skip tokens with zero delta AND zero limits (never used)
      if (!shouldIncludeToken(delta, totalDelta)) {
        console.log(`⏭️  RECEIVER: Skipping unused token ${tokenId} from validation (zero delta/limits/holds)`);
        continue;
      }

      ourFinalTokenIds.push(tokenId);
      ourFinalDeltas.push(totalDelta);
    }

    console.log(`🔍 RECEIVER: Computed ${ourFinalTokenIds.length} tokens after filtering: [${ourFinalTokenIds.join(', ')}]`);

    // CRITICAL: Extract FULL delta states for hash verification (same as proposer does)
    // This ensures hash verification includes credit limits, collateral, allowances
    const ourFullDeltaStates: import('./types').Delta[] = [];
    for (const [tokenId, delta] of sortedOurTokens) {
      const totalDelta = delta.ondelta + delta.offdelta;
      // Apply SAME filtering as proposer (skip unused tokens)
      if (!shouldIncludeToken(delta, totalDelta)) {
        continue;
      }
      ourFullDeltaStates.push({ ...delta });
    }

    const ourComputedState = Buffer.from(ourFinalDeltas.map(d => d.toString()).join(',')).toString('hex');
    const theirClaimedState = Buffer.from(receivedFrame.deltas.map(d => d.toString()).join(',')).toString('hex');

    console.log(`🔍 STATE-VERIFY Frame ${receivedFrame.height}:`);
    console.log(`  Our computed:  ${ourComputedState.slice(0, 32)}...`);
    console.log(`  Their claimed: ${theirClaimedState.slice(0, 32)}...`);

    if (ourComputedState !== theirClaimedState) {
      // Compact error - full dump only if DEBUG enabled
      console.warn(`⚠️ CONSENSUS: Frame ${receivedFrame.height} - state mismatch (our: ${ourComputedState.slice(0,16)}... vs their: ${theirClaimedState.slice(0,16)}...)`);
      return { success: false, error: `Bilateral consensus failure - states don't match`, events };
    }

    console.log(`🔍 ABOUT-TO-VERIFY-HASH: Computing frame hash...`);
    // SECURITY: Verify full frame hash (tokenIds + fullDeltaStates + deltas)
    // This prevents accepting frames with poisoned dispute proofs
    console.log(`🔍 COMPUTING-HASH: Creating hash for frame ${receivedFrame.height}...`);
    const recomputedHash = await createFrameHash({
      height: receivedFrame.height,
      timestamp: receivedFrame.timestamp,
      jHeight: receivedFrame.jHeight,
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      tokenIds: ourFinalTokenIds,
      deltas: ourFinalDeltas,
      fullDeltaStates: ourFullDeltaStates, // CRITICAL FIX: Compute from clonedMachine like proposer does
      stateHash: '', // Computed by createFrameHash
      byLeft: receivedFrame.byLeft,
    });

    if (recomputedHash !== receivedFrame.stateHash) {
      console.warn(`⚠️ SECURITY: Frame hash mismatch after validation`);
      console.warn(`   Recomputed: ${recomputedHash.slice(0,16)}...`);
      console.warn(`   Claimed:    ${receivedFrame.stateHash.slice(0,16)}...`);
      return { success: false, error: `Frame hash verification failed - dispute proof mismatch`, events };
    }

    console.log(`✅ CONSENSUS-SUCCESS: Both sides computed identical state for frame ${receivedFrame.height}`);

    // Emit bilateral consensus event
    env.emit('BilateralFrameCommitted', {
      fromEntity: input.fromEntityId,
      toEntity: accountMachine.proofHeader.fromEntity,
      height: receivedFrame.height,
      txCount: receivedFrame.accountTxs.length,
      tokenIds: receivedFrame.tokenIds,
      stateHash: receivedFrame.stateHash,
    });

    // RECEIVER COMMIT: Re-execute txs on REAL state (Channel.ts pattern)
    // This eliminates fragile manual field copying
    const { counterparty: cpForCommitLog } = getAccountPerspective(accountMachine, ourEntityId);
    console.log(`🔍 RECEIVER-COMMIT: Re-executing ${receivedFrame.accountTxs.length} txs for ${cpForCommitLog.slice(-4)}`);

    // Re-execute all frame txs on REAL accountMachine (deterministic)
    // CRITICAL: Use receivedFrame.timestamp for determinism (HTLC validation must use agreed consensus time)
    for (const tx of receivedFrame.accountTxs) {
      // CRITICAL: Use frame.jHeight for HTLC checks (consensus-aligned height)
      const jHeightForCommit = receivedFrame.jHeight || accountMachine.currentHeight;
      const commitResult = await processAccountTx(accountMachine, tx, false, receivedFrame.timestamp, jHeightForCommit);

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

    accountMachine.currentFrame = {
      height: receivedFrame.height,
      timestamp: receivedFrame.timestamp,
      jHeight: receivedFrame.jHeight,
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      tokenIds: receivedFrame.tokenIds,
      deltas: receivedFrame.deltas,
      stateHash: receivedFrame.stateHash,
      byLeft: receivedFrame.byLeft, // Copy proposer info
    };
    accountMachine.currentHeight = receivedFrame.height;

    // Add accepted frame to history
    accountMachine.frameHistory.push({...receivedFrame});
    // Cap history at 10 frames to prevent snapshot bloat
    if (accountMachine.frameHistory.length > 10) {
      accountMachine.frameHistory.shift();
    }
    console.log(`📚 Frame ${receivedFrame.height} accepted and added to history (total: ${accountMachine.frameHistory.length})`);

    // CRITICAL: Update ackedTransitions after successfully processing incoming frame
    if (input.counter !== undefined) {
      accountMachine.ackedTransitions = input.counter;
      console.log(`✅ COUNTER-UPDATE: ackedTransitions now ${accountMachine.ackedTransitions} (next expected: ${accountMachine.ackedTransitions + 1})`);
    }

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

    // Send confirmation (ACK)
    const confirmationSig = signAccountFrame(accountMachine.proofHeader.fromEntity, receivedFrame.stateHash);

    console.log(`📤 ACK-SEND: Preparing ACK for frame ${receivedFrame.height} from ${accountMachine.proofHeader.fromEntity.slice(-4)} to ${input.fromEntityId.slice(-4)}`);

    // CHANNEL.TS PATTERN (Lines 576-612): Batch ACK + new frame in same message!
    // Check if we should batch BEFORE incrementing counter
    let batchedWithNewFrame = false;
    let proposeResult: Awaited<ReturnType<typeof proposeAccountFrame>> | undefined;
    const response: AccountInput = {
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedFrame.height,
      prevSignatures: [confirmationSig],
      counter: 0, // Will be set below after batching decision
    };

    console.log(`🔍 BATCH-CHECK for account ${input.fromEntityId.slice(-4)}: mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, mempoolTxs=[${accountMachine.mempool.map(tx => tx.type).join(',')}]`);
    if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
      console.log(`📦 BATCH-OPTIMIZATION: Sending ACK + new frame in single message (Channel.ts pattern)`);

      // Pass skipCounterIncrement=true since we'll increment for the whole batch below
      proposeResult = await proposeAccountFrame(env, accountMachine, true);

      if (proposeResult.success && proposeResult.accountInput) {
        batchedWithNewFrame = true;
        // Merge ACK and new proposal into same AccountInput
        if (proposeResult.accountInput.newAccountFrame) {
          response.newAccountFrame = proposeResult.accountInput.newAccountFrame;
        }
        if (proposeResult.accountInput.newSignatures) {
          response.newSignatures = proposeResult.accountInput.newSignatures;
        }

        const newFrameId = proposeResult.accountInput.newAccountFrame?.height || 0;
        console.log(`✅ Batched ACK for frame ${receivedFrame.height} + proposal for frame ${newFrameId}`);
        events.push(`📤 Batched ACK + frame ${newFrameId}`);
      }
    }

    // Increment counter ONCE per message (whether batched or not)
    response.counter = ++accountMachine.proofHeader.cooperativeNonce;
    console.log(`🔢 Message counter: ${response.counter} (batched=${batchedWithNewFrame})`);

    // Merge revealed secrets from BOTH incoming frame AND proposed frame
    const allRevealedSecrets = [
      ...revealedSecrets, // From incoming frame (line 493)
      ...(proposeResult?.revealedSecrets || []) // From our proposed frame (if batched)
    ];

    // Merge swap offers from BOTH incoming frame AND proposed frame
    const allSwapOffersCreated = [
      ...swapOffersCreated,
      ...(proposeResult?.swapOffersCreated || [])
    ];
    const allSwapOffersCancelled = [
      ...swapOffersCancelled,
      ...(proposeResult?.swapOffersCancelled || [])
    ];

    console.log(`🔍 RETURN-RESPONSE: h=${response.height} prevSigs=${!!response.prevSignatures} newFrame=${!!response.newAccountFrame}`);
    return { success: true, response, events, revealedSecrets: allRevealedSecrets, swapOffersCreated: allSwapOffersCreated, swapOffersCancelled: allSwapOffersCancelled, timedOutHashlocks };
  }

  console.log(`🔍 RETURN-NO-RESPONSE: No response object`);
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
  console.error(`   shouldProposeFrame: mempool=${accountMachine.mempool.length}, pending=${!!accountMachine.pendingFrame}, result=${should}`);
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
export async function generateAccountProof(accountMachine: AccountMachine): Promise<{
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

  // Generate hanko signature (like old_src does)
  const signature = signAccountFrame(accountMachine.proofHeader.fromEntity, `0x${proofHash}`);

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
