/**
 * XLN Entity Consensus and State Management
 * Core entity processing logic, consensus, proposals, and state transitions
 */

import { 
  ConsensusConfig, EntityInput, EntityTx, EntityState, ProposedEntityFrame, 
  EntityReplica, Env, JurisdictionConfig, Proposal 
} from './types.js';
import { applyEntityTx } from './entity-tx.js';
import { log, DEBUG } from './utils.js';

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
          log.error(`❌ Invalid transaction: ${JSON.stringify(tx)}`);
          return false;
        }
        if (typeof tx.type !== 'string' || !['chat', 'propose', 'vote'].includes(tx.type)) {
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
export const applyEntityInput = (env: Env, entityReplica: EntityReplica, entityInput: EntityInput): EntityInput[] => {
  // SECURITY: Validate all inputs
  if (!validateEntityInput(entityInput)) {
    log.error(`❌ Invalid input for ${entityInput.entityId}:${entityInput.signerId}`);
    return [];
  }
  if (!validateEntityReplica(entityReplica)) {
    log.error(`❌ Invalid replica state for ${entityReplica.entityId}:${entityReplica.signerId}`);
    return [];
  }
  
  const entityOutbox: EntityInput[] = [];
  
  // Add transactions to mempool (mutable for performance)
  if (entityInput.entityTxs?.length) {
    entityReplica.mempool.push(...entityInput.entityTxs);
    if (DEBUG) console.log(`    → Added ${entityInput.entityTxs.length} txs to mempool (total: ${entityReplica.mempool.length})`);
    if (DEBUG && entityInput.entityTxs.length > 3) {
      console.log(`    ⚠️  CORNER CASE: Large batch of ${entityInput.entityTxs.length} transactions`);
    }
  } else if (entityInput.entityTxs && entityInput.entityTxs.length === 0) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Empty transaction array received - no mempool changes`);
  }
  
  // Handle commit notifications FIRST (when receiving finalized frame from proposer)
  if (entityInput.precommits?.size && entityInput.proposedFrame && !entityReplica.proposal) {
    const signers = Array.from(entityInput.precommits.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);
    
    if (totalPower >= entityReplica.state.config.threshold) {
      // This is a commit notification from proposer, apply the frame
      if (DEBUG) console.log(`    → Received commit notification with ${entityInput.precommits.size} signatures`);
      
      // Apply the committed frame with incremented height
      entityReplica.state = {
        ...entityInput.proposedFrame.newState,
        height: entityReplica.state.height + 1
      };
      entityReplica.mempool.length = 0;
      entityReplica.lockedFrame = undefined; // Release lock after commit
      if (DEBUG) console.log(`    → Applied commit, new state: ${entityReplica.state.messages.length} messages, height: ${entityReplica.state.height}`);
      
      // Return early - commit notifications don't trigger further processing
      return entityOutbox;
    }
  }
  
  // Handle proposed frame (PROPOSE phase) - only if not a commit notification
  if (entityInput.proposedFrame && (!entityReplica.proposal || 
      (entityReplica.state.config.mode === 'gossip-based' && entityReplica.isProposer))) {
    const frameSignature = `sig_${entityReplica.signerId}_${entityInput.proposedFrame.hash}`;
    const config = entityReplica.state.config;
    
    // Lock to this frame (CometBFT style)
    entityReplica.lockedFrame = entityInput.proposedFrame;
    if (DEBUG) console.log(`    → Validator locked to frame ${entityInput.proposedFrame.hash.slice(0,10)}...`);
    
    if (config.mode === 'gossip-based') {
      // Send precommit to all validators
      config.validators.forEach(validatorId => {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          precommits: new Map([[entityReplica.signerId, frameSignature]])
        });
      });
      if (DEBUG) console.log(`    → Signed proposal, gossiping precommit to ${config.validators.length} validators`);
    } else {
      // Send precommit to proposer only
      const proposerId = config.validators[0];
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: proposerId,
        precommits: new Map([[entityReplica.signerId, frameSignature]])
      });
      if (DEBUG) console.log(`    → Signed proposal, sending precommit to ${proposerId}`);
    }
  }
  
  // Handle precommits (SIGN phase) 
  if (entityInput.precommits?.size && entityReplica.proposal) {
    // SECURITY: Check for Byzantine faults before collecting signatures
    for (const [signerId, signature] of entityInput.precommits) {
      if (detectByzantineFault(entityReplica.proposal.signatures, signerId, signature)) {
        log.error(`❌ Rejecting Byzantine input from ${signerId}`);
        return entityOutbox; // Return early, don't process malicious input
      }
      entityReplica.proposal.signatures.set(signerId, signature);
    }
    if (DEBUG) console.log(`    → Collected ${entityInput.precommits.size} signatures (total: ${entityReplica.proposal.signatures.size})`);
    
    // Check threshold using shares
    const signers = Array.from(entityReplica.proposal.signatures.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);
    
    // SECURITY: Validate voting power
    if (!validateVotingPower(totalPower)) {
      log.error(`❌ Invalid voting power calculation: ${totalPower}`);
      return entityOutbox;
    }
    
    if (DEBUG) {
      const totalShares = Object.values(entityReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalPower) / Number(entityReplica.state.config.threshold)) * 100).toFixed(1);
      log.info(`    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(entityReplica.state.config.threshold) ? '+' : ''}]`);
      if (entityReplica.state.config.mode === 'gossip-based') {
        console.log(`    ⚠️  CORNER CASE: Gossip mode - all validators receive precommits`);
      }
    }
    
    if (totalPower >= entityReplica.state.config.threshold) {
      // Commit phase - use pre-computed state with incremented height
      entityReplica.state = {
        ...entityReplica.proposal.newState,
        height: entityReplica.state.height + 1
      };
      if (DEBUG) console.log(`    → Threshold reached! Committing frame, height: ${entityReplica.state.height}`);
      
      // Save proposal data before clearing
      const sortedSignatures = sortSignatures(entityReplica.proposal.signatures, entityReplica.state.config);
      const committedFrame = entityReplica.proposal;
      
      // Clear state (mutable)
      entityReplica.mempool.length = 0;
      entityReplica.proposal = undefined;
      entityReplica.lockedFrame = undefined; // Release lock after commit
      
      // Notify all validators
      entityReplica.state.config.validators.forEach(validatorId => {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          precommits: sortedSignatures,
          proposedFrame: committedFrame
        });
      });
      if (DEBUG) console.log(`    → Sending commit notifications to ${entityReplica.state.config.validators.length} validators`);
    }
  }
  
  // Commit notifications are now handled at the top of the function
  
  // Auto-propose logic: ONLY proposer can propose (BFT requirement)
  if (entityReplica.isProposer && entityReplica.mempool.length > 0 && !entityReplica.proposal) {
    if (DEBUG) console.log(`    🚀 Auto-propose triggered: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`);
    // Compute new state once during proposal
    const newEntityState = applyEntityFrame(env, entityReplica.state, entityReplica.mempool);
    
    // Proposer creates new timestamp for this frame
    const newTimestamp = env.timestamp;
    
    // SECURITY: Validate timestamp
    if (!validateTimestamp(newTimestamp, Date.now())) {
      log.error(`❌ Invalid proposal timestamp: ${newTimestamp}`);
      return entityOutbox;
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
        timestamp: newTimestamp // Set new deterministic timestamp in proposed state
      },
      signatures: new Map<string, string>([[entityReplica.signerId, selfSignature]]) // Proposer signs immediately
    };
    
    if (DEBUG) console.log(`    → Auto-proposing frame ${entityReplica.proposal.hash} with ${entityReplica.proposal.txs.length} txs and self-signature.`);
    
    // Send proposal to all validators (except self)
    entityReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== entityReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: entityReplica.proposal!
          // Note: Don't send entityTxs separately - they're already in proposedFrame.txs
        });
      }
    });
  } else if (entityReplica.isProposer && entityReplica.mempool.length === 0 && !entityReplica.proposal) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Proposer with empty mempool - no auto-propose`);
  } else if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
    if (DEBUG) console.log(`    → Non-proposer sending ${entityReplica.mempool.length} txs to proposer`);
    // Send mempool to proposer
    const proposerId = entityReplica.state.config.validators[0];
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...entityReplica.mempool]
    });
    // Clear mempool after sending
    entityReplica.mempool.length = 0;
  } else if (entityReplica.isProposer && entityReplica.proposal) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Proposer already has pending proposal - no new auto-propose`);
  }
  
  return entityOutbox;
};

export const applyEntityFrame = (env: Env, entityState: EntityState, entityTxs: EntityTx[]): EntityState => {
  return entityTxs.reduce((currentEntityState, entityTx) => applyEntityTx(env, currentEntityState, entityTx), entityState);
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
export const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint => {
  return signers.reduce((total, signerId) => {
    return total + (config.shares[signerId] || 0n);
  }, 0n);
};

export const sortSignatures = (signatures: Map<string, string>, config: ConsensusConfig): Map<string, string> => {
  const sortedEntries = Array.from(signatures.entries())
    .sort(([a], [b]) => {
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

  for (const input of inputs) {
    const key = `${input.entityId}:${input.signerId}`;
    
    if (merged.has(key)) {
      const existing = merged.get(key)!;
      duplicateCount++;
      
      // Merge entity transactions
      if (input.entityTxs) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
      }
      
      // Merge precommits
      if (input.precommits) {
        const existingPrecommits = existing.precommits || new Map();
        input.precommits.forEach((signature, signerId) => {
          existingPrecommits.set(signerId, signature);
        });
        existing.precommits = existingPrecommits;
      }
      
      // Keep the latest frame (simplified)
      if (input.proposedFrame) existing.proposedFrame = input.proposedFrame;
      
      console.log(`    🔄 Merging inputs for ${key}: txs=${input.entityTxs?.length || 0}, precommits=${input.precommits?.size || 0}, frame=${!!input.proposedFrame}`);
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
export const shouldAutoPropose = (replica: EntityReplica, config: ConsensusConfig): boolean => {
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