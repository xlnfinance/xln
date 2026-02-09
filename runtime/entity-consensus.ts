/**
 * XLN Entity Consensus and State Management
 * Core entity processing logic, consensus, proposals, and state transitions
 */

import { applyEntityTx } from './entity-tx';
import { isLeftEntity } from './entity-id-utils';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState, EntityTx, Env, HankoString, JInput, RoutedEntityInput } from './types';
import { isOk, isErr } from './types';
import type { AccountKey } from './ids';
import { DEBUG, HEAVY_LOGS, formatEntityDisplay, formatSignerDisplay, log } from './utils';
import { safeStringify } from './serialization-utils';
import { logDebug, logInfo, logWarn, logError } from './logger';

const L = 'ENTITY_CONSENSUS' as const;
import { addMessages, cloneEntityReplica, cloneEntityState, canonicalAccountKey, getAccountPerspective, emitScopedEvents } from './state-helpers';
import { LIMITS } from './constants';
import { signAccountFrame as signFrame, verifyAccountSignature as verifyFrame } from './account-crypto';
import { ethers } from 'ethers';

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY FRAME HASH - Cryptographic commitment to entity state
// ═══════════════════════════════════════════════════════════════════════════════
//
// Unlike A-machine frames (bilateral), E-machine frames need BFT consensus among
// entity signers. The hash must include:
// - prevFrameHash (chain linkage, replay protection)
// - height, timestamp (ordering)
// - txs (what changed)
// - key state fields (resulting state)
//
// Validators MUST recompute this hash locally and only sign if it matches.
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY PRINCIPLE: NEVER USE COUNTERPARTY-SUPPLIED STATE
// ═══════════════════════════════════════════════════════════════════════════════
//
// We ALWAYS compute our own state from transaction execution and use THAT.
// The proposer's claimed state is ONLY used for hash comparison/debugging.
//
// Why this matters:
// - Proposer could inject malicious state (inflated reserves, fake balances)
// - If validators blindly accept proposer's newState, they'd store poisoned data
// - This is a "state injection" attack vector
//
// Safe to use from proposedFrame (inputs/metadata):
//   - height, timestamp, txs, hash, prevFrameHash
// NEVER use directly (computed state - could be poisoned):
//   - newState (except for hash comparison)
//
// Implementation:
// - During PRECOMMIT: Store validator's computed state in workingReplica
// - During COMMIT: Use validator's stored state, not proposer's newState
// - Exception: Behind validators (catch-up) must trust quorum's committed state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create cryptographic hash for entity frame.
 * Both proposer and validators must compute identical hashes from identical state.
 */
export async function createEntityFrameHash(
  prevFrameHash: string,
  height: number,
  timestamp: number,
  txs: EntityTx[],
  newState: EntityState
): Promise<string> {
  // Build hashable state object
  const frameData = {
    prevFrameHash,
    height,
    timestamp,
    // Deterministic tx serialization
    txs: txs.map(tx => ({
      type: tx.type,
      data: tx.data
    })),
    // ═══════════════════════════════════════════════════════════════════════════
    // KEY STATE FIELDS (catch bugs early by including in hash)
    // ═══════════════════════════════════════════════════════════════════════════
    entityId: newState.entityId,
    // Reserves: sorted by tokenId for determinism
    reserves: Array.from(newState.reserves.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, v.toString()]),
    // J-machine tracking
    lastFinalizedJHeight: newState.lastFinalizedJHeight,
    // Account state: use A-machine frame hashes (not full state - too large)
    // Sorted by counterparty ID for determinism
    accountHashes: Array.from(newState.accounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cpId, acct]) => ({
        cpId,
        height: acct.currentHeight,
        stateHash: acct.currentFrame?.stateHash || 'genesis',
      })),
    // HTLC routing state hash
    htlcRoutesHash: newState.htlcRoutes.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.htlcRoutes.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
        )))
      : null,
    htlcFeesEarned: newState.htlcFeesEarned.toString(),
    // Lock/swap book hashes
    lockBookHash: newState.lockBook.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.lockBook.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
        )))
      : null,
    swapBookHash: newState.swapBook.size > 0
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(
          Array.from(newState.swapBook.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
        )))
      : null,
    // Orderbook extension hash (if hub)
    orderbookHash: newState.orderbookExt
      ? ethers.keccak256(ethers.toUtf8Bytes(safeStringify(newState.orderbookExt)))
      : null,
  };

  // keccak256 for EVM compatibility
  const encoded = safeStringify(frameData);
  return ethers.keccak256(ethers.toUtf8Bytes(encoded));
}

/**
 * Get previous frame hash from entity state.
 * Genesis if height=0, otherwise hash from last committed frame.
 */
function getPrevFrameHash(state: EntityState): string {
  if (state.height === 0) return 'genesis';
  // Store prevFrameHash in EntityState on commit (added below)
  return (state as any).prevFrameHash || 'genesis';
}

// === SECURITY VALIDATION ===

/**
 * Validates entity input to prevent malicious or corrupted data
 */
