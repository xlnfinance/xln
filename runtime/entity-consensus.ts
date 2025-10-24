/**
 * XLN Entity Consensus and State Management
 * Core entity processing logic, consensus, proposals, and state transitions
 */

import { applyEntityTx } from './entity-tx';
import { ConsensusConfig, EntityInput, EntityReplica, EntityState, EntityTx, Env } from './types';
import { DEBUG, formatEntityDisplay, formatSignerDisplay, log } from './utils';
import { safeStringify } from './serialization-utils';
import { logError } from './logger';
import { addMessages } from './state-helpers';

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
        if (
          typeof tx.type !== 'string' ||
          !['chat', 'propose', 'vote', 'profile-update', 'j_event', 'accountInput', 'openAccount', 'directPayment'].includes(tx.type)
        ) {
          log.error(`❌ Invalid transaction type: ${tx.type}`);
          return false;
        }
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
    if (replica.mempool.length > 10000) {
      log.error(`❌ Mempool overflow: ${replica.mempool.length} > 10000`);
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
): Promise<{ newState: EntityState, outputs: EntityInput[] }> => {
  // Debug: Log every input being processed with timestamp and unique identifier
  const entityDisplay = formatEntityDisplay(entityInput.entityId);
  const timestamp = Date.now();
  const currentProposalHash = entityReplica.proposal?.hash?.slice(0, 10) || 'none';
  const frameHash = entityInput.proposedFrame?.hash?.slice(0, 10) || 'none';

  console.log(
    `🔍 INPUT-RECEIVED: [${timestamp}] Processing input for Entity #${entityDisplay}:${formatSignerDisplay(entityInput.signerId)}`,
  );
  console.log(
    `🔍 INPUT-STATE: Current proposal: ${currentProposalHash}, Mempool: ${entityReplica.mempool.length}, isProposer: ${entityReplica.isProposer}`,
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
    return { newState: entityReplica.state, outputs: [] };
  }
  if (!validateEntityReplica(entityReplica)) {
    log.error(`❌ Invalid replica state for ${entityReplica.entityId}:${entityReplica.signerId}`);
    return { newState: entityReplica.state, outputs: [] };
  }

  const entityOutbox: EntityInput[] = [];

  // ⏰ Execute crontab tasks (periodic checks like account timeouts)
  const { executeCrontab, initCrontab } = await import('./entity-crontab');

  // Initialize crontab on first use
  if (!entityReplica.state.crontabState) {
    entityReplica.state.crontabState = initCrontab();
  }

  const crontabOutputs = await executeCrontab(entityReplica, entityReplica.state.crontabState);
  if (crontabOutputs.length > 0) {
    console.log(`⏰ CRONTAB: Generated ${crontabOutputs.length} outputs from periodic tasks`);
    entityOutbox.push(...crontabOutputs);
  }

  // Add transactions to mempool (mutable for performance)
  if (entityInput.entityTxs?.length) {
    // DEBUG: Track vote transactions specifically
    const voteTransactions = entityInput.entityTxs.filter(tx => tx.type === 'vote');
    if (voteTransactions.length > 0) {
      console.log(`🗳️ VOTE-MEMPOOL: ${entityReplica.signerId} receiving ${voteTransactions.length} vote transactions`);
      voteTransactions.forEach(tx => {
        console.log(`🗳️ VOTE-TX:`, tx);
      });
    }

    if (entityReplica.signerId === 'alice') {
      console.log(`🔥 ALICE-RECEIVES: Alice receiving ${entityInput.entityTxs.length} txs from input`);
      console.log(
        `🔥 ALICE-RECEIVES: Transaction types:`,
        entityInput.entityTxs.map(tx => tx.type),
      );
      console.log(
        `🔥 ALICE-RECEIVES: Alice isProposer=${entityReplica.isProposer}, current mempool=${entityReplica.mempool.length}`,
      );
    }
    // Log details of each EntityTx
    for (const tx of entityInput.entityTxs) {
      console.log(`🏛️ E-MACHINE: - EntityTx type="${tx.type}", data=`, safeStringify(tx.data, 2));
    }
    entityReplica.mempool.push(...entityInput.entityTxs);
    if (DEBUG)
      console.log(
        `    → Added ${entityInput.entityTxs.length} txs to mempool (total: ${entityReplica.mempool.length})`,
      );
    if (DEBUG && entityInput.entityTxs.length > 3) {
      console.log(`    ⚠️  CORNER CASE: Large batch of ${entityInput.entityTxs.length} transactions`);
    }
  } else if (entityInput.entityTxs && entityInput.entityTxs.length === 0) {
    // DEBUG removed: ⚠️  CORNER CASE: Empty transaction array received - no mempool changes`);
  }

  // CRITICAL: Forward transactions to proposer BEFORE processing commits
  // This prevents race condition where commits clear mempool before forwarding
  if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
    // Send mempool to proposer
    const proposerId = entityReplica.state.config.validators[0];
    if (!proposerId) {
      logError("FRAME_CONSENSUS", `❌ No proposer found in validators: ${entityReplica.state.config.validators}`);
      return { newState: entityReplica.state, outputs: entityOutbox };
    }

    const txCount = entityReplica.mempool.length;
    console.log(`🔥 BOB-TO-ALICE: Bob sending ${txCount} txs to proposer ${proposerId}`);
    console.log(
      `🔥 BOB-TO-ALICE: Transaction types:`,
      entityReplica.mempool.map(tx => tx.type),
    );
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...entityReplica.mempool],
    });

    // CHANNEL.TS PATTERN: Track sent txs, DON'T clear mempool yet
    // Only clear after receiving commit confirmation (like Channel.ts line 217)
    entityReplica.sentTransitions = txCount;
    console.log(`📊 Tracked ${txCount} sent transitions (will clear on commit)`);
  }

  // Handle commit notifications AFTER forwarding (when receiving finalized frame from proposer)
  if (entityInput.precommits?.size && entityInput.proposedFrame && !entityReplica.proposal) {
    const signers = Array.from(entityInput.precommits.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);

    if (totalPower >= entityReplica.state.config.threshold) {
      // This is a commit notification from proposer, apply the frame

      // SECURITY: Validate commit matches our locked frame (if we have one)
      if (entityReplica.lockedFrame) {
        if (entityReplica.lockedFrame.hash !== entityInput.proposedFrame.hash) {
          logError("FRAME_CONSENSUS", `❌ BYZANTINE: Commit frame doesn't match locked frame!`);
          logError("FRAME_CONSENSUS", `   Locked: ${entityReplica.lockedFrame.hash}`);
          logError("FRAME_CONSENSUS", `   Commit: ${entityInput.proposedFrame.hash}`);
          return { newState: entityReplica.state, outputs: entityOutbox };
        }
        console.log(`✅ Commit validation: matches locked frame ${entityReplica.lockedFrame.hash.slice(0,10)}`);
      }

      // SECURITY: Verify signatures are for the correct frame hash
      for (const [signerId, signature] of entityInput.precommits) {
        const expectedSig = `sig_${signerId}_${entityInput.proposedFrame.hash}`;
        if (signature !== expectedSig) {
          logError("FRAME_CONSENSUS", `❌ BYZANTINE: Invalid signature format from ${signerId}`);
          logError("FRAME_CONSENSUS", `   Expected: ${expectedSig.slice(0,30)}...`);
          logError("FRAME_CONSENSUS", `   Received: ${signature.slice(0,30)}...`);
          return { newState: entityReplica.state, outputs: entityOutbox };
        }
      }
      console.log(`✅ All ${entityInput.precommits.size} signatures validated for frame ${entityInput.proposedFrame.hash.slice(0,10)}`);

      // Apply the committed frame with incremented height
      entityReplica.state = {
        ...entityInput.proposedFrame.newState,
        height: entityReplica.state.height + 1,
      };

      // CHANNEL.TS PATTERN: Only clear sent transactions that were committed
      // Like Channel.ts line 217: mempool.splice(0, this.data.sentTransitions)
      if (entityReplica.sentTransitions && entityReplica.sentTransitions > 0) {
        console.log(`📊 Clearing ${entityReplica.sentTransitions} committed txs from mempool (${entityReplica.mempool.length} total)`);
        entityReplica.mempool.splice(0, entityReplica.sentTransitions);
        entityReplica.sentTransitions = 0;
        console.log(`📊 Mempool after commit: ${entityReplica.mempool.length} txs remaining`);
      } else {
        // Fallback: clear entire mempool (old behavior)
        entityReplica.mempool.length = 0;
      }

      delete entityReplica.lockedFrame; // Release lock after commit
      if (DEBUG)
        console.log(
          `    → Applied commit, new state: ${entityReplica.state.messages.length} messages, height: ${entityReplica.state.height}`,
        );

      // Return early - commit notifications don't trigger further processing
      return { newState: entityReplica.state, outputs: entityOutbox };
    }
  }

  // Handle proposed frame (PROPOSE phase) - only if not a commit notification
  if (
    entityInput.proposedFrame &&
    (!entityReplica.proposal || (entityReplica.state.config.mode === 'gossip-based' && entityReplica.isProposer))
  ) {
    const frameSignature = `sig_${entityReplica.signerId}_${entityInput.proposedFrame.hash}`;
    const config = entityReplica.state.config;

    // Lock to this frame (CometBFT style)
    entityReplica.lockedFrame = entityInput.proposedFrame;
    // DEBUG removed: → Validator locked to frame ${entityInput.proposedFrame.hash.slice(0, 10)}...`);

    if (config.mode === 'gossip-based') {
      // Send precommit to all validators
      config.validators.forEach(validatorId => {
        console.log(
          `🔍 GOSSIP: [${timestamp}] ${entityReplica.signerId} sending precommit to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${frameHash}, sig: ${frameSignature.slice(0, 20)}...`,
        );
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          precommits: new Map([[entityReplica.signerId, frameSignature]]),
        });
      });
      // DEBUG removed: → Signed proposal, gossiping precommit to ${config.validators.length} validators`);
    } else {
      // Send precommit to proposer only
      const proposerId = config.validators[0];
      if (!proposerId) {
        logError("FRAME_CONSENSUS", `❌ No proposer found in validators: ${config.validators}`);
        return { newState: entityReplica.state, outputs: entityOutbox };
      }
      console.log(
        `🔍 PROPOSER: [${timestamp}] ${entityReplica.signerId} sending precommit to ${proposerId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${frameHash}, sig: ${frameSignature.slice(0, 20)}...`,
      );
      console.log(
        `🔍 PROPOSER-REASON: Signed new proposal, current state: proposal=${currentProposalHash}, locked=${entityReplica.lockedFrame?.hash?.slice(0, 10) || 'none'}`,
      );
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: proposerId,
        precommits: new Map([[entityReplica.signerId, frameSignature]]),
      });
      // DEBUG removed: → Signed proposal, sending precommit to ${proposerId}`);
    }
  }

  // Handle precommits (SIGN phase)
  if (entityInput.precommits?.size && entityReplica.proposal) {
    // SECURITY: Check for Byzantine faults before collecting signatures
    for (const [signerId, signature] of entityInput.precommits) {
      if (detectByzantineFault(entityReplica.proposal.signatures, signerId, signature)) {
        log.error(`❌ Rejecting Byzantine input from ${signerId}`);
        return { newState: entityReplica.state, outputs: entityOutbox }; // Return early, don't process malicious input
      }
      entityReplica.proposal.signatures.set(signerId, signature);
    }
    if (DEBUG)
      console.log(
        `    → Collected ${entityInput.precommits.size} signatures (total: ${entityReplica.proposal.signatures.size})`,
      );

    // Check threshold using shares
    const signers = Array.from(entityReplica.proposal.signatures.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);

    // SECURITY: Validate voting power
    if (!validateVotingPower(totalPower)) {
      log.error(`❌ Invalid voting power calculation: ${totalPower}`);
      return { newState: entityReplica.state, outputs: entityOutbox };
    }

    if (DEBUG) {
      const totalShares = Object.values(entityReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalPower) / Number(entityReplica.state.config.threshold)) * 100).toFixed(1);
      log.info(
        `    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(entityReplica.state.config.threshold) ? '+' : ''}]`,
      );
      if (entityReplica.state.config.mode === 'gossip-based') {
        console.log(`    ⚠️  CORNER CASE: Gossip mode - all validators receive precommits`);
      }
    }

    if (totalPower >= entityReplica.state.config.threshold) {
      // Commit phase - use pre-computed state with incremented height
      entityReplica.state = {
        ...entityReplica.proposal.newState,
        height: entityReplica.state.height + 1,
      };
      // DEBUG removed: → Threshold reached! Committing frame, height: ${entityReplica.state.height}`);

      // Save proposal data before clearing
      const sortedSignatures = sortSignatures(entityReplica.proposal.signatures, entityReplica.state.config);
      const committedFrame = entityReplica.proposal;

      // Clear state (mutable)
      entityReplica.mempool.length = 0;
      delete entityReplica.proposal;
      delete entityReplica.lockedFrame; // Release lock after commit

      // Only send commit notifications in proposer-based mode
      // In gossip mode, everyone already has all precommits via gossip
      if (entityReplica.state.config.mode === 'proposer-based') {
        const committedProposalHash = committedFrame.hash.slice(0, 10);
        console.log(
          `🔍 COMMIT-START: [${timestamp}] ${entityReplica.signerId} reached threshold for proposal ${committedProposalHash}, sending commit notifications...`,
        );

        // Notify all validators (except self - proposer already has all precommits)
        entityReplica.state.config.validators.forEach(validatorId => {
          if (validatorId !== entityReplica.signerId) {
            const precommitSigners = Array.from(sortedSignatures.keys());
            console.log(
              `🔍 COMMIT: [${timestamp}] ${entityReplica.signerId} sending commit notification to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${committedProposalHash} (${sortedSignatures.size} precommits from: ${precommitSigners.join(', ')})`,
            );
            entityOutbox.push({
              entityId: entityInput.entityId,
              signerId: validatorId,
              precommits: sortedSignatures,
              proposedFrame: committedFrame,
            });
          }
        });
        // const notifiedCount = entityReplica.state.config.validators.length - 1; // excluding self
        // DEBUG removed: → Sending commit notifications to ${notifiedCount} validators (excluding self)`);
      } else {
        console.log(
          `🔍 GOSSIP-COMMIT: [${timestamp}] ${entityReplica.signerId} NOT sending commit notifications (gossip mode) for entity ${entityInput.entityId.slice(0, 10)}...`,
        );
        if (DEBUG)
          console.log(`    → Gossip mode: No commit notifications needed (everyone has precommits via gossip)`);
      }
    }
  }

  // Commit notifications are now handled at the top of the function

  // Debug consensus trigger conditions
  console.log(`🎯 CONSENSUS-CHECK: Entity ${entityReplica.entityId}:${entityReplica.signerId}`);
  console.log(`🎯   isProposer: ${entityReplica.isProposer}`);
  console.log(`🎯   mempool.length: ${entityReplica.mempool.length}`);
  console.log(`🎯   hasProposal: ${!!entityReplica.proposal}`);
  if (entityReplica.mempool.length > 0) {
    console.log(
      `🎯   mempoolTypes:`,
      entityReplica.mempool.map(tx => tx.type),
    );
  }

  // Auto-propose logic: ONLY proposer can propose (BFT requirement)
  if (entityReplica.isProposer && entityReplica.mempool.length > 0 && !entityReplica.proposal) {
    console.log(`🔥 ALICE-PROPOSES: Alice auto-propose triggered!`);
    console.log(
      `🔥 ALICE-PROPOSES: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`,
    );
    console.log(
      `🔥 ALICE-PROPOSES: Mempool transaction types:`,
      entityReplica.mempool.map(tx => tx.type),
    );

    // Check if this is a single signer entity (threshold = 1, only 1 validator)
    const isSingleSigner =
      entityReplica.state.config.validators.length === 1 && entityReplica.state.config.threshold === BigInt(1);

    if (isSingleSigner) {
      console.log(`🚀 SINGLE-SIGNER: Direct execution without consensus for single signer entity`);
      // For single signer entities, directly apply transactions without consensus
      const { newState: newEntityState, outputs: frameOutputs } = await applyEntityFrame(env, entityReplica.state, entityReplica.mempool);
      entityReplica.state = {
        ...newEntityState,
        height: entityReplica.state.height + 1,
      };

      // Add any outputs generated by entity transactions to the outbox
      entityOutbox.push(...frameOutputs);
      // SINGLE-SIGNER-OUTPUTS removed - too noisy

      // Clear mempool after direct application
      entityReplica.mempool.length = 0;

      if (DEBUG)
        console.log(
          `    ⚡ Single signer entity: transactions applied directly, height: ${entityReplica.state.height}`,
        );
      // SINGLE-SIGNER-RETURN removed - too noisy
      return { newState: entityReplica.state, outputs: entityOutbox }; // Skip the full consensus process
    }

    if (DEBUG)
      console.log(
        `    🚀 Auto-propose triggered: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`,
      );
    // Compute new state once during proposal
    const { newState: newEntityState, outputs: proposalOutputs } = await applyEntityFrame(env, entityReplica.state, entityReplica.mempool);

    // Add any outputs generated during proposal to the outbox
    entityOutbox.push(...proposalOutputs);

    // Proposer creates new timestamp for this frame (DETERMINISTIC: use runtime timestamp)
    const newTimestamp = env.timestamp;

    // SECURITY: Validate timestamp
    if (!validateTimestamp(newTimestamp, env.timestamp)) {
      log.error(`❌ Invalid proposal timestamp: ${newTimestamp}`);
      return { newState: entityReplica.state, outputs: entityOutbox };
    }

    const frameHash = `frame_${entityReplica.state.height + 1}_${newTimestamp}`;
    const selfSignature = `sig_${entityReplica.signerId}_${frameHash}`;

    entityReplica.proposal = {
      height: entityReplica.state.height + 1,
      txs: [...entityReplica.mempool],
      hash: frameHash,
      newState: {
        ...newEntityState,
        height: entityReplica.state.height + 1,
        timestamp: newTimestamp, // Set new deterministic timestamp in proposed state
      },
      signatures: new Map<string, string>([[entityReplica.signerId, selfSignature]]), // Proposer signs immediately
    };

    if (DEBUG)
      console.log(
        `    → Auto-proposing frame ${entityReplica.proposal.hash} with ${entityReplica.proposal.txs.length} txs and self-signature.`,
      );

    // Send proposal to all validators (except self)
    entityReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== entityReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: entityReplica.proposal!,
          // Note: Don't send entityTxs separately - they're already in proposedFrame.txs
        });
      }
    });
  } else if (entityReplica.isProposer && entityReplica.mempool.length === 0 && !entityReplica.proposal) {
    // DEBUG removed: ⚠️  CORNER CASE: Proposer with empty mempool - no auto-propose`);
  } else if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
    // DEBUG removed: → Non-proposer sending ${entityReplica.mempool.length} txs to proposer`);
    // Send mempool to proposer
    const proposerId = entityReplica.state.config.validators[0];
    if (!proposerId) {
      logError("FRAME_CONSENSUS", `❌ No proposer found in validators: ${entityReplica.state.config.validators}`);
      return { newState: entityReplica.state, outputs: entityOutbox };
    }
    console.log(`🔥 BOB-TO-ALICE: Bob sending ${entityReplica.mempool.length} txs to proposer ${proposerId}`);
    console.log(
      `🔥 BOB-TO-ALICE: Transaction types:`,
      entityReplica.mempool.map(tx => tx.type),
    );
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...entityReplica.mempool],
    });
    // Clear mempool after sending
    entityReplica.mempool.length = 0;
  } else if (entityReplica.isProposer && entityReplica.proposal) {
    // DEBUG removed: ⚠️  CORNER CASE: Proposer already has pending proposal - no new auto-propose`);
  }

  // Debug: Log outputs being generated with detailed analysis
  console.log(
    `🔍 OUTPUT-GENERATED: [${timestamp}] Entity #${entityDisplay}:${formatSignerDisplay(entityReplica.signerId)} generating ${entityOutbox.length} outputs`,
  );
  console.log(
    `🔍 OUTPUT-FINAL-STATE: proposal=${entityReplica.proposal?.hash?.slice(0, 10) || 'none'}, mempool=${entityReplica.mempool.length}, locked=${entityReplica.lockedFrame?.hash?.slice(0, 10) || 'none'}`,
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

  return { newState: entityReplica.state, outputs: entityOutbox };
};

