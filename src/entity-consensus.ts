/**
 * XLN Entity Consensus and State Management
 * Core entity processing logic, consensus, proposals, and state transitions
 */

import {
  ConsensusConfig,
  EntityInput,
  EntityTx,
  EntityState,
  ProposedEntityFrame,
  EntityReplica,
  Env,
  JurisdictionConfig,
  Proposal,
  EntityStorage,
} from './types.js';
import { applyEntityTx } from './entity-tx.js';
import { log, DEBUG, formatEntityDisplay, formatSignerDisplay } from './utils.js';

// === HELPER: Persist EntityState in storage ===
async function persistEntityState(storage: EntityStorage, state: EntityState): Promise<void> {
  await storage.set('state', 'height', state.height);
  await storage.set('state', 'timestamp', state.timestamp);
  await storage.set('state', 'messages', state.messages);
  await storage.set('state', 'proposals', state.proposals);
  await storage.set('state', 'nonces', state.nonces);
  await storage.set('state', 'config', state.config);
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
        if (typeof tx.type !== 'string' || !['chat', 'propose', 'vote', 'profile-update'].includes(tx.type)) {
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
 * Process entity input → mempool/proposal/commit
 */
export const applyEntityInput = async (
  env: Env,
  entityReplica: EntityReplica,
  entityInput: EntityInput,
  storage: EntityStorage,
): Promise<EntityInput[]> => {
  const timestamp = Date.now();
  const entityDisplay = formatEntityDisplay(entityInput.entityId);
  const outbox: EntityInput[] = [];

  // Add transactions to mempool using storage
  if (entityInput.entityTxs?.length) {
    if (entityReplica.signerId === 'alice') {
      console.log(`🔥 ALICE-RECEIVES: Alice receiving ${entityInput.entityTxs.length} txs from input`);
      console.log(
        `🔥 ALICE-RECEIVES: Transaction types:`,
        entityInput.entityTxs.map((tx) => tx.type),
      );
      console.log(
        `🔥 ALICE-RECEIVES: Alice isProposer=${entityReplica.isProposer}, current mempool=${entityReplica.mempool.length}`,
      );
    }

    // ✅ Keep mempool only in memory
    for (const tx of entityInput.entityTxs) {
      entityReplica.mempool.push(tx);
    }

    if (DEBUG)
      console.log(
        `    → Added ${entityInput.entityTxs.length} txs to mempool (total: ${entityReplica.mempool.length})`,
      );
    if (DEBUG && entityInput.entityTxs.length > 3) {
      console.log(`    ⚠️  CORNER CASE: Large batch of ${entityInput.entityTxs.length} transactions`);
    }
  } else if (entityInput.entityTxs && entityInput.entityTxs.length === 0) {
    if (DEBUG) console.log(`    ⚠️  CORNER CASE: Empty transaction array received - no mempool changes`);
  }

  // === Commit notification (precommits + proposed frame)
  if (entityInput.precommits?.size && entityInput.proposedFrame) {
    const newHeight = entityReplica.state.height + 1;
    const newState = { ...entityInput.proposedFrame.newState, height: newHeight };

    await persistEntityState(storage, newState);
    await storage.clear('mempool');
    await storage.set('committed', entityInput.proposedFrame.hash, entityInput.proposedFrame);

    const root = await storage.getRoot();
    if (DEBUG) console.log(`🌳 Commit applied, root=${root.slice(0, 16)}...`);

    entityReplica.state = newState; // lightweight in-memory view
    return outbox;
  }

  // === Proposal phase
  if (entityInput.proposedFrame && !entityReplica.proposal) {
    const proposal = entityInput.proposedFrame;
    await storage.set('proposal', proposal.hash, proposal);

    // Add self-signature
    const sig = `sig_${entityReplica.signerId}_${proposal.hash}`;
    proposal.signatures = new Map([[entityReplica.signerId, sig]]);

    entityReplica.proposal = proposal; // in-memory reference for compatibility

    if (DEBUG) console.log(`→ Stored proposal ${proposal.hash}`);
  }

  // === Precommit phase
  if (entityInput.precommits?.size && entityReplica.proposal) {
    for (const [signer, sig] of entityInput.precommits) {
      entityReplica.proposal.signatures.set(signer, sig);
    }

    const totalPower = calculateQuorumPower(
      entityReplica.state.config,
      Array.from(entityReplica.proposal.signatures.keys()),
    );
    if (totalPower >= entityReplica.state.config.threshold) {
      const committedState = await commitFrame(entityReplica, storage);
      entityReplica.state = committedState;
      entityReplica.proposal = undefined;
      await storage.clear('mempool');

      if (DEBUG) console.log(`→ Threshold reached, committed frame at height ${committedState.height}`);
    }
  }

  // === Auto-propose (only proposer, if mempool not empty)
  if (entityReplica.isProposer && !entityReplica.proposal) {
    const mempoolTxs = entityReplica.mempool.slice(); // Use in-memory mempool
    if (mempoolTxs.length > 0) {
      const newState = await applyEntityFrame(env, entityReplica.state, mempoolTxs, storage);
      const frameHash = `frame_${entityReplica.state.height + 1}_${timestamp}`;
      const sig = `sig_${entityReplica.signerId}_${frameHash}`;

      const proposal: ProposedEntityFrame = {
        height: entityReplica.state.height + 1,
        txs: mempoolTxs,
        hash: frameHash,
        newState,
        signatures: new Map([[entityReplica.signerId, sig]]),
      };

      await storage.set('proposal', frameHash, proposal);
      entityReplica.proposal = proposal;

      // Clear mempool after proposing
      entityReplica.mempool.length = 0;

      if (DEBUG) console.log(`🚀 Auto-proposed frame ${frameHash}`);
    }
  }

  return outbox;
};

/**
 * Apply a batch of txs to entity state
 */
export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
  storage: EntityStorage,
): Promise<EntityState> => {
  let state = entityState;
  for (const tx of entityTxs) {
    state = await applyEntityTx(env, state, tx, storage);
  }
  await persistEntityState(storage, state);
  const root = await storage.getRoot();
  if (DEBUG) console.log(`🌳 Frame applied, root=${root.slice(0, 16)}...`);
  return state;
};

/**
 * Commit a frame → confirm proposal and persist final state
 */
export const commitFrame = async (entityReplica: EntityReplica, storage: EntityStorage): Promise<EntityState> => {
  if (!entityReplica.proposal) throw new Error('No proposal to commit');

  const newHeight = entityReplica.state.height + 1;
  const newState = { ...entityReplica.proposal.newState, height: newHeight };

  await persistEntityState(storage, newState);
  const root = await storage.getRoot();
  if (DEBUG) console.log(`🌳 Frame committed, root=${root.slice(0, 16)}...`);

  return newState;
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
export const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint =>
  signers.reduce((total, s) => total + (config.shares[s] || 0n), 0n);

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
  const timestamp = Date.now();

  // Always log input count for debugging with detailed breakdown
  console.log(`🔍 MERGE-START: [${timestamp}] Processing ${inputs.length} entity inputs for merging`);

  // Pre-analysis: Show all inputs before merging to identify potential Carol duplicates
  const inputAnalysis = inputs.map((input, i) => {
    const entityShort = input.entityId.slice(0, 10);
    const frameHash = input.proposedFrame?.hash?.slice(0, 10) || 'none';
    const precommitCount = input.precommits?.size || 0;
    const precommitSigners = input.precommits ? Array.from(input.precommits.keys()).join(',') : 'none';
    return `${i + 1}:${entityShort}:${input.signerId}(txs=${input.entityTxs?.length || 0},pc=${precommitCount}[${precommitSigners}],f=${frameHash})`;
  });
  console.log(`🔍 MERGE-INPUTS: ${inputAnalysis.join(' | ')}`);

  // Look for potential Carol duplicates specifically
  const carolInputs = inputs.filter((input) => input.signerId.includes('carol'));
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