const validateEntityInput = (input: EntityInput): boolean => {
  try {
    // Basic required fields
    if (!input.entityId || typeof input.entityId !== 'string') {
      log.error(`❌ Invalid entityId: ${input.entityId}`);
      return false;
    }
    // EntityTx validation
    if (input.entityTxs) {
      if (!Array.isArray(input.entityTxs)) {
        log.error(`❌ EntityTxs must be array, got: ${typeof input.entityTxs}`);
        return false;
      }
      if (input.entityTxs.length > 1000) {
        log.error(`❌ Too many transactions: ${input.entityTxs.length} > 1000`);
        return false;
      }
      for (const tx of input.entityTxs) {
        if (!tx.type || !tx.data) {
          log.error(`❌ Invalid transaction: ${safeStringify(tx)}`);
          return false;
        }
        // Type system ensures tx.type is always a string literal
      }
    }

    // HashPrecommits validation (multi-hash signatures)
    if (input.hashPrecommits) {
      if (!(input.hashPrecommits instanceof Map)) {
        log.error(`❌ HashPrecommits must be Map, got: ${typeof input.hashPrecommits}`);
        return false;
      }
      if (input.hashPrecommits.size > 100) {
        log.error(`❌ Too many hashPrecommits: ${input.hashPrecommits.size} > 100`);
        return false;
      }
      for (const [signerId, sigs] of input.hashPrecommits) {
        if (typeof signerId !== 'string' || !Array.isArray(sigs)) {
          log.error(`❌ Invalid hashPrecommit format: ${signerId} -> ${typeof sigs}`);
          return false;
        }
      }
    }

    // ProposedFrame validation
    if (input.proposedFrame) {
      const frame = input.proposedFrame;
      if (typeof frame.height !== 'number' || frame.height < 0) {
        log.error(`❌ Invalid frame height: ${frame.height}`);
        return false;
      }
      if (!Array.isArray(frame.txs)) {
        log.error(`❌ Frame txs must be array`);
        return false;
      }
      if (!frame.hash || typeof frame.hash !== 'string') {
        log.error(`❌ Invalid frame hash: ${frame.hash}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    log.error(`❌ Input validation error: ${error}`);
    return false;
  }
};

/**
 * Validates entity replica to prevent corrupted state
 */
const validateEntityReplica = (replica: EntityReplica): boolean => {
  try {
    if (!replica.entityId || !replica.signerId) {
      log.error(`❌ Invalid replica IDs: ${replica.entityId}:${replica.signerId}`);
      return false;
    }
    if (replica.state.height < 0) {
      log.error(`❌ Invalid state height: ${replica.state.height}`);
      return false;
    }
    if (replica.mempool.length > LIMITS.MEMPOOL_SIZE) {
      log.error(`❌ Mempool overflow: ${replica.mempool.length} > ${LIMITS.MEMPOOL_SIZE}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Replica validation error: ${error}`);
    return false;
  }
};

/**
 * Detects Byzantine faults like double-signing
 */
const detectByzantineFault = (signatures: Map<string, string>, signerId: string, newSignature: string): boolean => {
  try {
    const existingSig = signatures.get(signerId);
    if (existingSig && existingSig !== newSignature) {
      log.error(`❌ BYZANTINE FAULT: Double-sign detected from ${signerId}`);
      log.error(`❌ Existing: ${existingSig}`);
      log.error(`❌ New: ${newSignature}`);
      return true;
    }
    return false;
  } catch (error) {
    log.error(`❌ Byzantine detection error: ${error}`);
    return false;
  }
};

/**
 * Validates voting power to prevent overflow attacks
 */
const validateVotingPower = (power: bigint): boolean => {
  try {
    if (power < 0n) {
      log.error(`❌ Negative voting power: ${power}`);
      return false;
    }
    // Check for overflow (2^53 - 1 in bigint)
    if (power > BigInt(Number.MAX_SAFE_INTEGER)) {
      log.error(`❌ Voting power overflow: ${power} > ${Number.MAX_SAFE_INTEGER}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Voting power validation error: ${error}`);
    return false;
  }
};

// === CORE ENTITY PROCESSING ===

/**
 * Main entity input processor - handles consensus, proposals, and state transitions
 */
export const applyEntityInput = async (
  env: Env,
  entityReplica: EntityReplica,
  entityInput: EntityInput,
): Promise<{ newState: EntityState, outputs: RoutedEntityInput[], jOutputs: JInput[], workingReplica: EntityReplica }> => {
  // IMMUTABILITY: Clone replica at function start (fintech-safe, hacker-proof)
  // Prevents state mutations from escaping function scope
  const workingReplica = cloneEntityReplica(entityReplica);

  logDebug(L, `INPUT: E#${formatEntityDisplay(entityInput.entityId)}:${formatSignerDisplay(workingReplica.signerId)} txs=${entityInput.entityTxs?.length || 0} precommits=${entityInput.hashPrecommits?.size || 0} frame=${entityInput.proposedFrame?.hash?.slice(0, 10) || '-'}`);

  // SECURITY: Validate all inputs
  if (!validateEntityInput(entityInput)) {
    log.error(`❌ Invalid input for ${entityInput.entityId}:${workingReplica.signerId}`);
    return { newState: workingReplica.state, outputs: [], jOutputs: [], workingReplica };
  }
  if (!validateEntityReplica(workingReplica)) {
    log.error(`❌ Invalid replica state for ${workingReplica.entityId}:${workingReplica.signerId}`);
    return { newState: workingReplica.state, outputs: [], jOutputs: [], workingReplica };
  }

  const entityOutbox: RoutedEntityInput[] = [];
  const jOutbox: JInput[] = []; // J-layer outputs

  // ⏰ Execute crontab tasks (periodic checks like account timeouts)
  const { executeCrontab, initCrontab } = await import('./entity-crontab');

  // Initialize crontab on first use
  if (!workingReplica.state.crontabState) {
    workingReplica.state.crontabState = initCrontab();
  }

  const hasManualBroadcast = Boolean(entityInput.entityTxs?.some(tx => tx.type === 'j_broadcast'));
  if (hasManualBroadcast) {
    const broadcastTask = workingReplica.state.crontabState.tasks.get('broadcastBatch');
    if (broadcastTask) {
      // Avoid auto-broadcast clobbering explicit j_broadcast in this tick.
      broadcastTask.lastRun = workingReplica.state.timestamp;
    }
  }

  const crontabOutputs = await executeCrontab(env, workingReplica, workingReplica.state.crontabState);
  if (crontabOutputs.length > 0) {
    entityOutbox.push(...crontabOutputs);
  }

  // Add transactions to mempool
  if (entityInput.entityTxs?.length) {
    workingReplica.mempool.push(...entityInput.entityTxs);
    if (HEAVY_LOGS) logDebug(L, `Mempool +${entityInput.entityTxs.length} → ${workingReplica.mempool.length} types=[${entityInput.entityTxs.map(tx => tx.type)}]`);
  }

  // CRITICAL: Forward transactions to proposer BEFORE processing commits
  // This prevents race condition where commits clear mempool before forwarding
  if (!workingReplica.isProposer && workingReplica.mempool.length > 0) {
    // Send mempool to proposer
    const proposerId = workingReplica.state.config.validators[0];
    if (!proposerId) {
      logError(L, `❌ No proposer found in validators: ${workingReplica.state.config.validators}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }

    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...workingReplica.mempool],
    });
  }

  // Handle commit notifications AFTER forwarding (when receiving finalized frame from proposer)
  // Proposer sends proposedFrame with collectedSigs attached after threshold reached
  const frameCollectedSigs = entityInput.proposedFrame?.collectedSigs;
  if (frameCollectedSigs?.size && entityInput.proposedFrame && !workingReplica.proposal) {
    const signers = Array.from(frameCollectedSigs.keys());
    const totalPower = calculateQuorumPower(workingReplica.state.config, signers);

    if (totalPower >= workingReplica.state.config.threshold) {
      // This is a commit notification from proposer, apply the frame

      // SECURITY: Validate commit matches our locked frame (if we have one)
      if (workingReplica.lockedFrame) {
        if (workingReplica.lockedFrame.hash !== entityInput.proposedFrame.hash) {
          logError(L, `❌ BYZANTINE: Commit frame doesn't match locked frame!`);
          logError(L, `   Locked: ${workingReplica.lockedFrame.hash}`);
          logError(L, `   Commit: ${entityInput.proposedFrame.hash}`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }
        logDebug(L, `Commit validation: matches locked frame ${workingReplica.lockedFrame.hash.slice(0,10)}`);
      }

      // SECURITY: Verify first signature (entityFrame hash) from each signer
      for (const [signerId, sigs] of frameCollectedSigs) {
        if (!sigs[0] || !verifyFrame(env, signerId, entityInput.proposedFrame.hash, sigs[0])) {
          logError(L, `❌ BYZANTINE: Invalid signature from ${signerId}`);
          logError(L, `   Frame hash: ${entityInput.proposedFrame.hash.slice(0,30)}...`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
        }
      }
      logDebug(L, `All ${frameCollectedSigs.size} signatures validated for frame ${entityInput.proposedFrame.hash.slice(0,10)}`);

      // Emit frame commit event
      env.emit('EntityFrameCommitted', {
        entityId: entityInput.entityId,
        signerId: workingReplica.signerId,
        height: workingReplica.state.height + 1,
        frameHash: entityInput.proposedFrame.hash,
        txCount: entityInput.proposedFrame.txs.length,
        signatures: frameCollectedSigs.size,
      });

      // Apply the committed frame
      // CATCH-UP FIX: Use proposedFrame.height (not +1 from local) to handle offline validators
      // If validator missed frames (was offline), this brings it to the correct height
      //
      // SECURITY: Use OUR computed state (stored during precommit), NOT proposer's claimed state
      // Exception: Behind validators (catch-up) must trust the committed state since they
      // couldn't verify - this is safe because up-to-date validators provided the quorum
      const stateToApply = workingReplica.validatorComputedState || entityInput.proposedFrame.newState;
      if (!workingReplica.validatorComputedState) {
        logWarn(L, `CATCH-UP: Using proposer's state (validator was behind and couldn't verify)`);
      }
      workingReplica.state = {
        ...stateToApply,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId
        height: entityInput.proposedFrame.height,
        prevFrameHash: entityInput.proposedFrame.hash, // Chain linkage for BFT
      } as EntityState;

      // CHANNEL.TS PATTERN: Clear only the committed txs, keep any new txs
      // This avoids dropping fresh inputs merged into the same tick (e.g., accountInput ACKs).
      const committedTxCount = entityInput.proposedFrame.txs.length;
      if (committedTxCount > 0) {
        logDebug(L, `Clearing ${committedTxCount} committed txs from mempool (${workingReplica.mempool.length} total)`);
        workingReplica.mempool.splice(0, committedTxCount);
        logDebug(L, `Mempool after commit: ${workingReplica.mempool.length} txs remaining`);
      }

      delete workingReplica.lockedFrame; // Release lock after commit
      delete workingReplica.validatorComputedState; // Clear computed state after commit
      if (HEAVY_LOGS)
        logDebug(L, `Applied commit: ${workingReplica.state.messages.length} messages, height: ${workingReplica.state.height}`);

      // Return early - commit notifications don't trigger further processing
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }
  }

  // Handle proposed frame (PROPOSE phase) - only if not a commit notification
  if (
    entityInput.proposedFrame &&
    (!workingReplica.proposal || (workingReplica.state.config.mode === 'gossip-based' && workingReplica.isProposer))
  ) {
    const config = workingReplica.state.config;
    const proposedFrame = entityInput.proposedFrame;

    // ═══════════════════════════════════════════════════════════════════════════
    // CATCH-UP: Skip verification if validator missed previous entity frames
    // BFT: Up-to-date validators provide quorum; behind validator syncs via commit
    // notification which transfers full proposer state (including account state)
    // ═══════════════════════════════════════════════════════════════════════════
    const expectedPrevHeight = proposedFrame.height - 1;
    const canVerify = workingReplica.state.height >= expectedPrevHeight;
    if (!canVerify) {
      logWarn(L, `CATCH-UP: Validator ${workingReplica.signerId} behind (h=${workingReplica.state.height}, need h=${expectedPrevHeight}). Will sync on commit.`);
    }

    if (canVerify) {
    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATOR HASH VERIFICATION (BFT hardening)
    // ═══════════════════════════════════════════════════════════════════════════
    // Apply txs locally, compute expected hash, reject if mismatch
    // DETERMINISM: verifyOnly=true skips account frame proposals (timestamp-dependent side effects)
    // DETERMINISM: Pass proposedFrame.newState.timestamp so validator uses same timestamp as proposer
    const { newState: validatorComputedState } = await applyEntityFrame(env, workingReplica.state, proposedFrame.txs, true, proposedFrame.newState.timestamp);
    const validatorNewState = {
      ...validatorComputedState,
      entityId: workingReplica.state.entityId,
      height: proposedFrame.height,
      timestamp: proposedFrame.newState.timestamp,
    };

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const validatorComputedHash = await createEntityFrameHash(
      prevFrameHash,
      proposedFrame.height,
      proposedFrame.newState.timestamp,
      proposedFrame.txs,
      validatorNewState
    );

    // SECURITY: Reject if hash mismatch (proposer sent different state than txs produce)
    if (validatorComputedHash !== proposedFrame.hash) {
      logError(L, `❌ HASH MISMATCH: Proposer sent invalid frame hash!`);
      logError(L, `   Expected: ${validatorComputedHash.slice(0, 30)}...`);
      logError(L, `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
      logError(L, `   This could indicate equivocation attack or state divergence bug.`);
      // Don't sign, don't lock - reject the proposal
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }

    logDebug(L, `Validator hash verified: ${proposedFrame.hash.slice(0, 20)}...`);

    // Sign ALL hashes in proposal (entity frame + account frames + disputes)
    const hashesToSign = proposedFrame.hashesToSign || [{ hash: proposedFrame.hash, type: 'entityFrame' as const, context: '' }];
    const allSignatures = await Promise.all(
      hashesToSign.map(h => signFrame(env, workingReplica.signerId, h.hash))
    );
    logDebug(L, `Validator signed ${allSignatures.length} hashes for entity consensus`);

    // Lock to this frame (CometBFT style)
    workingReplica.lockedFrame = proposedFrame;

    // SECURITY: Store OUR computed state (not proposer's) for use at commit time
    // This prevents state injection attacks where proposer sends poisoned newState
    workingReplica.validatorComputedState = validatorNewState;

    if (config.mode === 'gossip-based') {
      // Send precommit to all validators
      config.validators.forEach(validatorId => {
        if (HEAVY_LOGS) logDebug(L, `GOSSIP: ${workingReplica.signerId} sending hashPrecommits to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, sigs: ${allSignatures.length}`);
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          hashPrecommits: new Map([[workingReplica.signerId, allSignatures]]),
        });
      });
    } else {
      // Send precommit to proposer only
      const proposerId = config.validators[0];
      if (!proposerId) {
        logError(L, `❌ No proposer found in validators: ${config.validators}`);
        return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
      }
      if (HEAVY_LOGS) logDebug(L, `PROPOSER: ${workingReplica.signerId} sending hashPrecommits to ${proposerId} for entity ${entityInput.entityId.slice(0, 10)}, sigs: ${allSignatures.length}`);
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: proposerId,
        hashPrecommits: new Map([[workingReplica.signerId, allSignatures]]),
      });
    }
    } // end if (canVerify) — behind validators skip verification and wait for commit
  }

  // Handle hashPrecommits (multi-hash signatures from validators)
  const hasHashPrecommits = entityInput.hashPrecommits?.size && workingReplica.proposal;
  if (hasHashPrecommits && workingReplica.proposal) {
    const proposal = workingReplica.proposal;

    for (const [signerId, sigs] of entityInput.hashPrecommits!) {
      // Verify signature count matches hashesToSign
      if (proposal.hashesToSign && sigs.length !== proposal.hashesToSign.length) {
        log.error(`❌ Signature count mismatch from ${signerId}: got ${sigs.length}, expected ${proposal.hashesToSign.length}`);
        continue;
      }
      // SECURITY: Verify frame hash signature (sigs[0]) before accepting precommit
      // Prevents Byzantine validator from submitting garbage that wastes the entity frame
      const firstHashToSign = proposal.hashesToSign?.[0];
      if (proposal.hashesToSign && sigs[0] && firstHashToSign) {
        const { verifyAccountSignature } = await import('./account-crypto');
        const frameHashSig = sigs[0];
        const frameHash = firstHashToSign.hash;
        if (!verifyAccountSignature(env, signerId, frameHash, frameHashSig)) {
          log.error(`❌ PRECOMMIT REJECTED: Invalid frame hash signature from ${signerId}`);
          continue;
        }
      }
      if (!proposal.collectedSigs) {
        proposal.collectedSigs = new Map();
      }
      proposal.collectedSigs.set(signerId, sigs);
    }
    logDebug(L, `Collected hashPrecommits from ${entityInput.hashPrecommits!.size} validators (total: ${proposal.collectedSigs?.size || 0})`);

    // Check threshold using collectedSigs (validators who signed ALL hashes)
    const signers = Array.from(proposal.collectedSigs?.keys() || []);
    const totalPower = calculateQuorumPower(workingReplica.state.config, signers);

    // SECURITY: Validate voting power
    if (!validateVotingPower(totalPower)) {
      log.error(`❌ Invalid voting power calculation: ${totalPower}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
    }

    if (DEBUG) {
      const totalShares = Object.values(workingReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalPower) / Number(workingReplica.state.config.threshold)) * 100).toFixed(1);
      log.info(
        `    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(workingReplica.state.config.threshold) ? '+' : ''}]`,
      );
      if (workingReplica.state.config.mode === 'gossip-based') {
        logDebug(L, `Gossip mode - all validators receive precommits`);
      }
    }

    if (totalPower >= workingReplica.state.config.threshold) {
      // ═══════════════════════════════════════════════════════════════════════════
      // COMMIT PHASE - Entity consensus reached, now finalize hankos and outputs
      // ═══════════════════════════════════════════════════════════════════════════
      logInfo(L, `ENTITY-COMMIT: Threshold reached, merging signatures into hankos`);

      // Step 1: Merge collected signatures into quorum hankos
      const committedHankos: HankoString[] = [];
      if (proposal.hashesToSign && proposal.collectedSigs) {
        const { buildQuorumHanko } = await import('./hanko-signing');
        for (let i = 0; i < proposal.hashesToSign.length; i++) {
          const hashInfo = proposal.hashesToSign[i];
          if (!hashInfo) continue; // Skip if undefined (shouldn't happen)
          // Collect all validator signatures for this hash
          const sigsForHash: Array<{ signerId: string; signature: string }> = [];
          for (const [signerId, sigs] of proposal.collectedSigs) {
            const sig = sigs[i];
            if (sig) {
              sigsForHash.push({ signerId, signature: sig });
            }
          }
          // Build quorum hanko from collected signatures
          const hanko = await buildQuorumHanko(
            env,
            workingReplica.state.entityId,
            hashInfo.hash,
            sigsForHash,
            workingReplica.state.config
          );
          committedHankos.push(hanko);
        }
        logDebug(L, `ENTITY-COMMIT: Built ${committedHankos.length} quorum hankos from ${proposal.collectedSigs.size} validators`);
      }

      // Step 2: Store hankos in hankoWitness (NOT part of state hash)
      // Map hash -> {hanko, type, entityHeight, createdAt}
      if (!workingReplica.hankoWitness) {
        workingReplica.hankoWitness = new Map();
      }
      if (proposal.hashesToSign) {
        for (let i = 0; i < proposal.hashesToSign.length; i++) {
          const hashInfo = proposal.hashesToSign[i];
          const hanko = committedHankos[i];
          if (hashInfo && hanko) {
            workingReplica.hankoWitness.set(hashInfo.hash, {
              hanko,
              type: hashInfo.type as 'accountFrame' | 'dispute' | 'settlement' | 'profile' | 'jBatch',
              entityHeight: workingReplica.state.height + 1,
              createdAt: env.timestamp,
            });
          }
        }
      }

      // Step 3: Use stored outputs from proposal (NOT re-applied)
      // CRITICAL: Cannot re-apply frame because proposal.newState already has mutations.
      // Idempotent handlers (e.g., openAccount) would return empty outputs on re-application.
      const commitOutputs = proposal.outputs || [];
      const commitJOutputs = proposal.jOutputs || [];

      // Step 3b: Attach quorum hankos to AccountInput outputs
      // Covers: account frames, dispute proofs, settlements
      let attachedCount = 0;
      for (const output of commitOutputs) {
        if (!output.entityTxs) continue;
        for (const tx of output.entityTxs) {
          if (tx.type === 'accountInput' && tx.data) {
            const accountInput = tx.data as import('./types').AccountInput;
            // Attach quorum hankos based on AccountInput variant
            if (accountInput.type === 'proposal' || accountInput.type === 'ack') {
              // Attach quorum hanko for new account frame
              if (accountInput.newAccountFrame?.stateHash) {
                const frameHankoEntry = workingReplica.hankoWitness?.get(accountInput.newAccountFrame.stateHash);
                if (frameHankoEntry) {
                  (accountInput as any).newHanko = frameHankoEntry.hanko;
                  attachedCount++;
                  if (HEAVY_LOGS) logDebug(L, `ATTACH-HANKO: frame for ${accountInput.toEntityId?.slice(-4)}`);
                }
              }
              // Attach quorum hanko for dispute proof (replaces single-signer hanko)
              if (accountInput.newDisputeHash) {
                const disputeHankoEntry = workingReplica.hankoWitness?.get(accountInput.newDisputeHash);
                if (disputeHankoEntry) {
                  (accountInput as any).newDisputeHanko = disputeHankoEntry.hanko;
                  attachedCount++;
                  if (HEAVY_LOGS) logDebug(L, `ATTACH-HANKO: dispute for ${accountInput.toEntityId?.slice(-4)}`);
                }
              }
            }
            // Attach quorum hanko for settlement approval (find by type in hankoWitness)
            if (accountInput.type === 'settlement' && accountInput.settleAction.type === 'approve' && accountInput.settleAction.hanko) {
              for (const [witnessHash, entry] of workingReplica.hankoWitness || []) {
                if (entry.type === 'settlement' && entry.entityHeight === (workingReplica.state.height + 1)) {
                  accountInput.settleAction.hanko = entry.hanko;
                  attachedCount++;
                  if (HEAVY_LOGS) logDebug(L, `ATTACH-HANKO: settlement for ${accountInput.toEntityId?.slice(-4)}`);
                  break;
                }
              }
            }
          }
        }
      }

      entityOutbox.push(...commitOutputs);
      jOutbox.push(...commitJOutputs);
      logDebug(L, `ENTITY-COMMIT: ${commitOutputs.length} stored outputs, attached ${attachedCount} hankos`);

      // Step 4: Update state with incremented height + chain linkage
      // SECURITY NOTE: For PROPOSER, proposal.newState IS our own computed state
      // (we created it in applyEntityFrame). This is safe - no state injection risk.
      // The state injection protection is for validators receiving commits (see above).
      workingReplica.state = {
        ...proposal.newState,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId
        height: proposal.height,
        prevFrameHash: proposal.hash, // Chain linkage for BFT
      };

      // Save proposal data before clearing
      const committedFrame = proposal;
      committedFrame.hankos = committedHankos;

      // Clear only committed txs; keep any new txs merged into this tick
      const committedTxCount = committedFrame.txs.length;
      if (committedTxCount > 0) {
        workingReplica.mempool.splice(0, committedTxCount);
      }
      delete workingReplica.proposal;
      delete workingReplica.lockedFrame;

      // Send commit notifications in proposer-based mode
      if (workingReplica.state.config.mode === 'proposer-based') {
        const committedProposalHash = committedFrame.hash.slice(0, 10);
        const signerCount = committedFrame.collectedSigs?.size || 0;
        logDebug(L, `COMMIT-START: ${workingReplica.signerId} reached threshold for proposal ${committedProposalHash}, sending commit notifications`);

        // Notify all validators (except self)
        workingReplica.state.config.validators.forEach(validatorId => {
          if (validatorId !== workingReplica.signerId) {
            if (HEAVY_LOGS) logDebug(L, `COMMIT: sending commit notification to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${committedProposalHash} (${signerCount} precommits)`);
            entityOutbox.push({
              entityId: entityInput.entityId,
              signerId: validatorId,
              proposedFrame: committedFrame, // Contains collectedSigs + hankos
            });
          }
        });
      } else {
        if (HEAVY_LOGS) logDebug(L, `GOSSIP-COMMIT: ${workingReplica.signerId} NOT sending commit notifications (gossip mode) for entity ${entityInput.entityId.slice(0, 10)}`);
      }
    }
  }

  // Commit notifications are now handled at the top of the function

  if (HEAVY_LOGS) logDebug(L, `CONSENSUS-CHECK: ${workingReplica.entityId}:${workingReplica.signerId} proposer=${workingReplica.isProposer} mempool=${workingReplica.mempool.length} proposal=${!!workingReplica.proposal}`);

  // Auto-propose logic: ONLY proposer can propose (BFT requirement)
  if (workingReplica.isProposer && workingReplica.mempool.length > 0 && !workingReplica.proposal) {
    logDebug(L, `Auto-propose triggered: mempool=${workingReplica.mempool.length} types=[${workingReplica.mempool.map(tx => tx.type)}]`);

    // Check if this is a single signer entity (threshold = 1, only 1 validator)
    const isSingleSigner =
      workingReplica.state.config.validators.length === 1 && workingReplica.state.config.threshold === BigInt(1);

    if (isSingleSigner) {
      logDebug(L, `SINGLE-SIGNER: Direct execution without consensus`);
      // For single signer entities, directly apply transactions without consensus
      // DETERMINISM: Proposer passes env.timestamp (their local time when creating the frame)
      const { newState: newEntityState, outputs: frameOutputs, jOutputs: frameJOutputs } = await applyEntityFrame(env, workingReplica.state, workingReplica.mempool, false, env.timestamp);
      const newHeight = workingReplica.state.height + 1;
      const newTimestamp = env.timestamp;

      // Compute frame hash for chain linkage (even single-signer needs deterministic state tracking)
      const prevFrameHash = getPrevFrameHash(workingReplica.state);
      const singleSignerNewState = {
        ...newEntityState,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId
        height: newHeight,
        timestamp: newTimestamp,
      };
      const singleSignerFrameHash = await createEntityFrameHash(
        prevFrameHash,
        newHeight,
        newTimestamp,
        workingReplica.mempool,
        singleSignerNewState
      );

      workingReplica.state = {
        ...singleSignerNewState,
        prevFrameHash: singleSignerFrameHash, // Chain linkage
      };

      // Add any outputs generated by entity transactions to the outbox
      entityOutbox.push(...frameOutputs);
      jOutbox.push(...frameJOutputs); // CRITICAL: Collect J-outputs!

      // Clear mempool after direct application
      workingReplica.mempool.length = 0;

      if (HEAVY_LOGS) logDebug(L, `Single-signer applied: height=${workingReplica.state.height} outbox=${entityOutbox.length} jOutbox=${jOutbox.length}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica }; // Skip the full consensus process
    }

    if (HEAVY_LOGS) logDebug(L, `Auto-propose: mempool=${workingReplica.mempool.length} isProposer=${workingReplica.isProposer}`);
    // Compute new state once during proposal (outputs stored for commit-time hanko attachment)
    // DETERMINISM: Proposer passes env.timestamp (their local time when creating the frame)
    const { newState: newEntityState, deterministicState: proposerDeterministicState, outputs: proposalOutputs, jOutputs: proposalJOutputs, collectedHashes } = await applyEntityFrame(env, workingReplica.state, workingReplica.mempool, false, env.timestamp);

    // CRITICAL: proposalOutputs are stored in the proposal, NOT pushed to entityOutbox yet.
    // At commit time, we use these stored outputs and attach hankos.
    // We CANNOT re-apply the frame at commit because proposal.newState already has
    // mutations applied (e.g., openAccount creates account). Idempotent handlers
    // would return empty outputs on re-application.

    // Proposer creates new timestamp for this frame (DETERMINISTIC: use runtime timestamp)
    const newTimestamp = env.timestamp;
    const newHeight = workingReplica.state.height + 1;

    // Build proposed new state (full state with account proposals — for commit)
    const proposedNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId in proposal
      height: newHeight,
      timestamp: newTimestamp,
    };

    // Build deterministic state for hashing (before account proposals — matches validator)
    const deterministicForHash = {
      ...proposerDeterministicState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // CRYPTOGRAPHIC FRAME HASH (replaces weak placeholder)
    // ═══════════════════════════════════════════════════════════════════════════
    // Hash from deterministicState (before account proposals) so validators can verify
    // Validators apply txs with verifyOnly=true → get same deterministicState → same hash
    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const frameHash = await createEntityFrameHash(
      prevFrameHash,
      newHeight,
      newTimestamp,
      workingReplica.mempool,
      deterministicForHash
    );
    const selfSignature = signFrame(env, workingReplica.signerId, frameHash);

    // Collect all hashes that need signing (entity frame hash FIRST + account/dispute hashes with types)
    // CRITICAL: entityFrame hash must stay at index 0 for legacy compatibility (signatures map uses sigs[0])
    const entityFrameHashToSign: import('./types').HashToSign = {
      hash: frameHash,
      type: 'entityFrame',
      context: `entity:${workingReplica.state.entityId.slice(-4)}:frame:${newHeight}`,
    };

    // Dedupe and sort additional hashes (preserve type info)
    const seenHashes = new Set<string>([frameHash]);
    const additionalHashesToSign: import('./types').HashToSign[] = [];
    if (collectedHashes) {
      for (const h of collectedHashes) {
        if (!seenHashes.has(h.hash)) {
          seenHashes.add(h.hash);
          additionalHashesToSign.push({
            hash: h.hash,
            type: h.type as import('./types').HashType,
            context: h.context,
          });
        }
      }
      // Sort additional hashes by hash value for determinism
      additionalHashesToSign.sort((a, b) => a.hash.localeCompare(b.hash));
    }

    const hashesToSign: import('./types').HashToSign[] = [entityFrameHashToSign, ...additionalHashesToSign];

    // Sign ALL hashes (not just frame hash)
    const selfSigs = await Promise.all(
      hashesToSign.map(h => signFrame(env, workingReplica.signerId, h.hash))
    );

    workingReplica.proposal = {
      height: newHeight,
      txs: [...workingReplica.mempool],
      hash: frameHash,
      newState: proposedNewState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      hashesToSign,
      collectedSigs: new Map([[workingReplica.signerId, selfSigs]]),
    };

    if (HEAVY_LOGS) logDebug(L, `Auto-proposing frame ${workingReplica.proposal.hash.slice(0, 20)}... with ${workingReplica.proposal.txs.length} txs`);

    // Send proposal to all validators (except self)
    workingReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== workingReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: workingReplica.proposal!,
          // Note: Don't send entityTxs separately - they're already in proposedFrame.txs
        });
      }
    });
  } else if (workingReplica.isProposer && workingReplica.mempool.length === 0 && !workingReplica.proposal) {
    // DEBUG removed: ⚠️  CORNER CASE: Proposer with empty mempool - no auto-propose`);
  } else if (workingReplica.isProposer && workingReplica.proposal) {
    // DEBUG removed: ⚠️  CORNER CASE: Proposer already has pending proposal - no new auto-propose`);
  }

  if (HEAVY_LOGS) {
    logDebug(L, `OUTPUT: ${entityOutbox.length} outputs, proposal=${workingReplica.proposal?.hash?.slice(0, 10) || 'none'}, mempool=${workingReplica.mempool.length}`);
    entityOutbox.forEach((output, index) => {
      const outputFrameHash = output.proposedFrame?.hash?.slice(0, 10) || 'none';
      const hashPrecommitCount = output.hashPrecommits?.size || 0;
      logDebug(L, `OUTPUT-${index + 1}: To ${formatEntityDisplay(output.entityId)}:${formatSignerDisplay(output.signerId || '')} txs=${output.entityTxs?.length || 0} precommits=${hashPrecommitCount} frame=${outputFrameHash}`);
    });
  }

  return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox, workingReplica };
};

export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
  // DETERMINISM: Validators must NOT propose account frames during verification.
  // Account frame proposals use env.timestamp which differs per-tick, causing
  // non-deterministic stateHash and entity frame hash mismatch.
  // Only the proposer (verifyOnly=false) proposes account frames.
  verifyOnly: boolean = false,
  // DETERMINISM: Validators pass proposedFrame.newState.timestamp to match proposer's lockIds/timelocks.
  // Proposers pass env.timestamp (their local time when creating the frame).
  frameTimestamp?: number,
): Promise<{
  newState: EntityState;
  // State snapshot BEFORE account proposals (deterministic across proposer + validators)
  // Proposer must hash from this state to match validator verification
  deterministicState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  // Hashes emitted during frame processing that need entity-quorum signing
  collectedHashes?: Array<{ hash: string; type: 'accountFrame' | 'dispute' | 'profile' | 'settlement'; context: string }>;
}> => {
  if (HEAVY_LOGS) logDebug(L, `APPLY-ENTITY-FRAME: ${entityTxs.length} txs types=[${entityTxs.map(tx => tx.type)}]`);

  // CRITICAL: Clone state to avoid mutating the input (determinism fix)
  // Without this, proposer and validator can end up with different states
  let currentEntityState = cloneEntityState(entityState);

  // FIX: Set frame timestamp BEFORE running handlers (not after)
  // Without this, HTLC timelocks use stale timestamp (1-frame lag)
  // Handlers need current frame timestamp for correct timelock calculations
  // DETERMINISM: Use provided frameTimestamp (validator uses proposer's timestamp), fallback to env.timestamp
  currentEntityState.timestamp = frameTimestamp ?? env.timestamp;
  const allOutputs: EntityInput[] = [];
  const allJOutputs: JInput[] = []; // Collect J-outputs

  // Track accounts that need frame proposals during this processing round
  const proposableAccounts = new Set<string>();

  // === AGGREGATE PURE EVENTS FROM ALL HANDLERS ===
  const allMempoolOps: Array<{ accountId: string; tx: any }> = [];
  const allSwapOffersCreated: Array<any> = [];
  const allSwapOffersCancelled: Array<any> = [];

  for (const entityTx of entityTxs) {
    const { newState, outputs, jOutputs, mempoolOps, swapOffersCreated, swapOffersCancelled } = await applyEntityTx(env, currentEntityState, entityTx);
    currentEntityState = newState;

    // DEBUG: Check account mempools IMMEDIATELY after entityTx
    if (entityTx.type === 'j_event') {
      for (const [cpId, acct] of currentEntityState.accounts) {
        if (acct.mempool.length > 0) {
          if (HEAVY_LOGS) logDebug(L, `AFTER-ENTITY-TX(j_event): Account ${cpId.slice(-4)} mempool=[${acct.mempool.map((tx: any) => tx.type)}]`);
        }
      }
    }

    allOutputs.push(...outputs);
    if (jOutputs) allJOutputs.push(...jOutputs);

    // CRITICAL FIX: Apply mempoolOps IMMEDIATELY instead of batching
    // This ensures directPayment can detect newly-added mempool items in the same tick
    if (mempoolOps && mempoolOps.length > 0) {
      if (HEAVY_LOGS) logDebug(L, `ENTITY-ORCHESTRATOR: Applying ${mempoolOps.length} mempoolOps (inline)`);
      for (const { accountId, tx } of mempoolOps) {
        const account = currentEntityState.accounts.get(accountId as AccountKey);
        if (account) {
          account.mempool.push(tx);
          proposableAccounts.add(accountId);
          if (HEAVY_LOGS) logDebug(L, `mempoolOp: ${accountId.slice(-8)}: ${tx.type} (mempool=${account.mempool.length})`);
        } else {
          logWarn(L, `Account ${accountId.slice(-8)} not found for mempoolOp`);
        }
      }
    }

    if (swapOffersCreated) allSwapOffersCreated.push(...swapOffersCreated);
    if (swapOffersCancelled) allSwapOffersCancelled.push(...swapOffersCancelled);

    if (entityTx.type === 'extendCredit' && HEAVY_LOGS) {
      for (const [cpId, acctMachine] of currentEntityState.accounts) {
        logDebug(L, `POST-EXTEND-CREDIT: ${cpId.slice(0,10)} mempool=${acctMachine.mempool.length} pending=${!!acctMachine.proposal} height=${acctMachine.currentHeight}`);
      }
    }

    // Track which accounts need proposals based on transaction type
    if (entityTx.type === 'accountInput' && entityTx.data) {
      const fromEntity = entityTx.data.fromEntityId;
      // Account keyed by counterparty ID (fromEntity is our counterparty)
      const accountMachine = currentEntityState.accounts.get(fromEntity as AccountKey);

      if (accountMachine) {
        // Add to proposable if:
        // - We have pending mempool items and no pending frame
        const isAck = entityTx.data.type === 'ack';
        const hasPendingTxs = accountMachine.mempool.length > 0;

        // Only propose if we have something to send:
        // - Have transactions in mempool
        if (hasPendingTxs && !accountMachine.proposal) {
          proposableAccounts.add(fromEntity); // counterparty ID
          if (HEAVY_LOGS) logDebug(L, `Added ${fromEntity.slice(0,10)} to proposable - Pending:${hasPendingTxs}`);
        } else if (isAck) {
          if (HEAVY_LOGS) logDebug(L, `Received ACK from ${fromEntity.slice(0,10)}, no action needed (mempool empty)`);
        }
      }
    } else if (entityTx.type === 'directPayment' && entityTx.data) {
      if (HEAVY_LOGS) logDebug(L, `DIRECT-PAYMENT: target=${entityTx.data.targetEntityId} amount=${entityTx.data.amount} accounts=${currentEntityState.accounts.size}`);

      // Payment was added to mempool in applyEntityTx
      // We need to find which account got the payment and mark it for frame proposal

      // Check all accounts to see which one has new mempool items
      // Note: accountKey is counterparty ID (e.g., "alice", "bob")
      if (HEAVY_LOGS) logDebug(L, `DIRECT-PAYMENT-SCAN: Entity ${currentEntityState.entityId.slice(-4)} has ${currentEntityState.accounts.size} accounts`);
      for (const [counterpartyId, accountMachine] of currentEntityState.accounts) {
        const isLeft = isLeftEntity(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);
        if (HEAVY_LOGS) logDebug(L, `Checking account ${counterpartyId.slice(-10)}: mempool=${accountMachine.mempool.length} isLeft=${isLeft} pending=${!!accountMachine.proposal}`);
        if (accountMachine.mempool.length > 0 && !accountMachine.proposal) {
          proposableAccounts.add(counterpartyId);
          if (HEAVY_LOGS) logDebug(L, `Added ${counterpartyId.slice(-10)} to proposableAccounts (mempool=${accountMachine.mempool.length})`);
        } else if (accountMachine.proposal) {
          if (HEAVY_LOGS) logDebug(L, `SKIP: ${counterpartyId.slice(-10)} has pendingFrame h${accountMachine.proposal.pendingFrame.height} - will propose after ACK`);
        }
      }
    } else if (entityTx.type === 'openAccount' && entityTx.data) {
      // openAccount processed - account may have mempool items queued
      const targetEntity = entityTx.data.targetEntityId;
      const accountMachine = currentEntityState.accounts.get(targetEntity as AccountKey);
      if (accountMachine) {
        if (accountMachine.mempool.length > 0 && !accountMachine.proposal) {
          proposableAccounts.add(targetEntity);
          if (HEAVY_LOGS) logDebug(L, `Added ${targetEntity.slice(0,10)} to proposable (account opened, mempool=${accountMachine.mempool.length})`);
        }
      }
    } else if (entityTx.type === 'extendCredit' && entityTx.data) {
      // Credit extension - mark account for proposal
      const counterpartyId = entityTx.data.counterpartyEntityId;
      // Account keyed by counterparty ID
      const accountMachine = currentEntityState.accounts.get(counterpartyId as AccountKey);
      if (HEAVY_LOGS) logDebug(L, `EXTEND-CREDIT: ${counterpartyId.slice(0,10)} exists=${!!accountMachine} mempool=${accountMachine?.mempool?.length || 0}`);
      if (accountMachine && accountMachine.mempool.length > 0) {
        proposableAccounts.add(counterpartyId);
        if (HEAVY_LOGS) logDebug(L, `Added ${counterpartyId.slice(0,10)} to proposableAccounts (credit extension)`);
      }
    }
  }

  // === APPLY AGGREGATED PURE EVENTS ===

  // 1. MempoolOps now applied inline (see above in the loop) to fix simultaneous payment bug
  // This section removed - mempoolOps are applied immediately after each applyEntityTx

  // 2. Run orderbook matching on aggregated swap offers (batch matching)
  if (allSwapOffersCreated.length > 0 && currentEntityState.orderbookExt) {
    logDebug(L, `ENTITY-ORCHESTRATOR: Batch matching ${allSwapOffersCreated.length} swap offers`);

    // AUDIT FIX (CRITICAL-1): Enrich SwapOfferEvent with accountId from Hub's perspective
    // Hub is running this code, so accountId = the counterparty's entityId (the Map key)
    // For Hub processing Alice's offer: fromEntity=Hub, toEntity=Alice (from Hub's A-Machine)
    // So accountId = Alice's entityId (the counterparty who placed the offer)
    const enrichedOffers = allSwapOffersCreated.map(offer => {
      // The offer comes from an account where the account's proofHeader has
      // fromEntity = entity running this code (Hub) and toEntity = counterparty
      // BUT offers are created by the MAKER, who may be fromEntity or toEntity
      // depending on makerIsLeft
      //
      // SIMPLE RULE: Hub's Map key = counterparty ID
      // The counterparty is whoever is NOT Hub in this account
      // Since we're Hub and we're processing, accountId = whichever entity is NOT us
      const hubId = currentEntityState.entityId;
      const counterparty = offer.fromEntity === hubId ? offer.toEntity : offer.fromEntity;
      return { ...offer, accountId: counterparty };
    });
    if (HEAVY_LOGS) logDebug(L, `ENTITY-ORCHESTRATOR: Enriched ${enrichedOffers.length} offers with accountId`);

    const { processOrderbookSwaps } = await import('./entity-tx/handlers/account');
    let matchResult: Awaited<ReturnType<typeof processOrderbookSwaps>>;
    try {
      matchResult = processOrderbookSwaps(currentEntityState, enrichedOffers);
    } catch (e) {
      logError(L, `❌ processOrderbookSwaps threw — skipping batch: ${(e as Error).message}`);
      matchResult = { mempoolOps: [], bookUpdates: [] };
    }

    // Apply match results to account mempools
    for (const { accountId, tx } of matchResult.mempoolOps) {
      const account = currentEntityState.accounts.get(accountId as AccountKey);
      if (account) {
        account.mempool.push(tx);
        proposableAccounts.add(accountId);
        if (HEAVY_LOGS) logDebug(L, `swap match: ${accountId.slice(-8)}: ${tx.type}`);
      }

      if (tx.type === 'swap_resolve') {
        currentEntityState.pendingSwapFillRatios ||= new Map();
        const key = `${accountId}:${tx.data.offerId}`;
        currentEntityState.pendingSwapFillRatios.set(key, tx.data.fillRatio);
      }
    }

    // Apply book updates
    const ext = currentEntityState.orderbookExt as any;
    for (const { pairId, book } of matchResult.bookUpdates) {
      ext.books.set(pairId, book);
    }
  }

  // 3. Process swap cancellations
  if (allSwapOffersCancelled.length > 0 && currentEntityState.orderbookExt) {
    logDebug(L, `ENTITY-ORCHESTRATOR: Processing ${allSwapOffersCancelled.length} swap cancels`);
    const { processOrderbookCancels } = await import('./entity-tx/handlers/account');
    const bookUpdates = processOrderbookCancels(currentEntityState, allSwapOffersCancelled);

    const ext = currentEntityState.orderbookExt as any;
    for (const { pairId, book } of bookUpdates) {
      ext.books.set(pairId, book);
    }
  }

  // Capture deterministic state BEFORE account proposals (for hash computation)
  // Both proposer and validator must hash from this identical state
  const deterministicState = cloneEntityState(currentEntityState);

  // AUTO-PROPOSE: Propose account frames for touched accounts (Channel.ts pattern)
  // DETERMINISM: Validators skip account frame proposals during verification.
  // Account frame proposals use env.timestamp which differs per-tick.
  // Only the proposer generates proposals; validators just verify the entity state.
  if (verifyOnly) {
    return { newState: currentEntityState, deterministicState, outputs: allOutputs, jOutputs: allJOutputs, collectedHashes: [] };
  }

  const { proposeAccountFrame } = await import('./account-consensus');

  // CRITICAL: Deterministic ordering
  // Simple filter: propose if ready (mempool non-empty, no pendingFrame)
  // If pendingFrame exists, skip - will be handled by BATCH-CHECK when ACK arrives
  const accountsToProposeFrames = Array.from(proposableAccounts)
    .filter(accountId => {
      const accountMachine = currentEntityState.accounts.get(accountId as AccountKey);
      if (!accountMachine) {
        if (HEAVY_LOGS) logDebug(L, `FILTER: Account ${accountId.slice(-8)} not found - skip`);
        return false;
      }
      if (accountMachine.mempool.length === 0) {
        if (HEAVY_LOGS) logDebug(L, `FILTER: Account ${accountId.slice(-8)} mempool empty - skip`);
        return false;
      }
      if (accountMachine.proposal) {
        if (HEAVY_LOGS) logDebug(L, `FILTER: Account ${accountId.slice(-8)} has pendingFrame h${accountMachine.proposal.pendingFrame.height} - SKIP (will batch on ACK)`);
        return false;
      }
      if (HEAVY_LOGS) logDebug(L, `FILTER: Account ${accountId.slice(-8)} READY - proposing (mempool: ${accountMachine.mempool.length})`);
      return true;
    })
    .sort();

  // Collect hashes during processing (not scanning afterwards)
  const collectedHashes: Array<{ hash: string; type: 'accountFrame' | 'dispute' | 'profile' | 'settlement'; context: string }> = [];

  if (accountsToProposeFrames.length > 0) {

    for (const accountKey of accountsToProposeFrames) {
      const accountMachine = currentEntityState.accounts.get(accountKey as AccountKey);
      const { counterparty: cpId } = accountMachine ? getAccountPerspective(accountMachine, currentEntityState.entityId) : { counterparty: 'unknown' };
      if (HEAVY_LOGS) logDebug(L, `BEFORE-PROPOSE: Getting account for ${cpId.slice(-4)}`);
      if (accountMachine) {
        logDebug(L, `PROPOSE-FRAME for ${cpId.slice(-4)}: mempool=${accountMachine.mempool.length} types=[${accountMachine.mempool.map(tx => tx.type)}]`);
        const proposal = await proposeAccountFrame(env, accountMachine, false, currentEntityState.lastFinalizedJHeight);

        const proposalOk = isOk(proposal) ? proposal.value : undefined;
        const proposalErr = isErr(proposal) ? proposal.error : undefined;
        if (HEAVY_LOGS) logDebug(L, `PROPOSE-RESULT for ${cpId.slice(-4)}: success=${isOk(proposal)} error=${proposalErr?.error || 'none'}`);

        // Collect hashes from proposal (multi-signer support)
        if (proposalOk?.hashesToSign) {
          collectedHashes.push(...proposalOk.hashesToSign);
        }

        // Handle failed HTLC locks: cancel backward via htlcRoutes
        // failedHtlcLocks can appear on both Ok and Err results
        const failedHtlcLocks = proposalOk?.failedHtlcLocks || proposalErr?.failedHtlcLocks;
        if (failedHtlcLocks && failedHtlcLocks.length > 0) {
          for (const { hashlock, reason } of failedHtlcLocks) {
            const route = currentEntityState.htlcRoutes.get(hashlock);
            if (route) {
              // Always clean local bookkeeping for failed proposals.
              if (route.outboundLockId) {
                currentEntityState.lockBook.delete(route.outboundLockId);
              }

              if (route.inboundEntity && route.inboundLockId) {
                const inboundAccount = currentEntityState.accounts.get(route.inboundEntity as AccountKey);
                if (inboundAccount) {
                  inboundAccount.mempool.push({
                    type: 'htlc_resolve',
                    data: {
                      lockId: route.inboundLockId,
                      outcome: 'error' as const,
                      reason: `forward_failed:${reason}`,
                    }
                  });
                  proposableAccounts.add(route.inboundEntity);
                  logDebug(L, `HTLC-CANCEL-BACKWARD: hashlock=${hashlock.slice(0,12)}... inbound=${route.inboundEntity.slice(-4)} reason=${reason}`);
                }
              }

              currentEntityState.htlcRoutes.delete(hashlock);
            }
          }
        }

        if (proposalOk) {
          // Get the proposer of the target entity from env
          // IMPORTANT: AccountInput sent only to PROPOSER (bilateral consensus between entity proposers)
          // Multi-validator entities share account state via entity-level consensus
          // Convert AccountInput to EntityInput for routing
          const outputEntityInput: EntityInput = {
            entityId: proposalOk.accountInput.toEntityId,
            entityTxs: [{
              type: 'accountInput' as const,
              data: proposalOk.accountInput
            }]
          };
          allOutputs.push(outputEntityInput);

          const proposalInput = proposalOk.accountInput;
          const frameHeight = proposalInput.type === 'proposal' || proposalInput.type === 'ack' ? proposalInput.height : 0;
          logDebug(L, `ACCOUNT-FRAME-OUTPUT: frame ${frameHeight} to ${proposalInput.toEntityId.slice(-4)} (${accountKey.slice(-8)})`);

          // Add events to entity messages with size limiting
          addMessages(currentEntityState, proposalOk.events);
          emitScopedEvents(
            env,
            'account',
            `E/A/${currentEntityState.entityId.slice(-4)}:${cpId.slice(-4)}/propose`,
            proposalOk.events,
            {
              entityId: currentEntityState.entityId,
              counterpartyId: cpId,
              frameHeight,
              accountKey,
            },
            currentEntityState.entityId,
          );
        }
      }
    }
  }

  if (collectedHashes.length > 0) {
    logDebug(L, `HASH-COLLECTION: ${collectedHashes.length} hashes for entity signing`);
    if (HEAVY_LOGS) collectedHashes.forEach(h => logDebug(L, `  ${h.type}: ${h.hash.slice(0, 18)}... (${h.context})`));
  }

  return { newState: currentEntityState, deterministicState, outputs: allOutputs, jOutputs: allJOutputs, collectedHashes };
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
export const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint => {
  return signers.reduce((total, signerId) => {
    const shares = config.shares[signerId];
    if (shares === undefined) {
      logError(L, `⚠️ BYZANTINE: Unknown signer ${signerId} in quorum calculation — skipped`);
      return total;
    }
    return total + shares;
  }, 0n);
};

/**
 * Merges duplicate entity inputs to reduce processing overhead
 */
const mergeJEventTxs = (txs: EntityTx[]): EntityTx[] => {
  const merged: EntityTx[] = [];

  for (const tx of txs) {
    if (tx.type !== 'j_event' || !tx.data) {
      merged.push(tx);
      continue;
    }

    const data = tx.data as any;
    const blockNumber = data.blockNumber;
    const blockHash = data.blockHash;

    const existing = merged.find(
      candidate =>
        candidate.type === 'j_event' &&
        candidate.data &&
        (candidate.data as any).blockNumber === blockNumber &&
        (candidate.data as any).blockHash === blockHash,
    );

    if (!existing || !existing.data) {
      merged.push(tx);
      continue;
    }

    const existingData = existing.data as any;
    const existingEvents = existingData.events || (existingData.event ? [existingData.event] : []);
    const incomingEvents = data.events || (data.event ? [data.event] : []);

    const seen = new Set<string>();
    const mergedEvents: any[] = [];
    for (const event of [...existingEvents, ...incomingEvents]) {
      const key = `${event?.type ?? 'unknown'}:${safeStringify(event?.data ?? event)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mergedEvents.push(event);
    }

    existingData.events = mergedEvents;
    existingData.event = mergedEvents[0];

    if (typeof data.observedAt === 'number') {
      if (typeof existingData.observedAt !== 'number' || data.observedAt < existingData.observedAt) {
        existingData.observedAt = data.observedAt;
      }
    }

    if (HEAVY_LOGS) {
      logDebug(L, `MERGE-J-EVENTS: block ${blockNumber} ${blockHash?.slice(0, 10)}... now ${mergedEvents.length} events`);
    }
  }

  return merged;
};

export const mergeEntityInputs = (inputs: RoutedEntityInput[]): RoutedEntityInput[] => {
  const merged = new Map<string, RoutedEntityInput>();
  const conflicts: RoutedEntityInput[] = [];
  let duplicateCount = 0;

  for (const input of inputs) {
    const key = `${input.entityId}:${input.signerId || ''}`;
    const entityShort = input.entityId.slice(0, 10);

    if (merged.has(key)) {
      const existing = merged.get(key)!;
      duplicateCount++;

      const existingFrameHash = existing.proposedFrame?.hash;
      const incomingFrameHash = input.proposedFrame?.hash;
      if (existingFrameHash && incomingFrameHash && existingFrameHash !== incomingFrameHash) {
        const existingHasPrecommits = !!existing.hashPrecommits && existing.hashPrecommits.size > 0;
        const incomingHasPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
        logWarn(L, `MERGE-CONFLICT: ${key} has different proposedFrame hashes (${existingFrameHash.slice(0, 10)} vs ${incomingFrameHash.slice(0, 10)}) - keeping both inputs`);
        if (incomingHasPrecommits && !existingHasPrecommits) {
          merged.set(key, { ...input });
          conflicts.push(existing);
        } else {
          conflicts.push(input);
        }
        continue;
      }

      if (HEAVY_LOGS) logDebug(L, `DUPLICATE-FOUND: Merging duplicate input ${duplicateCount} for ${entityShort}:${input.signerId || ''}`);

      // Merge entity transactions
      if (input.entityTxs) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
        if (existing.entityTxs) {
          existing.entityTxs = mergeJEventTxs(existing.entityTxs);
        }
        if (HEAVY_LOGS) logDebug(L, `MERGE-TXS: Added ${input.entityTxs.length} transactions`);
      }

      // Merge hashPrecommits (multi-hash signatures)
      if (input.hashPrecommits) {
        const existingPrecommits = existing.hashPrecommits || new Map<string, string[]>();
        if (HEAVY_LOGS) logDebug(L, `MERGE-PRECOMMITS: ${input.hashPrecommits.size} into ${existingPrecommits.size} for ${entityShort}:${input.signerId || ''}`);
        input.hashPrecommits.forEach((sigs, signerId) => {
          if (HEAVY_LOGS) logDebug(L, `MERGE-DETAIL: Adding hashPrecommit from ${signerId} (${sigs.length} sigs)`);
          existingPrecommits.set(signerId, sigs);
        });
        existing.hashPrecommits = existingPrecommits;
        if (HEAVY_LOGS) logDebug(L, `MERGE-RESULT: Total ${existingPrecommits.size} hashPrecommits after merge`);
      }

      // Keep the latest frame (simplified)
      if (input.proposedFrame) existing.proposedFrame = input.proposedFrame;

      if (HEAVY_LOGS) logDebug(L, `Merging inputs for ${key}: txs=${input.entityTxs?.length || 0} precommits=${input.hashPrecommits?.size || 0} frame=${!!input.proposedFrame}`);
    } else {
      merged.set(key, { ...input });
    }
  }

  if (duplicateCount > 0) {
    logDebug(L, `Merged ${duplicateCount} duplicate inputs (${inputs.length} -> ${merged.size})`);
  }

  const mergedInputs = Array.from(merged.values());
  return [...mergedInputs, ...conflicts].map(input => {
    if (input.entityTxs && input.entityTxs.length > 1) {
      return { ...input, entityTxs: mergeJEventTxs(input.entityTxs) };
    }
    return input;
  });
};

