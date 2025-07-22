// === CONSENSUS ENGINE ===

import { Level } from 'level';
import { encode } from './snapshot-coder.js';
import { 
  Env, 
  EntityReplica, 
  EntityInput, 
  ServerInput, 
  EntityTx, 
  EntityState, 
  Proposal, 
  ProposalAction,
  EnvSnapshot 
} from './types.js';
import { createHash } from './crypto-utils.js';

const DEBUG = true;
const db: Level<Buffer, Buffer> = new Level('xln-snapshots', { valueEncoding: 'buffer', keyEncoding: 'binary' });

// Debug logging configuration
const createDebug = (namespace: string) => {
  const shouldLog = namespace.includes('state') || namespace.includes('tx') || 
                   namespace.includes('block') || namespace.includes('error') || 
                   namespace.includes('diff') || namespace.includes('info');
  return shouldLog ? console.log.bind(console, `[${namespace}]`) : () => {};
};

const log = {
  state: createDebug('state:🔵'),
  tx: createDebug('tx:🟡'),
  block: createDebug('block:🟢'),
  error: createDebug('error:🔴'),
  diff: createDebug('diff:🟣'),
  info: createDebug('info:ℹ️')
};

// === UTILITY FUNCTIONS ===
export const calculateQuorumPower = (config: any, signers: string[]): bigint => {
  return signers.reduce((sum, signerId) => sum + (config.shares[signerId] ?? 0n), 0n);
};

export const sortSignatures = (signatures: Map<string, string>, config: any): Map<string, string> => {
  const sortedEntries = Array.from(signatures.entries())
    .sort(([a], [b]) => {
      const indexA = config.validators.indexOf(a);
      const indexB = config.validators.indexOf(b);
      return indexA - indexB;
    });
  return new Map(sortedEntries);
};

export const mergeEntityInputs = (entityInputs: EntityInput[]): EntityInput[] => {
  const merged = new Map<string, EntityInput>();
  let mergeCount = 0;
  
  entityInputs.forEach(input => {
    const key = `${input.entityId}:${input.signerId}`;
    const existing = merged.get(key);
    
    if (existing) {
      mergeCount++;
      if (DEBUG) console.log(`    🔄 Merging inputs for ${key}: txs=${input.entityTxs?.length || 0}, precommits=${input.precommits?.size || 0}, frame=${!!input.proposedFrame}`);
      
      // Merge entityTxs
      if (input.entityTxs?.length) {
        existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
      }
      
      // Merge precommits
      if (input.precommits?.size) {
        if (!existing.precommits) existing.precommits = new Map();
        input.precommits.forEach((value, key) => existing.precommits!.set(key, value));
      }
      
      // Take latest proposedFrame
      if (input.proposedFrame) {
        existing.proposedFrame = input.proposedFrame;
      }
    } else {
      merged.set(key, {
        ...input,
        precommits: input.precommits ? new Map(input.precommits) : undefined
      });
    }
  });
  
  if (DEBUG && mergeCount > 0) {
    console.log(`    ⚠️  CORNER CASE: Merged ${mergeCount} duplicate inputs (${entityInputs.length} → ${merged.size})`);
  }
  
  return Array.from(merged.values());
};

// === PROPOSAL HANDLING ===
const generateProposalId = (action: ProposalAction, proposer: string, entityState: EntityState): string => {
  // Create deterministic hash from proposal data using entity timestamp
  const proposalData = JSON.stringify({
    type: action.type,
    data: action.data,
    proposer,
    timestamp: entityState.timestamp // Deterministic across all validators
  });
  
  const hash = createHash('sha256').update(proposalData).digest('hex');
  return `prop_${hash.slice(0, 12)}`;
};

