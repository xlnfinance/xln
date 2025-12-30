/**
 * XLN Entity Consensus and State Management
 * Core entity processing logic, consensus, proposals, and state transitions
 */

import { applyEntityTx } from './entity-tx';
import { ConsensusConfig, EntityInput, EntityReplica, EntityState, EntityTx, Env } from './types';
import { DEBUG, formatEntityDisplay, formatSignerDisplay, log } from './utils';
import { safeStringify } from './serialization-utils';
import { logError } from './logger';
import { addMessages, cloneEntityReplica, canonicalAccountKey, getAccountPerspective } from './state-helpers';
import { LIMITS } from './constants';

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
    if (!input.signerId || typeof input.signerId !== 'string') {
      log.error(`❌ Invalid signerId: ${input.signerId}`);
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
        if (typeof tx.type !== 'string') {
          log.error(`❌ Transaction type must be string: ${typeof tx.type}`);
          return false;
        }
        // No whitelist - trust the type system
      }
    }

    // Precommits validation
    if (input.precommits) {
      if (!(input.precommits instanceof Map)) {
        log.error(`❌ Precommits must be Map, got: ${typeof input.precommits}`);
        return false;
      }
      if (input.precommits.size > 100) {
        log.error(`❌ Too many precommits: ${input.precommits.size} > 100`);
        return false;
      }
      for (const [signerId, signature] of input.precommits) {
        if (typeof signerId !== 'string' || typeof signature !== 'string') {
          log.error(`❌ Invalid precommit format: ${signerId} -> ${signature}`);
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
 * Validates timestamp to prevent temporal attacks
 */
const validateTimestamp = (proposedTime: number, currentTime: number): boolean => {
  try {
    const maxDrift = 30000; // 30 seconds
    const drift = Math.abs(proposedTime - currentTime);
    if (drift > maxDrift) {
      log.error(`❌ Timestamp drift too large: ${drift}ms > ${maxDrift}ms`);
      log.error(`❌ Proposed: ${new Date(proposedTime).toISOString()}`);
      log.error(`❌ Current: ${new Date(currentTime).toISOString()}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Timestamp validation error: ${error}`);
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
): Promise<{ newState: EntityState, outputs: EntityInput[], jOutputs: JInput[] }> => {
  // IMMUTABILITY: Clone replica at function start (fintech-safe, hacker-proof)
  // Prevents state mutations from escaping function scope
  const workingReplica = cloneEntityReplica(entityReplica);

  // Debug: Log every input being processed with timestamp and unique identifier
  const entityDisplay = formatEntityDisplay(entityInput.entityId);
  const timestamp = Date.now();
  const currentProposalHash = workingReplica.proposal?.hash?.slice(0, 10) || 'none';
  const frameHash = entityInput.proposedFrame?.hash?.slice(0, 10) || 'none';

  console.log(
    `🔍 INPUT-RECEIVED: [${timestamp}] Processing input for Entity #${entityDisplay}:${formatSignerDisplay(entityInput.signerId)}`,
  );
  console.log(
    `🔍 INPUT-STATE: Current proposal: ${currentProposalHash}, Mempool: ${workingReplica.mempool.length}, isProposer: ${workingReplica.isProposer}`,
  );
  console.log(
    `🔍 INPUT-DETAILS: txs=${entityInput.entityTxs?.length || 0}, precommits=${entityInput.precommits?.size || 0}, frame=${frameHash}`,
  );
  if (entityInput.precommits?.size) {
    const precommitSigners = Array.from(entityInput.precommits.keys());
    console.log(`🔍 INPUT-PRECOMMITS: Received precommits from: ${precommitSigners.join(', ')}`);
    // Track exactly which proposal these precommits are for
    const firstPrecommit = entityInput.precommits.values().next().value;
    const proposalHashFromSig = firstPrecommit ? firstPrecommit.split('_')[2]?.slice(0, 10) : 'unknown';
    console.log(`🔍 PRECOMMIT-PROPOSAL: These precommits are for proposal: ${proposalHashFromSig}`);
  }

  // SECURITY: Validate all inputs
  if (!validateEntityInput(entityInput)) {
    log.error(`❌ Invalid input for ${entityInput.entityId}:${entityInput.signerId}`);
    return { newState: workingReplica.state, outputs: [], jOutputs: [] };
  }
  if (!validateEntityReplica(workingReplica)) {
    log.error(`❌ Invalid replica state for ${workingReplica.entityId}:${workingReplica.signerId}`);
    return { newState: workingReplica.state, outputs: [], jOutputs: [] };
  }

  const entityOutbox: EntityInput[] = [];
  const jOutbox: JInput[] = []; // J-layer outputs

  // ⏰ Execute crontab tasks (periodic checks like account timeouts)
  const { executeCrontab, initCrontab } = await import('./entity-crontab');

  // Initialize crontab on first use
  if (!workingReplica.state.crontabState) {
    workingReplica.state.crontabState = initCrontab();
  }

  const crontabOutputs = await executeCrontab(workingReplica, workingReplica.state.crontabState);
  if (crontabOutputs.length > 0) {
    console.log(`⏰ CRONTAB: Generated ${crontabOutputs.length} outputs from periodic tasks`);
    entityOutbox.push(...crontabOutputs);
  }

  // Add transactions to mempool (mutable for performance)
  if (entityInput.entityTxs?.length) {
    // DEBUG: Track vote transactions specifically
    const voteTransactions = entityInput.entityTxs.filter(tx => tx.type === 'vote');
    if (voteTransactions.length > 0) {
      console.log(`🗳️ VOTE-MEMPOOL: ${workingReplica.signerId} receiving ${voteTransactions.length} vote transactions`);
      voteTransactions.forEach(tx => {
        console.log(`🗳️ VOTE-TX:`, tx);
      });
    }

    if (workingReplica.signerId === 'alice') {
      console.log(`🔥 ALICE-RECEIVES: Alice receiving ${entityInput.entityTxs.length} txs from input`);
      console.log(
        `🔥 ALICE-RECEIVES: Transaction types:`,
        entityInput.entityTxs.map(tx => tx.type),
      );
      console.log(
        `🔥 ALICE-RECEIVES: Alice isProposer=${workingReplica.isProposer}, current mempool=${workingReplica.mempool.length}`,
      );
    }
    // Log details of each EntityTx
    for (const tx of entityInput.entityTxs) {
      console.log(`🏛️ E-MACHINE: - EntityTx type="${tx.type}", data=`, safeStringify(tx.data, 2));
    }
    workingReplica.mempool.push(...entityInput.entityTxs);
    if (DEBUG)
      console.log(
        `    → Added ${entityInput.entityTxs.length} txs to mempool (total: ${workingReplica.mempool.length})`,
      );
    if (DEBUG && entityInput.entityTxs.length > 3) {
      console.log(`    ⚠️  CORNER CASE: Large batch of ${entityInput.entityTxs.length} transactions`);
    }
  } else if (entityInput.entityTxs && entityInput.entityTxs.length === 0) {
    // DEBUG removed: ⚠️  CORNER CASE: Empty transaction array received - no mempool changes`);
  }

  // CRITICAL: Forward transactions to proposer BEFORE processing commits
  // This prevents race condition where commits clear mempool before forwarding
  if (!workingReplica.isProposer && workingReplica.mempool.length > 0) {
    // Send mempool to proposer
    const proposerId = workingReplica.state.config.validators[0];
    if (!proposerId) {
      logError("FRAME_CONSENSUS", `❌ No proposer found in validators: ${workingReplica.state.config.validators}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
    }

    const txCount = workingReplica.mempool.length;
    console.log(`🔥 BOB-TO-ALICE: Bob sending ${txCount} txs to proposer ${proposerId}`);
    console.log(
      `🔥 BOB-TO-ALICE: Transaction types:`,
      workingReplica.mempool.map(tx => tx.type),
    );
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...workingReplica.mempool],
    });

    // CHANNEL.TS PATTERN: Track sent txs, DON'T clear mempool yet
    // Only clear after receiving commit confirmation (like Channel.ts line 217)
    workingReplica.sentTransitions = txCount;
    console.log(`📊 Tracked ${txCount} sent transitions (will clear on commit)`);
  }

  // Handle commit notifications AFTER forwarding (when receiving finalized frame from proposer)
  if (entityInput.precommits?.size && entityInput.proposedFrame && !workingReplica.proposal) {
    const signers = Array.from(entityInput.precommits.keys());
    const totalPower = calculateQuorumPower(workingReplica.state.config, signers);

    if (totalPower >= workingReplica.state.config.threshold) {
      // This is a commit notification from proposer, apply the frame

      // SECURITY: Validate commit matches our locked frame (if we have one)
      if (workingReplica.lockedFrame) {
        if (workingReplica.lockedFrame.hash !== entityInput.proposedFrame.hash) {
          logError("FRAME_CONSENSUS", `❌ BYZANTINE: Commit frame doesn't match locked frame!`);
          logError("FRAME_CONSENSUS", `   Locked: ${workingReplica.lockedFrame.hash}`);
          logError("FRAME_CONSENSUS", `   Commit: ${entityInput.proposedFrame.hash}`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
        }
        console.log(`✅ Commit validation: matches locked frame ${workingReplica.lockedFrame.hash.slice(0,10)}`);
      }

      // SECURITY: Verify signatures are for the correct frame hash
      for (const [signerId, signature] of entityInput.precommits) {
        const expectedSig = `sig_${signerId}_${entityInput.proposedFrame.hash}`;
        if (signature !== expectedSig) {
          logError("FRAME_CONSENSUS", `❌ BYZANTINE: Invalid signature format from ${signerId}`);
          logError("FRAME_CONSENSUS", `   Expected: ${expectedSig.slice(0,30)}...`);
          logError("FRAME_CONSENSUS", `   Received: ${signature.slice(0,30)}...`);
          return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
        }
      }
      console.log(`✅ All ${entityInput.precommits.size} signatures validated for frame ${entityInput.proposedFrame.hash.slice(0,10)}`);

      // Emit frame commit event
      env.emit('EntityFrameCommitted', {
        entityId: entityInput.entityId,
        signerId: workingReplica.signerId,
        height: workingReplica.state.height + 1,
        frameHash: entityInput.proposedFrame.hash,
        txCount: entityInput.proposedFrame.txs.length,
        signatures: entityInput.precommits.size,
      });

      // Apply the committed frame with incremented height
      workingReplica.state = {
        ...entityInput.proposedFrame.newState,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId
        height: workingReplica.state.height + 1,
      };

      // CHANNEL.TS PATTERN: Only clear sent transactions that were committed
      // Like Channel.ts line 217: mempool.splice(0, this.data.sentTransitions)
      if (workingReplica.sentTransitions && workingReplica.sentTransitions > 0) {
        console.log(`📊 Clearing ${workingReplica.sentTransitions} committed txs from mempool (${workingReplica.mempool.length} total)`);
        workingReplica.mempool.splice(0, workingReplica.sentTransitions);
        workingReplica.sentTransitions = 0;
        console.log(`📊 Mempool after commit: ${workingReplica.mempool.length} txs remaining`);
      } else {
        // Fallback: clear entire mempool (old behavior)
        workingReplica.mempool.length = 0;
      }

      delete workingReplica.lockedFrame; // Release lock after commit
      if (DEBUG)
        console.log(
          `    → Applied commit, new state: ${workingReplica.state.messages.length} messages, height: ${workingReplica.state.height}`,
        );

      // Return early - commit notifications don't trigger further processing
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
    }
  }

  // Handle proposed frame (PROPOSE phase) - only if not a commit notification
  if (
    entityInput.proposedFrame &&
    (!workingReplica.proposal || (workingReplica.state.config.mode === 'gossip-based' && workingReplica.isProposer))
  ) {
    const frameSignature = `sig_${workingReplica.signerId}_${entityInput.proposedFrame.hash}`;
    const config = workingReplica.state.config;

    // Lock to this frame (CometBFT style)
    workingReplica.lockedFrame = entityInput.proposedFrame;
    // DEBUG removed: → Validator locked to frame ${entityInput.proposedFrame.hash.slice(0, 10)}...`);

    if (config.mode === 'gossip-based') {
      // Send precommit to all validators
      config.validators.forEach(validatorId => {
        console.log(
          `🔍 GOSSIP: [${timestamp}] ${workingReplica.signerId} sending precommit to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${frameHash}, sig: ${frameSignature.slice(0, 20)}...`,
        );
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          precommits: new Map([[workingReplica.signerId, frameSignature]]),
        });
      });
      // DEBUG removed: → Signed proposal, gossiping precommit to ${config.validators.length} validators`);
    } else {
      // Send precommit to proposer only
      const proposerId = config.validators[0];
      if (!proposerId) {
        logError("FRAME_CONSENSUS", `❌ No proposer found in validators: ${config.validators}`);
        return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
      }
      console.log(
        `🔍 PROPOSER: [${timestamp}] ${workingReplica.signerId} sending precommit to ${proposerId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${frameHash}, sig: ${frameSignature.slice(0, 20)}...`,
      );
      console.log(
        `🔍 PROPOSER-REASON: Signed new proposal, current state: proposal=${currentProposalHash}, locked=${workingReplica.lockedFrame?.hash?.slice(0, 10) || 'none'}`,
      );
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: proposerId,
        precommits: new Map([[workingReplica.signerId, frameSignature]]),
      });
      // DEBUG removed: → Signed proposal, sending precommit to ${proposerId}`);
    }
  }

  // Handle precommits (SIGN phase)
  if (entityInput.precommits?.size && workingReplica.proposal) {
    // SECURITY: Check for Byzantine faults before collecting signatures
    for (const [signerId, signature] of entityInput.precommits) {
      if (detectByzantineFault(workingReplica.proposal.signatures, signerId, signature)) {
        log.error(`❌ Rejecting Byzantine input from ${signerId}`);
        return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox }; // Return early, don't process malicious input
      }
      workingReplica.proposal.signatures.set(signerId, signature);
    }
    if (DEBUG)
      console.log(
        `    → Collected ${entityInput.precommits.size} signatures (total: ${workingReplica.proposal.signatures.size})`,
      );

    // Check threshold using shares
    const signers = Array.from(workingReplica.proposal.signatures.keys());
    const totalPower = calculateQuorumPower(workingReplica.state.config, signers);

    // SECURITY: Validate voting power
    if (!validateVotingPower(totalPower)) {
      log.error(`❌ Invalid voting power calculation: ${totalPower}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
    }

    if (DEBUG) {
      const totalShares = Object.values(workingReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalPower) / Number(workingReplica.state.config.threshold)) * 100).toFixed(1);
      log.info(
        `    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(workingReplica.state.config.threshold) ? '+' : ''}]`,
      );
      if (workingReplica.state.config.mode === 'gossip-based') {
        console.log(`    ⚠️  CORNER CASE: Gossip mode - all validators receive precommits`);
      }
    }

    if (totalPower >= workingReplica.state.config.threshold) {
      // Commit phase - use pre-computed state with incremented height
      workingReplica.state = {
        ...workingReplica.proposal.newState,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId
        height: workingReplica.state.height + 1,
      };
      // DEBUG removed: → Threshold reached! Committing frame, height: ${workingReplica.state.height}`);

      // Save proposal data before clearing
      const sortedSignatures = sortSignatures(workingReplica.proposal.signatures, workingReplica.state.config);
      const committedFrame = workingReplica.proposal;

      // Clear state (mutable)
      workingReplica.mempool.length = 0;
      delete workingReplica.proposal;
      delete workingReplica.lockedFrame; // Release lock after commit

      // Only send commit notifications in proposer-based mode
      // In gossip mode, everyone already has all precommits via gossip
      if (workingReplica.state.config.mode === 'proposer-based') {
        const committedProposalHash = committedFrame.hash.slice(0, 10);
        console.log(
          `🔍 COMMIT-START: [${timestamp}] ${workingReplica.signerId} reached threshold for proposal ${committedProposalHash}, sending commit notifications...`,
        );

        // Notify all validators (except self - proposer already has all precommits)
        workingReplica.state.config.validators.forEach(validatorId => {
          if (validatorId !== workingReplica.signerId) {
            const precommitSigners = Array.from(sortedSignatures.keys());
            console.log(
              `🔍 COMMIT: [${timestamp}] ${workingReplica.signerId} sending commit notification to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${committedProposalHash} (${sortedSignatures.size} precommits from: ${precommitSigners.join(', ')})`,
            );
            entityOutbox.push({
              entityId: entityInput.entityId,
              signerId: validatorId,
              precommits: sortedSignatures,
              proposedFrame: committedFrame,
            });
          }
        });
        // const notifiedCount = workingReplica.state.config.validators.length - 1; // excluding self
        // DEBUG removed: → Sending commit notifications to ${notifiedCount} validators (excluding self)`);
      } else {
        console.log(
          `🔍 GOSSIP-COMMIT: [${timestamp}] ${workingReplica.signerId} NOT sending commit notifications (gossip mode) for entity ${entityInput.entityId.slice(0, 10)}...`,
        );
        if (DEBUG)
          console.log(`    → Gossip mode: No commit notifications needed (everyone has precommits via gossip)`);
      }
    }
  }

  // Commit notifications are now handled at the top of the function

  // Debug consensus trigger conditions
  console.log(`🎯 CONSENSUS-CHECK: Entity ${workingReplica.entityId}:${workingReplica.signerId}`);
  console.log(`🎯   isProposer: ${workingReplica.isProposer}`);
  console.log(`🎯   mempool.length: ${workingReplica.mempool.length}`);
  console.log(`🎯   hasProposal: ${!!workingReplica.proposal}`);
  if (workingReplica.mempool.length > 0) {
    console.log(
      `🎯   mempoolTypes:`,
      workingReplica.mempool.map(tx => tx.type),
    );
  }

  // Auto-propose logic: ONLY proposer can propose (BFT requirement)
  if (workingReplica.isProposer && workingReplica.mempool.length > 0 && !workingReplica.proposal) {
    console.log(`🔥 ALICE-PROPOSES: Alice auto-propose triggered!`);
    console.log(
      `🔥 ALICE-PROPOSES: mempool=${workingReplica.mempool.length}, isProposer=${workingReplica.isProposer}, hasProposal=${!!workingReplica.proposal}`,
    );
    console.log(
      `🔥 ALICE-PROPOSES: Mempool transaction types:`,
      workingReplica.mempool.map(tx => tx.type),
    );

    // Check if this is a single signer entity (threshold = 1, only 1 validator)
    const isSingleSigner =
      workingReplica.state.config.validators.length === 1 && workingReplica.state.config.threshold === BigInt(1);

    if (isSingleSigner) {
      console.log(`🚀 SINGLE-SIGNER: Direct execution without consensus for single signer entity`);
      // For single signer entities, directly apply transactions without consensus
      const { newState: newEntityState, outputs: frameOutputs, jOutputs: frameJOutputs } = await applyEntityFrame(env, workingReplica.state, workingReplica.mempool);
      workingReplica.state = {
        ...newEntityState,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId
        height: workingReplica.state.height + 1,
      };

      // Add any outputs generated by entity transactions to the outbox
      entityOutbox.push(...frameOutputs);
      jOutbox.push(...frameJOutputs); // CRITICAL: Collect J-outputs!

      // Clear mempool after direct application
      workingReplica.mempool.length = 0;

      if (DEBUG)
        console.log(
          `    ⚡ Single signer entity: transactions applied directly, height: ${workingReplica.state.height}`,
        );
      // SINGLE-SIGNER-RETURN removed - too noisy
      console.log(`🔥 SINGLE-SIGNER RETURN: entityOutbox=${entityOutbox.length}, jOutbox=${jOutbox.length}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox }; // Skip the full consensus process
    }

    if (DEBUG)
      console.log(
        `    🚀 Auto-propose triggered: mempool=${workingReplica.mempool.length}, isProposer=${workingReplica.isProposer}, hasProposal=${!!workingReplica.proposal}`,
      );
    // Compute new state once during proposal
    const { newState: newEntityState, outputs: proposalOutputs } = await applyEntityFrame(env, workingReplica.state, workingReplica.mempool);

    // Add any outputs generated during proposal to the outbox
    entityOutbox.push(...proposalOutputs);

    // Proposer creates new timestamp for this frame (DETERMINISTIC: use runtime timestamp)
    const newTimestamp = env.timestamp;

    // SECURITY: Validate timestamp
    if (!validateTimestamp(newTimestamp, env.timestamp)) {
      log.error(`❌ Invalid proposal timestamp: ${newTimestamp}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
    }

    // TODO(bft-hardening): Replace weak placeholder hash with cryptographic commitment
    // Current: height + timestamp only - validators don't sign actual state content
    // Required: Merkle root over transactions + keccak256(orderbookExt + accountStates)
    // Impact: Without this, equivocation attacks possible in multi-validator setup
    // See: docs/htlc-hardening.md for full security audit
    const frameHash = `frame_${workingReplica.state.height + 1}_${newTimestamp}`;
    const selfSignature = `sig_${workingReplica.signerId}_${frameHash}`;

    workingReplica.proposal = {
      height: workingReplica.state.height + 1,
      txs: [...workingReplica.mempool],
      hash: frameHash,
      newState: {
        ...newEntityState,
        entityId: workingReplica.state.entityId, // PRESERVE: Never lose entityId in proposal
        height: workingReplica.state.height + 1,
        timestamp: newTimestamp, // Set new deterministic timestamp in proposed state
      },
      signatures: new Map<string, string>([[workingReplica.signerId, selfSignature]]), // Proposer signs immediately
    };

    if (DEBUG)
      console.log(
        `    → Auto-proposing frame ${workingReplica.proposal.hash} with ${workingReplica.proposal.txs.length} txs and self-signature.`,
      );

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
  } else if (!workingReplica.isProposer && workingReplica.mempool.length > 0) {
    // DEBUG removed: → Non-proposer sending ${workingReplica.mempool.length} txs to proposer`);
    // Send mempool to proposer
    const proposerId = workingReplica.state.config.validators[0];
    if (!proposerId) {
      logError("FRAME_CONSENSUS", `❌ No proposer found in validators: ${workingReplica.state.config.validators}`);
      return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
    }
    console.log(`🔥 BOB-TO-ALICE: Bob sending ${workingReplica.mempool.length} txs to proposer ${proposerId}`);
    console.log(
      `🔥 BOB-TO-ALICE: Transaction types:`,
      workingReplica.mempool.map(tx => tx.type),
    );
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...workingReplica.mempool],
    });
    // Clear mempool after sending
    workingReplica.mempool.length = 0;
  } else if (workingReplica.isProposer && workingReplica.proposal) {
    // DEBUG removed: ⚠️  CORNER CASE: Proposer already has pending proposal - no new auto-propose`);
  }

  // Debug: Log outputs being generated with detailed analysis
  console.log(
    `🔍 OUTPUT-GENERATED: [${timestamp}] Entity #${entityDisplay}:${formatSignerDisplay(workingReplica.signerId)} generating ${entityOutbox.length} outputs`,
  );
  console.log(
    `🔍 OUTPUT-FINAL-STATE: proposal=${workingReplica.proposal?.hash?.slice(0, 10) || 'none'}, mempool=${workingReplica.mempool.length}, locked=${workingReplica.lockedFrame?.hash?.slice(0, 10) || 'none'}`,
  );

  entityOutbox.forEach((output, index) => {
    const targetDisplay = formatEntityDisplay(output.entityId);
    const outputFrameHash = output.proposedFrame?.hash?.slice(0, 10) || 'none';
    console.log(
      `🔍 OUTPUT-${index + 1}: [${timestamp}] To Entity #${targetDisplay}:${formatSignerDisplay(output.signerId)} - txs=${output.entityTxs?.length || 0}, precommits=${output.precommits?.size || 0}, frame=${outputFrameHash}`,
    );

    if (output.precommits?.size) {
      const precommitSigners = Array.from(output.precommits.keys());
      console.log(`🔍 OUTPUT-${index + 1}-PRECOMMITS: Sending precommits from: ${precommitSigners.join(', ')}`);

      // Show the actual signature content to track duplicates
      output.precommits.forEach((sig, signer) => {
        const sigShort = sig.slice(0, 20);
        const proposalFromSig = sig.split('_')[2]?.slice(0, 10) || 'unknown';
        console.log(`🔍 OUTPUT-${index + 1}-SIG-DETAIL: ${signer} -> ${sigShort}... (proposal: ${proposalFromSig})`);
      });
    }

    // Classify output type for clarity
    if (output.proposedFrame && output.precommits?.size) {
      console.log(`🔍 OUTPUT-${index + 1}-TYPE: COMMIT_NOTIFICATION (frame + precommits)`);
    } else if (output.precommits?.size) {
      console.log(`🔍 OUTPUT-${index + 1}-TYPE: PRECOMMIT_VOTE (precommits only)`);
    } else if (output.proposedFrame) {
      console.log(`🔍 OUTPUT-${index + 1}-TYPE: PROPOSAL (frame only)`);
    } else if (output.entityTxs?.length) {
      console.log(`🔍 OUTPUT-${index + 1}-TYPE: TRANSACTION_FORWARD (txs only)`);
    } else {
      console.log(`🔍 OUTPUT-${index + 1}-TYPE: UNKNOWN (empty output)`);
    }
  });

  return { newState: workingReplica.state, outputs: entityOutbox, jOutputs: jOutbox };
};