export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
): Promise<{ newState: EntityState, outputs: EntityInput[] }> => {
  console.log(`🎯 APPLY-ENTITY-FRAME: Processing ${entityTxs.length} transactions`);
  entityTxs.forEach((tx, index) => {
    console.log(`🎯 Transaction ${index}: type="${tx.type}", data=`, tx.data);
  });

  let currentEntityState = entityState;
  const allOutputs: EntityInput[] = [];

  // Track accounts that need frame proposals during this processing round
  const proposableAccounts = new Set<string>();

  for (const entityTx of entityTxs) {
    const { newState, outputs } = await applyEntityTx(env, currentEntityState, entityTx);
    currentEntityState = newState;
    allOutputs.push(...outputs);

    // Track which accounts need proposals based on transaction type
    if (entityTx.type === 'accountInput' && entityTx.data) {
      const fromEntity = entityTx.data.fromEntityId;
      const accountMachine = currentEntityState.accounts.get(fromEntity);

      if (accountMachine) {
        // Add to proposable if:
        // 1. Received a NEW frame that needs ACK (newAccountFrame)
        // 2. Received an ACK (height with prevSignatures) AND we have mempool items
        // 3. Received account transactions that need processing
        const isNewFrame = entityTx.data.newAccountFrame;
        const isAck = entityTx.data.height && entityTx.data.prevSignatures;
        const hasPendingTxs = accountMachine.mempool.length > 0;

        // Only propose if we have something to send:
        // - Need to ACK a new frame
        // - Have transactions in mempool
        if (isNewFrame || (hasPendingTxs && !accountMachine.pendingFrame)) {
          proposableAccounts.add(fromEntity);
          console.log(`🔄 Added ${fromEntity.slice(0,10)} to proposable - NewFrame:${isNewFrame}, Pending:${hasPendingTxs}`);
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
      for (const [counterpartyId, accountMachine] of currentEntityState.accounts) {
        const isLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;
        console.log(`🔍 Checking account ${counterpartyId.slice(0,10)}: mempool=${accountMachine.mempool.length}, isLeft=${isLeft}, pendingFrame=${!!accountMachine.pendingFrame}`);
        if (accountMachine.mempool.length > 0) {
          proposableAccounts.add(counterpartyId);
          console.log(`🔄 ✅ Added ${counterpartyId.slice(0,10)} to proposableAccounts (has ${accountMachine.mempool.length} mempool items)`);
        }
      }
    } else if (entityTx.type === 'openAccount' && entityTx.data) {
      // Account opened - may need initial frame
      const targetEntity = entityTx.data.targetEntityId;
      const accountMachine = currentEntityState.accounts.get(targetEntity);
      if (accountMachine) {
        const isLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;
        if (isLeft) {
          proposableAccounts.add(targetEntity);
          console.log(`🔄 Added ${targetEntity.slice(0,10)} to proposable (new account opened)`);
        }
      }
    }
  }

  // AUTO-PROPOSE: Process all proposable accounts plus any with pending transactions
  console.log(`🚀 AUTO-PROPOSE: Starting bilateral consensus check`);
  console.log(`🚀 Proposable accounts so far: ${Array.from(proposableAccounts).join(', ') || 'none'}`);

  const { getAccountsToProposeFrames, proposeAccountFrame } = await import('./account-consensus');

  // Add accounts with mempool items that weren't already added
  const additionalAccounts = getAccountsToProposeFrames(currentEntityState);
  console.log(`🚀 Additional accounts from getAccountsToProposeFrames: ${additionalAccounts.join(', ') || 'none'}`);
  additionalAccounts.forEach(accountId => proposableAccounts.add(accountId));

  // CRITICAL: Deterministic ordering - sort by counterpartyEntityId (lexicographic)
  const accountsToProposeFrames = Array.from(proposableAccounts).sort();

  if (accountsToProposeFrames.length > 0) {
    console.log(`🔄 AUTO-PROPOSE: ${accountsToProposeFrames.length} accounts need frame proposals`);
    console.log(`🔄 AUTO-PROPOSE: Accounts to propose: ${accountsToProposeFrames.map(id => id.slice(0,10)).join(', ')}`);

    for (const counterpartyEntityId of accountsToProposeFrames) {
      console.log(`🔄 AUTO-PROPOSE: Processing account ${counterpartyEntityId.slice(0,10)}...`);

      const accountMachine = currentEntityState.accounts.get(counterpartyEntityId);
      if (accountMachine) {
        console.log(`🔄 AUTO-PROPOSE: Account details - mempool=${accountMachine.mempool.length}, pendingFrame=${!!accountMachine.pendingFrame}`);
        const proposal = await proposeAccountFrame(env, accountMachine);
        console.log(`🔄 AUTO-PROPOSE: Proposal result - success=${proposal.success}, hasInput=${!!proposal.accountInput}, error=${proposal.error || 'none'}`);

        if (proposal.success && proposal.accountInput) {
          // Get the proposer of the target entity from env
          let targetProposerId = 'alice'; // Default fallback
          const targetReplicaKeys = Array.from(env.replicas.keys()).filter(key => key.startsWith(proposal.accountInput!.toEntityId + ':'));
          if (targetReplicaKeys.length > 0) {
            const firstTargetReplica = env.replicas.get(targetReplicaKeys[0]!);
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

  return { newState: currentEntityState, outputs: allOutputs };
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
