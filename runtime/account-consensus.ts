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

import { AccountMachine, AccountFrame, AccountTx, AccountInput, Env, EntityState } from './types';
import { cloneAccountMachine } from './state-helpers';
import { isLeft } from './account-utils';
import { signAccountFrame, verifyAccountSignature } from './account-crypto';
import { cryptoHash as hash } from './utils';
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

// === VALIDATION ===

/**
 * Validate account frame (frame-level validation)
 */
export function validateAccountFrame(frame: AccountFrame, currentTimestamp?: number): boolean {
  if (frame.height < 0) return false;
  if (frame.accountTxs.length > 100) return false;
  if (frame.tokenIds.length !== frame.deltas.length) return false;

  // Optional timestamp drift check (only if currentTimestamp provided)
  if (currentTimestamp !== undefined) {
    if (Math.abs(frame.timestamp - currentTimestamp) > MAX_FRAME_TIMESTAMP_DRIFT_MS) return false;
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
    prevFrameHash: frame.prevFrameHash, // Chain linkage
    accountTxs: frame.accountTxs.map(tx => ({
      type: tx.type,
      data: tx.data
    })),
    tokenIds: frame.tokenIds,
    deltas: frame.deltas.map(d => d.toString()), // Quick access sums
    // AUDIT FIX: Include FULL delta state (credit limits, allowances, collateral)
    fullDeltaStates: frame.fullDeltaStates?.map(delta => ({
      tokenId: delta.tokenId,
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      leftCreditLimit: delta.leftCreditLimit.toString(),
      rightCreditLimit: delta.rightCreditLimit.toString(),
      leftAllowance: delta.leftAllowance.toString(),
      rightAllowance: delta.rightAllowance.toString(),
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
  skipCounterIncrement: boolean = false
): Promise<{ success: boolean; accountInput?: AccountInput; events: string[]; error?: string }> {
  console.log(`🚀 E-MACHINE: Proposing account frame for ${accountMachine.counterpartyEntityId.slice(-4)}`);
  console.log(`🚀 E-MACHINE: Account state - mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}, currentHeight=${accountMachine.currentHeight}`);

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

  // Clone account machine for validation
  const clonedMachine = cloneAccountMachine(accountMachine);

  // Process all transactions on the clone
  const allEvents: string[] = [];
  for (const accountTx of accountMachine.mempool) {
    const result = processAccountTx(clonedMachine, accountTx, true); // Processing our own transactions

    if (!result.success) {
      return { success: false, error: `Tx validation failed: ${result.error}`, events: allEvents };
    }

    allEvents.push(...result.events);
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

    // Skip tokens with zero delta AND zero limits (never used)
    if (totalDelta === 0n && delta.leftCreditLimit === 0n && delta.rightCreditLimit === 0n) {
      console.log(`⏭️  Skipping unused token ${tokenId} from frame (zero delta, zero limits)`);
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

  // Create account frame matching the real AccountFrame interface
  const frameData = {
    height: accountMachine.currentHeight + 1,
    timestamp: env.timestamp, // DETERMINISTIC: Copy from runtime machine
    accountTxs: [...accountMachine.mempool],
    // CRITICAL: Use stored stateHash from currentFrame (set during commit)
    prevFrameHash: accountMachine.currentHeight === 0
      ? 'genesis'
      : accountMachine.currentFrame.stateHash || '',
    stateHash: '', // Will be filled after hash calculation
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
    logError("FRAME_CONSENSUS", `❌ Frame validation failed:`, error);
    logError("FRAME_CONSENSUS", `❌ Frame data:`, safeStringify(frameData, 2));
    return {
      success: false,
      error: `Frame validation failed: ${(error as Error).message}`,
      events,
    };
  }

  // Validate frame size (Bitcoin 1MB block limit)
  const frameSize = safeStringify(newFrame).length;
  if (frameSize > MAX_FRAME_SIZE_BYTES) {
    logError("FRAME_CONSENSUS", `❌ Frame too large: ${frameSize} bytes > ${MAX_FRAME_SIZE_BYTES} bytes (1MB)`);
    return {
      success: false,
      error: `Frame exceeds 1MB limit: ${frameSize} bytes`,
      events,
    };
  }
  console.log(`✅ Frame size: ${frameSize} bytes (${(frameSize / MAX_FRAME_SIZE_BYTES * 100).toFixed(2)}% of 1MB limit)`);

  // Generate signature
  const signature = signAccountFrame(accountMachine.proofHeader.fromEntity, newFrame.stateHash);

  // Set pending state
  accountMachine.pendingFrame = newFrame;
  accountMachine.sentTransitions = accountMachine.mempool.length;
  accountMachine.clonedForValidation = clonedMachine;

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

  return { success: true, accountInput, events };
}

/**
 * Handle received AccountInput (bilateral consensus)
 */
export async function handleAccountInput(
  env: Env,
  accountMachine: AccountMachine,
  input: AccountInput
): Promise<{ success: boolean; response?: AccountInput; events: string[]; error?: string; approvalNeeded?: AccountTx }> {
  console.log(`📨 A-MACHINE: Received AccountInput from ${input.fromEntityId.slice(-4)}`);

  const events: string[] = [];

  // CRITICAL: Counter validation (replay protection) - ALWAYS enforce, no frame 0 exemption
  if (input.counter !== undefined) {
    const counterValid = validateMessageCounter(accountMachine, input.counter);
    console.log(`🔍 Counter validation: ${input.counter} vs acked=${accountMachine.ackedTransitions}, height=${accountMachine.currentHeight}, valid=${counterValid}`);

    if (!counterValid) {
      return { success: false, error: `Replay attack detected: counter ${input.counter} invalid (expected ${accountMachine.ackedTransitions + 1})`, events };
    }

    // Update acked counter only after validation passes
    accountMachine.ackedTransitions = input.counter;
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
      // CRITICAL DEBUG: Log what we're committing
      console.log(`🔒 COMMIT: Frame ${accountMachine.pendingFrame.height}`);
      console.log(`  Transactions: ${accountMachine.pendingFrame.accountTxs.length}`);
      console.log(`  Transactions detail:`, accountMachine.pendingFrame.accountTxs);
      console.log(`  TokenIds: ${accountMachine.pendingFrame.tokenIds.join(',')}`);
      console.log(`  Deltas: ${accountMachine.pendingFrame.deltas.map(d => `${d}`).join(',')}`);
      console.log(`  StateHash: ${frameHash.slice(0,16)}...`);

      // Commit using cloned state
      if (accountMachine.clonedForValidation) {
        console.log(`🔓🔓🔓 PROPOSER-COMMIT STARTING FOR ENTITY ${accountMachine.proofHeader.fromEntity.slice(-4)} with counterparty ${accountMachine.counterpartyEntityId.slice(-4)}`);
        console.log(`🔓 clonedForValidation exists: ${!!accountMachine.clonedForValidation}`);
        console.log(`🔓 clonedForValidation.deltas.size: ${accountMachine.clonedForValidation.deltas.size}`);

        // BEFORE commit
        console.log(`📊 BEFORE COMMIT - accountMachine.deltas:`, Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
          tokenId,
          leftCreditLimit: delta.leftCreditLimit?.toString(),
          rightCreditLimit: delta.rightCreditLimit?.toString(),
        })));

        // BEFORE commit - clonedForValidation
        console.log(`📊 BEFORE COMMIT - clonedForValidation.deltas:`, Array.from(accountMachine.clonedForValidation.deltas.entries()).map(([tokenId, delta]) => ({
          tokenId,
          leftCreditLimit: delta.leftCreditLimit?.toString(),
          rightCreditLimit: delta.rightCreditLimit?.toString(),
        })));

        // CRITICAL FIX: Copy each delta individually to ensure proper mutation propagation
        // Direct Map assignment can fail with deep clones - explicit copy is safer
        accountMachine.deltas.clear();
        for (const [tokenId, delta] of accountMachine.clonedForValidation.deltas.entries()) {
          accountMachine.deltas.set(tokenId, { ...delta }); // Shallow copy of delta object
        }

        // AFTER commit
        console.log(`💳💳💳 PROPOSER-COMMIT COMPLETE: Deltas after commit for ${accountMachine.counterpartyEntityId.slice(-4)}:`,
          Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
            tokenId,
            collateral: delta.collateral?.toString(),
            leftCreditLimit: delta.leftCreditLimit?.toString(),
            rightCreditLimit: delta.rightCreditLimit?.toString(),
          })));

        accountMachine.currentFrame = {
          height: accountMachine.pendingFrame.height,
          timestamp: accountMachine.pendingFrame.timestamp,
          accountTxs: accountMachine.pendingFrame.accountTxs,
          prevFrameHash: accountMachine.pendingFrame.prevFrameHash,
          tokenIds: accountMachine.pendingFrame.tokenIds,
          deltas: accountMachine.pendingFrame.deltas,
          stateHash: accountMachine.pendingFrame.stateHash,
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

      events.push(`✅ Frame ${input.height} confirmed and committed`);

      // CRITICAL: Don't return yet! Check if they also sent a new frame in same message
      // Channel.ts pattern: ACK + new frame can be batched (line 576-612)
      if (!input.newAccountFrame) {
        return { success: true, events }; // Only ACK, no new frame
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

    if (!validateAccountFrame(receivedFrame)) {
      return { success: false, error: 'Invalid frame structure', events };
    }

    // CRITICAL: Verify prevFrameHash links to our current frame (prevent state fork)
    const expectedPrevFrameHash = accountMachine.currentHeight === 0
      ? 'genesis'
      : accountMachine.currentFrame.stateHash || '';

    if (receivedFrame.prevFrameHash !== expectedPrevFrameHash) {
      logError("FRAME_CONSENSUS", `❌ FRAME-CHAIN-BROKEN: prevFrameHash mismatch`);
      logError("FRAME_CONSENSUS", `  Expected: ${expectedPrevFrameHash.slice(0, 16)}...`);
      logError("FRAME_CONSENSUS", `  Received: ${receivedFrame.prevFrameHash.slice(0, 16)}...`);
      logError("FRAME_CONSENSUS", `  Current height: ${accountMachine.currentHeight}`);
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

      if (isLeftEntity) {
        // We are LEFT - ignore their frame, keep ours (deterministic tiebreaker)
        console.log(`📤 LEFT-WINS: Ignoring right's frame ${receivedFrame.height}, waiting for them to accept ours`);
        // This is NOT an error - it's correct consensus behavior (no response needed)
        return { success: true, events };
      } else {
        // We are RIGHT - rollback our frame, accept theirs
        if (accountMachine.rollbackCount === 0) {
          // First rollback - restore transactions to mempool before discarding frame
          if (accountMachine.pendingFrame) {
            console.log(`📥 RIGHT-ROLLBACK: Restoring ${accountMachine.pendingFrame.accountTxs.length} txs to mempool`);
            // CRITICAL: Re-add transactions to mempool (Channel.ts pattern)
            accountMachine.mempool.unshift(...accountMachine.pendingFrame.accountTxs);
            console.log(`📥 Mempool now has ${accountMachine.mempool.length} txs after rollback restore`);
          }

          accountMachine.sentTransitions = 0;
          delete accountMachine.pendingFrame;
          delete accountMachine.clonedForValidation;
          accountMachine.rollbackCount++;
          console.log(`📥 RIGHT-ROLLBACK: Accepting left's frame (rollbacks: ${accountMachine.rollbackCount})`);
          // Continue to process their frame below
        } else {
          // Should never rollback twice
          logError("FRAME_CONSENSUS", `❌ FATAL: Right side rolled back ${accountMachine.rollbackCount} times - consensus broken`);
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
    if (receivedFrame.height !== accountMachine.currentHeight + 1) {
      console.log(`❌ Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`);
      return { success: false, error: `Frame sequence mismatch: expected ${accountMachine.currentHeight + 1}, got ${receivedFrame.height}`, events };
    }

    // Verify signatures
    if (input.newSignatures && input.newSignatures.length > 0) {
      const signature = input.newSignatures[0];
      if (!signature) {
        return { success: false, error: 'Missing signature in newSignatures array', events };
      }
      const isValid = verifyAccountSignature(input.fromEntityId, receivedFrame.stateHash, signature);
      if (!isValid) {
        return { success: false, error: 'Invalid frame signature', events };
      }
    }

    // Apply frame transactions to clone (as receiver)
    const clonedMachine = cloneAccountMachine(accountMachine);
    const processEvents: string[] = [];

    for (const accountTx of receivedFrame.accountTxs) {
      // When receiving a frame, we process transactions from counterparty's perspective (incoming)
      const result = processAccountTx(clonedMachine, accountTx, false); // Processing their transactions = incoming
      if (!result.success) {
        return { success: false, error: `Frame application failed: ${result.error}`, events };
      }
      processEvents.push(...result.events);
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
      if (totalDelta === 0n && delta.leftCreditLimit === 0n && delta.rightCreditLimit === 0n) {
        console.log(`⏭️  RECEIVER: Skipping unused token ${tokenId} from validation (zero delta, zero limits)`);
        continue;
      }

      ourFinalTokenIds.push(tokenId);
      ourFinalDeltas.push(totalDelta);
    }

    console.log(`🔍 RECEIVER: Computed ${ourFinalTokenIds.length} tokens after filtering: [${ourFinalTokenIds.join(', ')}]`);

    const ourComputedState = Buffer.from(ourFinalDeltas.map(d => d.toString()).join(',')).toString('hex');
    const theirClaimedState = Buffer.from(receivedFrame.deltas.map(d => d.toString()).join(',')).toString('hex');

    console.log(`🔍 STATE-VERIFY Frame ${receivedFrame.height}:`);
    console.log(`  Our computed:  ${ourComputedState.slice(0, 32)}...`);
    console.log(`  Their claimed: ${theirClaimedState.slice(0, 32)}...`);

    if (ourComputedState !== theirClaimedState) {
      logError("FRAME_CONSENSUS", `❌ CONSENSUS-FAILURE: Both sides computed different final states!`);

      // DUMP EVERYTHING - FULL DATA STRUCTURES
      logError("FRAME_CONSENSUS", `❌ FULL CONSENSUS FAILURE DUMP:`);
      logError("FRAME_CONSENSUS", `❌ AccountMachine BEFORE:`, safeStringify(accountMachine));
      logError("FRAME_CONSENSUS", `❌ ClonedMachine AFTER:`, safeStringify(clonedMachine));
      logError("FRAME_CONSENSUS", `❌ ReceivedFrame COMPLETE:`, safeStringify(receivedFrame));
      logError("FRAME_CONSENSUS", `❌ OurComputedState:`, ourComputedState);
      logError("FRAME_CONSENSUS", `❌ TheirClaimedState:`, theirClaimedState);
      logError("FRAME_CONSENSUS", `❌ OurFinalDeltas:`, ourFinalDeltas.map(d => d.toString()));
      logError("FRAME_CONSENSUS", `❌ TheirFrameDeltas:`, receivedFrame.deltas.map(d => d.toString()));
      const isLeftEntity = isLeft(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
      logError("FRAME_CONSENSUS", `❌ isLeft=${isLeftEntity}, fromEntity=${accountMachine.proofHeader.fromEntity}, toEntity=${accountMachine.proofHeader.toEntity}`);

      return { success: false, error: `Bilateral consensus failure - states don't match`, events };
    }

    console.log(`✅ CONSENSUS-SUCCESS: Both sides computed identical state for frame ${receivedFrame.height}`);

    // Commit frame
    accountMachine.deltas = clonedMachine.deltas;

    // Log committed deltas for debugging credit limits
    console.log(`💳 COMMIT: Deltas after commit for ${accountMachine.counterpartyEntityId.slice(-4)}:`,
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
      accountTxs: receivedFrame.accountTxs,
      prevFrameHash: receivedFrame.prevFrameHash,
      tokenIds: receivedFrame.tokenIds,
      deltas: receivedFrame.deltas,
      stateHash: receivedFrame.stateHash,
    };
    accountMachine.currentHeight = receivedFrame.height;

    // Add accepted frame to history
    accountMachine.frameHistory.push({...receivedFrame});
    // Cap history at 10 frames to prevent snapshot bloat
    if (accountMachine.frameHistory.length > 10) {
      accountMachine.frameHistory.shift();
    }
    console.log(`📚 Frame ${receivedFrame.height} accepted and added to history (total: ${accountMachine.frameHistory.length})`);

    events.push(...processEvents);
    events.push(`🤝 Accepted frame ${receivedFrame.height} from Entity ${input.fromEntityId.slice(-4)}`);

    // Send confirmation (ACK)
    const confirmationSig = signAccountFrame(accountMachine.proofHeader.fromEntity, receivedFrame.stateHash);

    console.log(`📤 ACK-SEND: Preparing ACK for frame ${receivedFrame.height} from ${accountMachine.proofHeader.fromEntity.slice(-4)} to ${input.fromEntityId.slice(-4)}`);

    // CHANNEL.TS PATTERN (Lines 576-612): Batch ACK + new frame in same message!
    // Check if we should batch BEFORE incrementing counter
    let batchedWithNewFrame = false;
    const response: AccountInput = {
      fromEntityId: accountMachine.proofHeader.fromEntity,
      toEntityId: input.fromEntityId,
      height: receivedFrame.height,
      prevSignatures: [confirmationSig],
      counter: 0, // Will be set below after batching decision
    };

    // If we have mempool items, propose next frame immediately and batch with ACK
    if (accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
      console.log(`📦 BATCH-OPTIMIZATION: Sending ACK + new frame in single message (Channel.ts pattern)`);

      // Pass skipCounterIncrement=true since we'll increment for the whole batch below
      const proposeResult = await proposeAccountFrame(env, accountMachine, true);

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

    return { success: true, response, events };
  }

  return { success: true, events };
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

  for (const [counterpartyEntityId, accountMachine] of entityState.accounts) {
    if (shouldProposeFrame(accountMachine)) {
      accountsToProposeFrames.push(counterpartyEntityId);
    }
  }

  return accountsToProposeFrames;
}

// === PROOF GENERATION (for future J-Machine integration) ===

/**
 * Generate account proof for dispute resolution (like old_src Channel.getSubchannelProofs)
 * Must be ABI-compatible with Depository contract
 */
export async function generateAccountProof(accountMachine: AccountMachine): Promise<{ proofHash: string; signature: string }> {
  // Update proofBody with current state (like old_src does before signing)
  accountMachine.proofBody = {
    tokenIds: Array.from(accountMachine.deltas.keys()).sort((a, b) => a - b), // Deterministic order
    deltas: Array.from(accountMachine.deltas.keys())
      .sort((a, b) => a - b)
      .map(tokenId => {
        const delta = accountMachine.deltas.get(tokenId);
        if (!delta) {
          logError("FRAME_CONSENSUS", `❌ Missing delta for tokenId ${tokenId} in account ${accountMachine.counterpartyEntityId}`);
          throw new Error(`Critical financial data missing: delta for token ${tokenId}`);
        }
        return delta.ondelta + delta.offdelta; // Total delta for each token
      }),
  };

  // Create proof structure compatible with Depository.sol
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

  console.log(`🔐 Generated account proof: ${accountMachine.proofBody.tokenIds.length} tokens, hash: 0x${proofHash.slice(0, 20)}...`);
  console.log(`🔐 ProofBody tokens: [${accountMachine.proofBody.tokenIds.join(',')}]`);
  console.log(`🔐 ProofBody deltas: [${accountMachine.proofBody.deltas.map(d => d.toString()).join(',')}]`);

  return { proofHash: `0x${proofHash}`, signature };
}