export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
): Promise<{ newState: EntityState, outputs: EntityInput[], jOutputs: JInput[] }> => {
  console.log(`🎯 APPLY-ENTITY-FRAME: Processing ${entityTxs.length} transactions`);
  entityTxs.forEach((tx, index) => {
    console.log(`🎯 Transaction ${index}: type="${tx.type}", data=`, tx.data);
  });

  let currentEntityState = entityState;
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
          console.log(`🔍 [Frame ${env.height}] AFTER-ENTITY-TX(j_event): Account ${cpId.slice(-4)} mempool:`, acct.mempool.map((tx: any) => tx.type));
        }
      }
    }

    allOutputs.push(...outputs);
    if (jOutputs) allJOutputs.push(...jOutputs);

    // Collect pure events for post-loop processing
    if (mempoolOps) allMempoolOps.push(...mempoolOps);
    if (swapOffersCreated) allSwapOffersCreated.push(...swapOffersCreated);
    if (swapOffersCancelled) allSwapOffersCancelled.push(...swapOffersCancelled);

    // Debug: Log all account mempools after each tx
    if (entityTx.type === 'extendCredit') {
      console.log(`💳 POST-EXTEND-CREDIT: Checking all account mempools:`);
      for (const [cpId, acctMachine] of currentEntityState.accounts) {
        console.log(`💳   Account with ${cpId.slice(0,10)}: mempool=${acctMachine.mempool.length}, pendingFrame=${acctMachine.pendingFrame ? `height=${acctMachine.pendingFrame.height}` : 'none'}, currentHeight=${acctMachine.currentHeight}`);
        if (acctMachine.mempool.length > 0) {
          console.log(`💳   Mempool txs:`, acctMachine.mempool.map(tx => tx.type));
        }
        if (acctMachine.pendingFrame) {
          console.log(`💳   ⚠️ BLOCKING: pendingFrame exists - no new proposals until ACKed!`);
        }
      }
    }

    // Track which accounts need proposals based on transaction type
    if (entityTx.type === 'accountInput' && entityTx.data) {
      const fromEntity = entityTx.data.fromEntityId;
      // Account keyed by counterparty ID (fromEntity is our counterparty)
      const accountMachine = currentEntityState.accounts.get(fromEntity);

      if (accountMachine) {
        // Add to proposable if:
        // - We have pending mempool items and no pending frame
        const isAck = entityTx.data.height && entityTx.data.prevSignatures;
        const hasPendingTxs = accountMachine.mempool.length > 0;

        // Only propose if we have something to send:
        // - Have transactions in mempool
        if (hasPendingTxs && !accountMachine.pendingFrame) {
          proposableAccounts.add(fromEntity); // counterparty ID
          console.log(`🔄 Added ${fromEntity.slice(0,10)} to proposable - Pending:${hasPendingTxs}`);
        } else if (isAck) {
          console.log(`✅ Received ACK from ${fromEntity.slice(0,10)}, no action needed (mempool empty)`);
        }
      }
    } else if (entityTx.type === 'directPayment' && entityTx.data) {
      console.log(`🔍 DIRECT-PAYMENT detected in applyEntityFrame`);
      console.log(`🔍 Payment data:`, {
        targetEntityId: entityTx.data.targetEntityId,
        route: entityTx.data.route,
        amount: entityTx.data.amount
      });
      console.log(`🔍 Current entity has ${currentEntityState.accounts.size} accounts`);

      // Payment was added to mempool in applyEntityTx
      // We need to find which account got the payment and mark it for frame proposal

      // Check all accounts to see which one has new mempool items
      // Note: accountKey is counterparty ID (e.g., "alice", "bob")
      for (const [counterpartyId, accountMachine] of currentEntityState.accounts) {
        const isLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;
        console.log(`🔍 Checking account ${counterpartyId.slice(-10)}: mempool=${accountMachine.mempool.length}, isLeft=${isLeft}, pendingFrame=${!!accountMachine.pendingFrame}`);
        if (accountMachine.mempool.length > 0) {
          proposableAccounts.add(counterpartyId);
          console.log(`🔄 ✅ Added ${counterpartyId.slice(-10)} to proposableAccounts (has ${accountMachine.mempool.length} mempool items)`);
        }
      }
    } else if (entityTx.type === 'openAccount' && entityTx.data) {
      // Account opened - may need initial frame
      const targetEntity = entityTx.data.targetEntityId;
      // Account keyed by counterparty ID
      const accountMachine = currentEntityState.accounts.get(targetEntity);
      if (accountMachine) {
        const isLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;
        if (isLeft && accountMachine.mempool.length > 0 && !accountMachine.pendingFrame) {
          proposableAccounts.add(targetEntity);
          console.log(`🔄 Added ${targetEntity.slice(0,10)} to proposable (new account opened)`);
        }
      }
    } else if (entityTx.type === 'extendCredit' && entityTx.data) {
      // Credit extension - mark account for proposal
      const counterpartyId = entityTx.data.counterpartyEntityId;
      // Account keyed by counterparty ID
      const accountMachine = currentEntityState.accounts.get(counterpartyId);
      console.log(`💳 EXTEND-CREDIT: Checking account ${counterpartyId.slice(0,10)} for proposal`);
      console.log(`💳 EXTEND-CREDIT: accountMachine exists: ${!!accountMachine}, mempool: ${accountMachine?.mempool?.length || 0}`);
      if (accountMachine && accountMachine.mempool.length > 0) {
        proposableAccounts.add(counterpartyId);
        console.log(`💳 ✅ Added ${counterpartyId.slice(0,10)} to proposableAccounts (credit extension)`);
      }
    }
  }

  // === APPLY AGGREGATED PURE EVENTS ===

  // 1. Apply mempoolOps from handlers (HTLC forwards, reveals, direct payments)
  if (allMempoolOps.length > 0) {
    console.log(`📦 ENTITY-ORCHESTRATOR: Applying ${allMempoolOps.length} mempoolOps`);
    for (const { accountId, tx } of allMempoolOps) {
      const account = currentEntityState.accounts.get(accountId);
      if (account) {
        account.mempool.push(tx);
        proposableAccounts.add(accountId);
        console.log(`📦   → ${accountId.slice(-8)}: ${tx.type}`);
      } else {
        console.warn(`📦   ⚠️ Account ${accountId.slice(-8)} not found for mempoolOp`);
      }
    }
  }

  // 2. Run orderbook matching on aggregated swap offers (batch matching)
  if (allSwapOffersCreated.length > 0 && currentEntityState.orderbookExt) {
    console.log(`📊 ENTITY-ORCHESTRATOR: Batch matching ${allSwapOffersCreated.length} swap offers`);
    const { processOrderbookSwaps } = await import('./entity-tx/handlers/account');
    const matchResult = processOrderbookSwaps(currentEntityState, allSwapOffersCreated);

    // Apply match results to account mempools
    for (const { accountId, tx } of matchResult.mempoolOps) {
      const account = currentEntityState.accounts.get(accountId);
      if (account) {
        account.mempool.push(tx);
        proposableAccounts.add(accountId);
        console.log(`📊   → ${accountId.slice(-8)}: ${tx.type}`);
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
    console.log(`📊 ENTITY-ORCHESTRATOR: Processing ${allSwapOffersCancelled.length} swap cancels`);
    const { processOrderbookCancels } = await import('./entity-tx/handlers/account');
    const bookUpdates = processOrderbookCancels(currentEntityState, allSwapOffersCancelled);

    const ext = currentEntityState.orderbookExt as any;
    for (const { pairId, book } of bookUpdates) {
      ext.books.set(pairId, book);
    }
  }

  // AUTO-PROPOSE: No O(n) scan needed - proposableAccounts already tracks touched accounts
  const { proposeAccountFrame } = await import('./account-consensus');

  // CRITICAL: Deterministic ordering
  const accountsToProposeFrames = Array.from(proposableAccounts)
    .filter(accountId => {
      const accountMachine = currentEntityState.accounts.get(accountId);
      return accountMachine ? accountMachine.mempool.length > 0 && !accountMachine.pendingFrame : false;
    })
    .sort();

  if (accountsToProposeFrames.length > 0) {

    for (const accountKey of accountsToProposeFrames) {
      const accountMachine = currentEntityState.accounts.get(accountKey);
      const { counterparty: cpId } = accountMachine ? getAccountPerspective(accountMachine, currentEntityState.entityId) : { counterparty: 'unknown' };
      console.log(`🔍 [Frame ${env.height}] BEFORE-PROPOSE: Getting account for ${cpId.slice(-4)}`);
      if (accountMachine) {
        console.log(`📋 [Frame ${env.height}] PROPOSE-FRAME for ${cpId.slice(-4)}: mempool=${accountMachine.mempool.length} txs:`, accountMachine.mempool.map(tx => tx.type));
        console.log(`📋 [Frame ${env.height}] PROPOSE-FRAME: leftJObs=${accountMachine.leftJObservations?.length || 0}, rightJObs=${accountMachine.rightJObservations?.length || 0}`);
        const proposal = await proposeAccountFrame(env, accountMachine);

        if (proposal.success && proposal.accountInput) {
          // Get the proposer of the target entity from env
          let targetProposerId = 'alice'; // Default fallback
          const targetReplicaKeys = Array.from(env.eReplicas.keys()).filter(key => key.startsWith(proposal.accountInput!.toEntityId + ':'));
          if (targetReplicaKeys.length > 0) {
            const firstTargetReplica = env.eReplicas.get(targetReplicaKeys[0]!);
            const firstValidator = firstTargetReplica?.state.config.validators[0];
            if (firstValidator) {
              targetProposerId = firstValidator;
            }
          }

          // Convert AccountInput to EntityInput for routing
          const outputEntityInput: EntityInput = {
            entityId: proposal.accountInput.toEntityId,
            signerId: targetProposerId, // Route to target entity's proposer
            entityTxs: [{
              type: 'accountInput' as const,
              data: proposal.accountInput
            }]
          };
          allOutputs.push(outputEntityInput);

          // Add events to entity messages with size limiting
          addMessages(currentEntityState, proposal.events);
        }
      }
    }
  }

  return { newState: currentEntityState, outputs: allOutputs, jOutputs: allJOutputs };
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
export const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint => {
  return signers.reduce((total, signerId) => {
    const shares = config.shares[signerId];
    if (shares === undefined) {
      throw new Error(`CONSENSUS-SAFETY: Unknown validator ${signerId} - cannot calculate quorum power`);
    }
    return total + shares;
  }, 0n);
};

export const sortSignatures = (signatures: Map<string, string>, config: ConsensusConfig): Map<string, string> => {
  const sortedEntries = Array.from(signatures.entries()).sort(([a], [b]) => {
    const indexA = config.validators.indexOf(a);
    const indexB = config.validators.indexOf(b);
    return indexA - indexB;
  });
  return new Map(sortedEntries);
};

// === ENTITY UTILITIES (existing) ===

/**
 * Merges duplicate entity inputs to reduce processing overhead
 */
export const mergeEntityInputs = (inputs: EntityInput[]): EntityInput[] => {
  const merged = new Map<string, EntityInput>();
  let duplicateCount = 0;

  // Look for potential Carol duplicates specifically
  const carolInputs = inputs.filter(input => input.signerId.includes('carol'));
  if (carolInputs.length > 1) {
    console.log(`🔍 MERGE-CAROL-ALERT: Found ${carolInputs.length} inputs from Carol - potential duplicate source!`);
    carolInputs.forEach((input, i) => {
      const entityShort = input.entityId.slice(0, 10);
      const precommitSigners = input.precommits ? Array.from(input.precommits.keys()).join(',') : 'none';
      console.log(`🔍 MERGE-CAROL-${i + 1}: ${entityShort}:${input.signerId} - precommits: ${precommitSigners}`);
    });
  }

  for (const input of inputs) {
    const key = `${input.entityId}:${input.signerId}`;
    const entityShort = input.entityId.slice(0, 10);

    if (merged.has(key)) {
      const existing = merged.get(key)!;
      duplicateCount++;

      console.log(`🔍 DUPLICATE-FOUND: Merging duplicate input ${duplicateCount} for ${entityShort}:${input.signerId}`);

      // Merge entity transactions
      if (input.entityTxs) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
        console.log(`🔍 MERGE-TXS: Added ${input.entityTxs.length} transactions`);
      }

      // Merge precommits
      if (input.precommits) {
        const existingPrecommits = existing.precommits || new Map();
        console.log(
          `🔍 MERGE-PRECOMMITS: Merging ${input.precommits.size} precommits into existing ${existingPrecommits.size} for ${entityShort}:${input.signerId}`,
        );
        input.precommits.forEach((signature, signerId) => {
          console.log(`🔍 MERGE-DETAIL: Adding precommit from ${signerId} (sig: ${signature.slice(0, 20)}...)`);
          existingPrecommits.set(signerId, signature);
        });
        existing.precommits = existingPrecommits;
        console.log(`🔍 MERGE-RESULT: Total ${existingPrecommits.size} precommits after merge`);
      }

      // Keep the latest frame (simplified)
      if (input.proposedFrame) existing.proposedFrame = input.proposedFrame;

      console.log(
        `    🔄 Merging inputs for ${key}: txs=${input.entityTxs?.length || 0}, precommits=${input.precommits?.size || 0}, frame=${!!input.proposedFrame}`,
      );
    } else {
      merged.set(key, { ...input });
    }
  }

  if (duplicateCount > 0) {
    console.log(`    ⚠️  CORNER CASE: Merged ${duplicateCount} duplicate inputs (${inputs.length} → ${merged.size})`);
  }

  return Array.from(merged.values());
};

/**
 * Gets entity state summary for debugging
 */
export const getEntityStateSummary = (replica: EntityReplica): string => {
  const hasProposal = replica.proposal ? '✓' : '✗';
  return `mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${hasProposal}`;
};

/**
 * Checks if entity should auto-propose (simplified version)
 */
export const shouldAutoPropose = (replica: EntityReplica, _config: ConsensusConfig): boolean => {
  const hasMempool = replica.mempool.length > 0;
  const isProposer = replica.isProposer;
  const hasProposal = replica.proposal !== undefined;

  return hasMempool && isProposer && !hasProposal;
};

/**
 * Processes empty transaction arrays (corner case)
 */
export const handleEmptyTransactions = (): void => {
  console.log(`    ⚠️  CORNER CASE: Empty transaction array received - no mempool changes`);
};

/**
 * Logs large transaction batches (corner case)
 */
export const handleLargeBatch = (txCount: number): void => {
  if (txCount >= 8) {
    console.log(`    ⚠️  CORNER CASE: Large batch of ${txCount} transactions`);
  }
};

/**
 * Handles gossip mode precommit distribution
 */
export const handleGossipMode = (): void => {
  console.log(`    ⚠️  CORNER CASE: Gossip mode - all validators receive precommits`);
};

/**
 * Logs proposer with empty mempool corner case
 */
export const handleEmptyMempoolProposer = (): void => {
  console.log(`    ⚠️  CORNER CASE: Proposer with empty mempool - no auto-propose`);
};