const executeProposal = (entityState: EntityState, proposal: Proposal): EntityState => {
  if (proposal.action.type === 'collective_message') {
    const message = `[COLLECTIVE] ${proposal.action.data.message}`;
    if (DEBUG) console.log(`    🏛️  Executing collective proposal: "${message}"`);
    
    const newMessages = [...entityState.messages, message];
    
    // Limit messages to 10 maximum
    if (newMessages.length > 10) {
      newMessages.shift(); // Remove oldest message
    }
    
    return {
      ...entityState,
      messages: newMessages
    };
  }
  return entityState;
};

// === ENTITY PROCESSING ===
export const applyEntityTx = (env: Env, entityState: EntityState, entityTx: EntityTx): EntityState => {
  if (entityTx.type === 'chat') {
    const { from, message } = entityTx.data;
    const currentNonce = entityState.nonces.get(from) || 0;
    
    // Create new state (immutable at transaction level)
    const newEntityState = {
      ...entityState,
      nonces: new Map(entityState.nonces),
      messages: [...entityState.messages],
      proposals: new Map(entityState.proposals)
    };
    
    newEntityState.nonces.set(from, currentNonce + 1);
    newEntityState.messages.push(`${from}: ${message}`);
    
    // Limit messages to 10 maximum
    if (newEntityState.messages.length > 10) {
      newEntityState.messages.shift(); // Remove oldest message
    }
    
    return newEntityState;
  }
  
  if (entityTx.type === 'propose') {
    const { action, proposer } = entityTx.data;
    const proposalId = generateProposalId(action, proposer, entityState);
    
    if (DEBUG) console.log(`    📝 Creating proposal ${proposalId} by ${proposer}: ${action.data.message}`);
    
    const proposal: Proposal = {
      id: proposalId,
      proposer,
      action,
      votes: new Map([[proposer, 'yes']]), // Proposer auto-votes yes
      status: 'pending',
      created: entityState.timestamp // Use deterministic entity timestamp
    };
    
    // Check if proposer has enough voting power to execute immediately
    const proposerPower = entityState.config.shares[proposer] || BigInt(0);
    const shouldExecuteImmediately = proposerPower >= entityState.config.threshold;
    
    let newEntityState = {
      ...entityState,
      nonces: new Map(entityState.nonces),
      messages: [...entityState.messages],
      proposals: new Map(entityState.proposals)
    };
    
    if (shouldExecuteImmediately) {
      proposal.status = 'executed';
      newEntityState = executeProposal(newEntityState, proposal);
      if (DEBUG) console.log(`    ⚡ Proposal executed immediately - proposer has ${proposerPower} >= ${entityState.config.threshold} threshold`);
    } else {
      if (DEBUG) console.log(`    ⏳ Proposal pending votes - proposer has ${proposerPower} < ${entityState.config.threshold} threshold`);
    }
    
    newEntityState.proposals.set(proposalId, proposal);
    return newEntityState;
  }
  
  if (entityTx.type === 'vote') {
    const { proposalId, voter, choice } = entityTx.data;
    const proposal = entityState.proposals.get(proposalId);
    
    if (!proposal || proposal.status !== 'pending') {
      if (DEBUG) console.log(`    ❌ Vote ignored - proposal ${proposalId.slice(0, 12)}... not found or not pending`);
      return entityState;
    }
    
    if (DEBUG) console.log(`    🗳️  Vote by ${voter}: ${choice} on proposal ${proposalId.slice(0, 12)}...`);
    
    const newEntityState = {
      ...entityState,
      nonces: new Map(entityState.nonces),
      messages: [...entityState.messages],
      proposals: new Map(entityState.proposals)
    };
    
    const updatedProposal = {
      ...proposal,
      votes: new Map(proposal.votes)
    };
    updatedProposal.votes.set(voter, choice);
    
    // Calculate voting power for 'yes' votes
    const yesVoters = Array.from(updatedProposal.votes.entries())
      .filter(([_, vote]) => vote === 'yes')
      .map(([voter, _]) => voter);
    
    const totalYesPower = calculateQuorumPower(entityState.config, yesVoters);
    
    if (DEBUG) {
      const totalShares = Object.values(entityState.config.shares).reduce((sum, val) => sum + val, BigInt(0));
      const percentage = ((Number(totalYesPower) / Number(entityState.config.threshold)) * 100).toFixed(1);
      log.info(`    🔍 Proposal votes: ${totalYesPower} / ${totalShares} [${percentage}% threshold${Number(totalYesPower) >= Number(entityState.config.threshold) ? '+' : ''}]`);
    }
    
    // Check if threshold reached
    if (totalYesPower >= entityState.config.threshold) {
      updatedProposal.status = 'executed';
      const executedState = executeProposal(newEntityState, updatedProposal);
      executedState.proposals.set(proposalId, updatedProposal);
      return executedState;
    }
    
    newEntityState.proposals.set(proposalId, updatedProposal);
    return newEntityState;
  }
  
  return entityState;
};

export const applyEntityFrame = (env: Env, entityState: EntityState, entityTxs: EntityTx[]): EntityState => {
  return entityTxs.reduce((currentEntityState, entityTx) => applyEntityTx(env, currentEntityState, entityTx), entityState);
};

// === ENTITY INPUT PROCESSING ===
export const processEntityInput = (env: Env, entityReplica: EntityReplica, entityInput: EntityInput): EntityInput[] => {
  // Add validation
  if (!entityReplica) {
    log.error('Invalid entityReplica provided');
    return [];
  }
  if (!entityInput.entityId || !entityInput.signerId) {
    log.error('Invalid entityInput: missing required fields');
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
    // Collect signatures (mutable for performance)
    for (const [signerId, signature] of entityInput.precommits) {
      entityReplica.proposal.signatures.set(signerId, signature);
    }
    if (DEBUG) console.log(`    → Collected ${entityInput.precommits.size} signatures (total: ${entityReplica.proposal.signatures.size})`);
    
    // Check threshold using shares
    const signers = Array.from(entityReplica.proposal.signatures.keys());
    const totalPower = calculateQuorumPower(entityReplica.state.config, signers);
    
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
  
  // Auto-propose logic: ONLY proposer can propose (BFT requirement)
  if (entityReplica.isProposer && entityReplica.mempool.length > 0 && !entityReplica.proposal) {
    if (DEBUG) console.log(`    🚀 Auto-propose triggered: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`);
    // Compute new state once during proposal
    const newEntityState = applyEntityFrame(env, entityReplica.state, entityReplica.mempool);
    
    // Proposer creates new timestamp for this frame
    const newTimestamp = env.timestamp;
    
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

// === MAIN PROCESSING FUNCTION ===
export const processServerInput = (env: Env, serverInput: ServerInput, captureSnapshotFn: (env: Env, serverInput: ServerInput, serverOutputs: EntityInput[], description: string) => void): EntityInput[] => {
  const startTime = Date.now();
  
  // Merge new serverInput into env.serverInput
  env.serverInput.serverTxs.push(...serverInput.serverTxs);
  env.serverInput.entityInputs.push(...serverInput.entityInputs);
  
  // Merge all entityInputs in env.serverInput
  const mergedInputs = mergeEntityInputs(env.serverInput.entityInputs);
  const entityOutbox: EntityInput[] = [];
  
  if (DEBUG) {
    console.log(`\n=== TICK ${env.height} ===`);
    console.log(`Server inputs: ${serverInput.serverTxs.length} new serverTxs, ${serverInput.entityInputs.length} new entityInputs`);
    console.log(`Total in env: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs (merged to ${mergedInputs.length})`);
    if (mergedInputs.length > 0) {
      console.log(`🔄 Processing merged inputs:`);
      mergedInputs.forEach((input, i) => {
        const parts = [];
        if (input.entityTxs?.length) parts.push(`${input.entityTxs.length} txs`);
        if (input.precommits?.size) parts.push(`${input.precommits.size} precommits`);
        if (input.proposedFrame) parts.push(`frame: ${input.proposedFrame.hash.slice(0,10)}...`);
        console.log(`  ${i+1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
      });
    }
  }
  
  // Process server transactions (replica imports) from env.serverInput
  env.serverInput.serverTxs.forEach(serverTx => {
    if (serverTx.type === 'importReplica') {
      if (DEBUG) console.log(`Importing replica ${serverTx.entityId}:${serverTx.signerId} (proposer: ${serverTx.data.isProposer})`);
      
      const replicaKey = `${serverTx.entityId}:${serverTx.signerId}`;
      env.replicas.set(replicaKey, {
        entityId: serverTx.entityId,
        signerId: serverTx.signerId,
        state: {
          height: 0,
          timestamp: env.timestamp,
          nonces: new Map(),
          messages: [],
          proposals: new Map(),
          config: serverTx.data.config
        },
        mempool: [],
        isProposer: serverTx.data.isProposer
      });
    }
  });
  
  // Process entity inputs
  mergedInputs.forEach(entityInput => {
    const replicaKey = `${entityInput.entityId}:${entityInput.signerId}`;
    const entityReplica = env.replicas.get(replicaKey);
    
    if (entityReplica) {
      if (DEBUG) {
        console.log(`Processing input for ${replicaKey}:`);
        if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
        if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
        if (entityInput.precommits?.size) console.log(`  → ${entityInput.precommits.size} precommits`);
      }
      
      const entityOutputs = processEntityInput(env, entityReplica, entityInput);
      entityOutbox.push(...entityOutputs);
    }
  });
  
  // Update env (mutable)
  env.height++;
  env.timestamp = Date.now();
  
  // Capture snapshot BEFORE clearing (to show what was actually processed)
  const inputDescription = `Tick ${env.height - 1}: ${env.serverInput.serverTxs.length} serverTxs, ${env.serverInput.entityInputs.length} entityInputs → ${entityOutbox.length} outputs`;
  const processedInput = {
    serverTxs: [...env.serverInput.serverTxs],
    entityInputs: [...env.serverInput.entityInputs]
  };
  
  // Clear processed data from env.serverInput
  env.serverInput.serverTxs.length = 0;
  env.serverInput.entityInputs.length = 0;
  
  // Capture snapshot with the actual processed input and outputs
  captureSnapshotFn(env, processedInput, entityOutbox, inputDescription);
  
  if (DEBUG && entityOutbox.length > 0) {
    console.log(`📤 Outputs: ${entityOutbox.length} messages`);
    entityOutbox.forEach((output, i) => {
      console.log(`  ${i+1}. → ${output.signerId} (${output.entityTxs ? `${output.entityTxs.length} txs` : ''}${output.proposedFrame ? ` proposal: ${output.proposedFrame.hash.slice(0,10)}...` : ''}${output.precommits ? ` ${output.precommits.size} precommits` : ''})`);
    });
  } else if (DEBUG && entityOutbox.length === 0) {
    console.log(`📤 No outputs generated`);
  }
  
  if (DEBUG) {
    console.log(`Replica states:`);
    env.replicas.forEach((replica, key) => {
      console.log(`  ${key}: mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${replica.proposal ? '✓' : '✗'}`);
    });
  }
  
  // Performance logging
  const endTime = Date.now();
  if (DEBUG) {
    console.log(`⏱️  Tick ${env.height - 1} completed in ${endTime - startTime}ms`);
  }
  
  return entityOutbox;
};

// === DEMO UTILITY ===
export const processUntilEmpty = (env: Env, inputs: EntityInput[], captureSnapshotFn: (env: Env, serverInput: ServerInput, serverOutputs: EntityInput[], description: string) => void) => {
  let outputs = inputs;
  while (outputs.length > 0) {
    outputs = processServerInput(env, { serverTxs: [], entityInputs: outputs }, captureSnapshotFn);
  }
};
