/**
 * XLN Entity Consensus and State Management
 * Core entity processing logic, consensus, proposals, and state transitions
 */
import { applyEntityTx } from './entity-tx';
import { DEBUG, formatEntityDisplay, formatSignerDisplay, log } from './utils';
import { logger } from './logger';
import { entityChannelManager } from './entity-channel';
// === SECURITY VALIDATION ===
/**
 * Validates entity input to prevent malicious or corrupted data
 */
const validateEntityInput = (input) => {
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
                if (typeof tx.type !== 'string' ||
                    !['chat', 'propose', 'vote', 'profile-update', 'j_event', 'accountInput', 'openAccount'].includes(tx.type)) {
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
    }
    catch (error) {
        log.error(`❌ Input validation error: ${error}`);
        return false;
    }
};
/**
 * Validates entity replica to prevent corrupted state
 */
const validateEntityReplica = (replica) => {
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
    }
    catch (error) {
        log.error(`❌ Replica validation error: ${error}`);
        return false;
    }
};
/**
 * Detects Byzantine faults like double-signing
 */
const detectByzantineFault = (signatures, signerId, newSignature) => {
    try {
        const existingSig = signatures.get(signerId);
        if (existingSig && existingSig !== newSignature) {
            log.error(`❌ BYZANTINE FAULT: Double-sign detected from ${signerId}`);
            log.error(`❌ Existing: ${existingSig}`);
            log.error(`❌ New: ${newSignature}`);
            return true;
        }
        return false;
    }
    catch (error) {
        log.error(`❌ Byzantine detection error: ${error}`);
        return false;
    }
};
/**
 * Validates timestamp to prevent temporal attacks
 */
const validateTimestamp = (proposedTime, currentTime) => {
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
    }
    catch (error) {
        log.error(`❌ Timestamp validation error: ${error}`);
        return false;
    }
};
/**
 * Validates voting power to prevent overflow attacks
 */
const validateVotingPower = (power) => {
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
    }
    catch (error) {
        log.error(`❌ Voting power validation error: ${error}`);
        return false;
    }
};
// === CORE ENTITY PROCESSING ===
/**
 * Main entity input processor - handles consensus, proposals, and state transitions
 */
export const applyEntityInput = async (env, entityReplica, entityInput) => {
    // Debug: Log every input being processed with timestamp and unique identifier
    const entityDisplay = formatEntityDisplay(entityInput.entityId);
    const timestamp = Date.now();
    const currentProposalHash = entityReplica.proposal?.hash?.slice(0, 10) || 'none';
    const frameHash = entityInput.proposedFrame?.hash?.slice(0, 10) || 'none';
    logger.consensus(`INPUT-RECEIVED: [${timestamp}] Processing input for Entity #${entityDisplay}:${formatSignerDisplay(entityInput.signerId)}`, { entityId: entityInput.entityId, signerId: entityInput.signerId });
    logger.consensus(`INPUT-STATE: Current proposal: ${currentProposalHash}, Mempool: ${entityReplica.mempool.length}, isProposer: ${entityReplica.isProposer}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, mempoolSize: entityReplica.mempool.length });
    logger.consensus(`INPUT-DETAILS: txs=${entityInput.entityTxs?.length || 0}, precommits=${entityInput.precommits?.size || 0}, frame=${frameHash}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, txCount: entityInput.entityTxs?.length || 0, precommitCount: entityInput.precommits?.size || 0 });
    if (entityInput.precommits?.size) {
        const precommitSigners = Array.from(entityInput.precommits.keys());
        logger.consensus(`INPUT-PRECOMMITS: Received precommits from: ${precommitSigners.join(', ')}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, precommitSigners });
        // Track exactly which proposal these precommits are for
        const firstPrecommit = entityInput.precommits.values().next().value;
        const proposalHashFromSig = firstPrecommit ? firstPrecommit.split('_')[2]?.slice(0, 10) : 'unknown';
        logger.consensus(`PRECOMMIT-PROPOSAL: These precommits are for proposal: ${proposalHashFromSig}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, proposalHash: proposalHashFromSig });
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
    const entityOutbox = [];
    // Add transactions to mempool (mutable for performance)
    if (entityInput.entityTxs?.length) {
        // DEBUG: Track vote transactions specifically
        const voteTransactions = entityInput.entityTxs.filter(tx => tx.type === 'vote');
        if (voteTransactions.length > 0) {
            logger.consensus(`VOTE-MEMPOOL: ${entityReplica.signerId} receiving ${voteTransactions.length} vote transactions`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, voteCount: voteTransactions.length });
            voteTransactions.forEach(tx => {
                logger.consensus(`VOTE-TX: ${JSON.stringify(tx)}`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, transactionType: tx.type });
            });
        }
        if (entityReplica.signerId === 'alice') {
            logger.consensus(`ALICE-RECEIVES: Alice receiving ${entityInput.entityTxs.length} txs from input`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, txCount: entityInput.entityTxs.length });
            logger.consensus(`ALICE-RECEIVES: Transaction types: ${entityInput.entityTxs.map(tx => tx.type).join(', ')}`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, transactionTypes: entityInput.entityTxs.map(tx => tx.type) });
            logger.consensus(`ALICE-RECEIVES: Alice isProposer=${entityReplica.isProposer}, current mempool=${entityReplica.mempool.length}`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, isProposer: entityReplica.isProposer, mempoolSize: entityReplica.mempool.length });
        }
        entityReplica.mempool.push(...entityInput.entityTxs);
        if (DEBUG)
            logger.debug(`Added ${entityInput.entityTxs.length} txs to mempool (total: ${entityReplica.mempool.length})`, { entityId: entityInput.entityId, signerId: entityInput.signerId, addedTxs: entityInput.entityTxs.length, totalMempool: entityReplica.mempool.length });
        if (DEBUG && entityInput.entityTxs.length > 3) {
            logger.warn(`CORNER CASE: Large batch of ${entityInput.entityTxs.length} transactions`, { entityId: entityInput.entityId, signerId: entityInput.signerId, txCount: entityInput.entityTxs.length });
        }
    }
    else if (entityInput.entityTxs && entityInput.entityTxs.length === 0) {
        if (DEBUG)
            logger.warn(`CORNER CASE: Empty transaction array received - no mempool changes`, { entityId: entityInput.entityId, signerId: entityInput.signerId });
    }
    // CRITICAL: Forward transactions to proposer BEFORE processing commits
    // This prevents race condition where commits clear mempool before forwarding
    if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
        if (DEBUG)
            logger.debug(`Non-proposer sending ${entityReplica.mempool.length} txs to proposer`, { entityId: entityInput.entityId, signerId: entityInput.signerId, mempoolSize: entityReplica.mempool.length });
        // Send mempool to proposer through bilateral channel
        const proposerId = entityReplica.state.config.validators[0];
        logger.consensus(`BOB-TO-ALICE: Bob sending ${entityReplica.mempool.length} txs to proposer ${proposerId} via bilateral channel`, { entityId: entityInput.entityId, signerId: entityInput.signerId, proposerId, mempoolSize: entityReplica.mempool.length });
        logger.consensus(`BOB-TO-ALICE: Transaction types: ${entityReplica.mempool.map(tx => tx.type).join(', ')}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, transactionTypes: entityReplica.mempool.map(tx => tx.type) });
        // USE BILATERAL CHANNEL instead of global routing
        entityChannelManager.sendMessage(entityInput.entityId, // from entity
        entityInput.entityId, // to same entity (different signer)
        proposerId, // target signer
        [...entityReplica.mempool]);
        // Still push to outbox for backward compatibility during transition
        entityOutbox.push({
            entityId: entityInput.entityId,
            signerId: proposerId,
            entityTxs: [...entityReplica.mempool],
        });
        // Clear mempool after sending
        entityReplica.mempool.length = 0;
    }
    // Handle commit notifications AFTER forwarding (when receiving finalized frame from proposer)
    if (entityInput.precommits?.size && entityInput.proposedFrame && !entityReplica.proposal) {
        const signers = Array.from(entityInput.precommits.keys());
        const totalPower = calculateQuorumPower(entityReplica.state.config, signers);
        if (totalPower >= entityReplica.state.config.threshold) {
            // This is a commit notification from proposer, apply the frame
            if (DEBUG)
                logger.debug(`Received commit notification with ${entityInput.precommits.size} signatures`, { entityId: entityInput.entityId, signerId: entityInput.signerId, precommitCount: entityInput.precommits.size });
            // Apply the committed frame with incremented height
            entityReplica.state = {
                ...entityInput.proposedFrame.newState,
                height: entityReplica.state.height + 1,
            };
            entityReplica.mempool.length = 0;
            entityReplica.lockedFrame = undefined; // Release lock after commit
            if (DEBUG)
                logger.debug(`Applied commit, new state: ${entityReplica.state.messages.length} messages, height: ${entityReplica.state.height}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, messageCount: entityReplica.state.messages.length, height: entityReplica.state.height });
            // Return early - commit notifications don't trigger further processing
            return { newState: entityReplica.state, outputs: entityOutbox };
        }
    }
    // Handle proposed frame (PROPOSE phase) - only if not a commit notification
    if (entityInput.proposedFrame &&
        (!entityReplica.proposal || (entityReplica.state.config.mode === 'gossip-based' && entityReplica.isProposer))) {
        const frameSignature = `sig_${entityReplica.signerId}_${entityInput.proposedFrame.hash}`;
        const config = entityReplica.state.config;
        // Lock to this frame (CometBFT style)
        entityReplica.lockedFrame = entityInput.proposedFrame;
        if (DEBUG)
            logger.debug(`Validator locked to frame ${entityInput.proposedFrame.hash.slice(0, 10)}...`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, frameHash: entityInput.proposedFrame.hash.slice(0, 10) });
        if (config.mode === 'gossip-based') {
            // Send precommit to all validators except self
            config.validators.forEach(validatorId => {
                if (validatorId !== entityReplica.signerId) {
                    logger.consensus(`GOSSIP: [${timestamp}] ${entityReplica.signerId} sending precommit to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${frameHash}, sig: ${frameSignature.slice(0, 20)}...`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, targetValidator: validatorId, proposalHash: frameHash });
                    // Send via bilateral channel
                    entityChannelManager.sendMessage(entityInput.entityId, entityInput.entityId, validatorId, [] // No transactions, just sending precommit via metadata
                    );
                    // Keep outbox for backward compatibility
                    entityOutbox.push({
                        entityId: entityInput.entityId,
                        signerId: validatorId,
                        precommits: new Map([[entityReplica.signerId, frameSignature]]),
                    });
                }
            });
            if (DEBUG)
                logger.debug(`Signed proposal, gossiping precommit to ${config.validators.filter(v => v !== entityReplica.signerId).length} validators`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, validatorCount: config.validators.filter(v => v !== entityReplica.signerId).length });
        }
        else {
            // Send precommit to proposer only
            const proposerId = config.validators[0];
            logger.consensus(`PROPOSER: [${timestamp}] ${entityReplica.signerId} sending precommit to ${proposerId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${frameHash}, sig: ${frameSignature.slice(0, 20)}...`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, proposerId, proposalHash: frameHash });
            logger.consensus(`PROPOSER-REASON: Signed new proposal, current state: proposal=${currentProposalHash}, locked=${entityReplica.lockedFrame?.hash?.slice(0, 10) || 'none'}`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, currentProposal: currentProposalHash, lockedFrame: entityReplica.lockedFrame?.hash?.slice(0, 10) });
            // Send via bilateral channel
            entityChannelManager.sendMessage(entityInput.entityId, entityInput.entityId, proposerId, [] // No transactions, just sending precommit via metadata
            );
            // Keep outbox for backward compatibility
            entityOutbox.push({
                entityId: entityInput.entityId,
                signerId: proposerId,
                precommits: new Map([[entityReplica.signerId, frameSignature]]),
            });
            if (DEBUG)
                logger.debug(`Signed proposal, sending precommit to ${proposerId}`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, proposerId });
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
            logger.debug(`Collected ${entityInput.precommits.size} signatures (total: ${entityReplica.proposal.signatures.size})`, { entityId: entityInput.entityId, signerId: entityInput.signerId, newSignatures: entityInput.precommits.size, totalSignatures: entityReplica.proposal.signatures.size });
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
            logger.info(`Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(entityReplica.state.config.threshold) ? '+' : ''}]`, { entityId: entityInput.entityId, signerId: entityInput.signerId, totalPower: Number(totalPower), totalShares: Number(totalShares), percentage });
            if (entityReplica.state.config.mode === 'gossip-based') {
                logger.warn(`CORNER CASE: Gossip mode - all validators receive precommits`, { entityId: entityInput.entityId, signerId: entityInput.signerId });
            }
        }
        if (totalPower >= entityReplica.state.config.threshold) {
            // Commit phase - use pre-computed state with incremented height
            entityReplica.state = {
                ...entityReplica.proposal.newState,
                height: entityReplica.state.height + 1,
            };
            if (DEBUG)
                logger.debug(`Threshold reached! Committing frame, height: ${entityReplica.state.height}`, { entityId: entityInput.entityId, signerId: entityInput.signerId, height: entityReplica.state.height });
            // Save proposal data before clearing
            const sortedSignatures = sortSignatures(entityReplica.proposal.signatures, entityReplica.state.config);
            const committedFrame = entityReplica.proposal;
            // Clear state (mutable)
            entityReplica.mempool.length = 0;
            entityReplica.proposal = undefined;
            entityReplica.lockedFrame = undefined; // Release lock after commit
            // Only send commit notifications in proposer-based mode
            // In gossip mode, everyone already has all precommits via gossip
            if (entityReplica.state.config.mode === 'proposer-based') {
                const committedProposalHash = committedFrame.hash.slice(0, 10);
                logger.consensus(`COMMIT-START: [${timestamp}] ${entityReplica.signerId} reached threshold for proposal ${committedProposalHash}, sending commit notifications...`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, proposalHash: committedProposalHash });
                // Notify all validators (except self - proposer already has all precommits)
                entityReplica.state.config.validators.forEach(validatorId => {
                    if (validatorId !== entityReplica.signerId) {
                        const precommitSigners = Array.from(sortedSignatures.keys());
                        logger.consensus(`COMMIT: [${timestamp}] ${entityReplica.signerId} sending commit notification to ${validatorId} for entity ${entityInput.entityId.slice(0, 10)}, proposal ${committedProposalHash} (${sortedSignatures.size} precommits from: ${precommitSigners.join(', ')})`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, targetValidator: validatorId, proposalHash: committedProposalHash, precommitCount: sortedSignatures.size, precommitSigners });
                        // Send commit notification via bilateral channel
                        entityChannelManager.sendMessage(entityInput.entityId, entityInput.entityId, validatorId, [] // Commit info in metadata
                        );
                        // Keep outbox for backward compatibility
                        entityOutbox.push({
                            entityId: entityInput.entityId,
                            signerId: validatorId,
                            precommits: sortedSignatures,
                            proposedFrame: committedFrame,
                        });
                    }
                });
                const notifiedCount = entityReplica.state.config.validators.length - 1; // excluding self
                if (DEBUG)
                    logger.debug(`Sending commit notifications to ${notifiedCount} validators (excluding self)`, { entityId: entityInput.entityId, signerId: entityReplica.signerId, notifiedCount });
            }
            else {
                logger.consensus(`GOSSIP-COMMIT: [${timestamp}] ${entityReplica.signerId} NOT sending commit notifications (gossip mode) for entity ${entityInput.entityId.slice(0, 10)}...`, { entityId: entityInput.entityId, signerId: entityReplica.signerId });
                if (DEBUG)
                    logger.debug(`Gossip mode: No commit notifications needed (everyone has precommits via gossip)`, { entityId: entityInput.entityId, signerId: entityReplica.signerId });
            }
        }
    }
    // Commit notifications are now handled at the top of the function
    // Debug consensus trigger conditions
    logger.consensus(`CONSENSUS-CHECK: Entity ${entityReplica.entityId}:${entityReplica.signerId}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId });
    logger.consensus(`  isProposer: ${entityReplica.isProposer}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, isProposer: entityReplica.isProposer });
    logger.consensus(`  mempool.length: ${entityReplica.mempool.length}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, mempoolSize: entityReplica.mempool.length });
    logger.consensus(`  hasProposal: ${!!entityReplica.proposal}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, hasProposal: !!entityReplica.proposal });
    if (entityReplica.mempool.length > 0) {
        logger.consensus(`  mempoolTypes: ${entityReplica.mempool.map(tx => tx.type).join(', ')}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, mempoolTypes: entityReplica.mempool.map(tx => tx.type) });
    }
    // Auto-propose logic: ONLY proposer can propose (BFT requirement)
    if (entityReplica.isProposer && entityReplica.mempool.length > 0 && !entityReplica.proposal) {
        logger.consensus(`ALICE-PROPOSES: Alice auto-propose triggered!`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId });
        logger.consensus(`ALICE-PROPOSES: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, mempoolSize: entityReplica.mempool.length, isProposer: entityReplica.isProposer, hasProposal: !!entityReplica.proposal });
        logger.consensus(`ALICE-PROPOSES: Mempool transaction types: ${entityReplica.mempool.map(tx => tx.type).join(', ')}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, transactionTypes: entityReplica.mempool.map(tx => tx.type) });
        // Check if this is a single signer entity (threshold = 1, only 1 validator)
        const isSingleSigner = entityReplica.state.config.validators.length === 1 && entityReplica.state.config.threshold === BigInt(1);
        if (isSingleSigner) {
            logger.consensus(`SINGLE-SIGNER: Direct execution without consensus for single signer entity`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId });
            // For single signer entities, directly apply transactions without consensus
            const { newState: newEntityState, outputs: frameOutputs } = await applyEntityFrame(env, entityReplica.state, entityReplica.mempool);
            entityReplica.state = {
                ...newEntityState,
                height: entityReplica.state.height + 1,
            };
            // Add any outputs generated by entity transactions to the outbox
            entityOutbox.push(...frameOutputs);
            // Clear mempool after direct application
            entityReplica.mempool.length = 0;
            if (DEBUG)
                logger.debug(`Single signer entity: transactions applied directly, height: ${entityReplica.state.height}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, height: entityReplica.state.height });
            return { newState: entityReplica.state, outputs: entityOutbox }; // Skip the full consensus process
        }
        if (DEBUG)
            logger.debug(`Auto-propose triggered: mempool=${entityReplica.mempool.length}, isProposer=${entityReplica.isProposer}, hasProposal=${!!entityReplica.proposal}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, mempoolSize: entityReplica.mempool.length, isProposer: entityReplica.isProposer, hasProposal: !!entityReplica.proposal });
        // Compute new state once during proposal
        const { newState: newEntityState, outputs: proposalOutputs } = await applyEntityFrame(env, entityReplica.state, entityReplica.mempool);
        // Add any outputs generated during proposal to the outbox
        entityOutbox.push(...proposalOutputs);
        // Proposer creates new timestamp for this frame (always use current time for new proposals)
        const newTimestamp = Date.now();
        // SECURITY: Validate timestamp
        if (!validateTimestamp(newTimestamp, Date.now())) {
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
            signatures: new Map([[entityReplica.signerId, selfSignature]]), // Proposer signs immediately
        };
        if (DEBUG)
            logger.debug(`Auto-proposing frame ${entityReplica.proposal.hash} with ${entityReplica.proposal.txs.length} txs and self-signature.`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, frameHash: entityReplica.proposal.hash, txCount: entityReplica.proposal.txs.length });
        // Send proposal to all validators (except self)
        entityReplica.state.config.validators.forEach(validatorId => {
            if (validatorId !== entityReplica.signerId) {
                entityOutbox.push({
                    entityId: entityInput.entityId,
                    signerId: validatorId,
                    proposedFrame: entityReplica.proposal,
                    // Note: Don't send entityTxs separately - they're already in proposedFrame.txs
                });
            }
        });
    }
    else if (entityReplica.isProposer && entityReplica.mempool.length === 0 && !entityReplica.proposal) {
        if (DEBUG)
            logger.warn(`CORNER CASE: Proposer with empty mempool - no auto-propose`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId });
    }
    else if (!entityReplica.isProposer && entityReplica.mempool.length > 0) {
        if (DEBUG)
            logger.debug(`Non-proposer sending ${entityReplica.mempool.length} txs to proposer`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, mempoolSize: entityReplica.mempool.length });
        // Send mempool to proposer
        const proposerId = entityReplica.state.config.validators[0];
        logger.consensus(`BOB-TO-ALICE: Bob sending ${entityReplica.mempool.length} txs to proposer ${proposerId}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, proposerId, mempoolSize: entityReplica.mempool.length });
        logger.consensus(`BOB-TO-ALICE: Transaction types: ${entityReplica.mempool.map(tx => tx.type).join(', ')}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, transactionTypes: entityReplica.mempool.map(tx => tx.type) });
        entityOutbox.push({
            entityId: entityInput.entityId,
            signerId: proposerId,
            entityTxs: [...entityReplica.mempool],
        });
        // Clear mempool after sending
        entityReplica.mempool.length = 0;
    }
    else if (entityReplica.isProposer && entityReplica.proposal) {
        if (DEBUG)
            logger.warn(`CORNER CASE: Proposer already has pending proposal - no new auto-propose`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId });
    }
    // Debug: Log outputs being generated with detailed analysis
    logger.consensus(`OUTPUT-GENERATED: [${timestamp}] Entity #${entityDisplay}:${formatSignerDisplay(entityReplica.signerId)} generating ${entityOutbox.length} outputs`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, outputCount: entityOutbox.length });
    logger.consensus(`OUTPUT-FINAL-STATE: proposal=${entityReplica.proposal?.hash?.slice(0, 10) || 'none'}, mempool=${entityReplica.mempool.length}, locked=${entityReplica.lockedFrame?.hash?.slice(0, 10) || 'none'}`, { entityId: entityReplica.entityId, signerId: entityReplica.signerId, proposalHash: entityReplica.proposal?.hash?.slice(0, 10), mempoolSize: entityReplica.mempool.length, lockedFrame: entityReplica.lockedFrame?.hash?.slice(0, 10) });
    entityOutbox.forEach((output, index) => {
        const targetDisplay = formatEntityDisplay(output.entityId);
        const outputFrameHash = output.proposedFrame?.hash?.slice(0, 10) || 'none';
        logger.consensus(`OUTPUT-${index + 1}: [${timestamp}] To Entity #${targetDisplay}:${formatSignerDisplay(output.signerId)} - txs=${output.entityTxs?.length || 0}, precommits=${output.precommits?.size || 0}, frame=${outputFrameHash}`, { entityId: output.entityId, signerId: output.signerId, txCount: output.entityTxs?.length || 0, precommitCount: output.precommits?.size || 0, frameHash: outputFrameHash });
        if (output.precommits?.size) {
            const precommitSigners = Array.from(output.precommits.keys());
            logger.consensus(`OUTPUT-${index + 1}-PRECOMMITS: Sending precommits from: ${precommitSigners.join(', ')}`, { entityId: output.entityId, signerId: output.signerId, precommitSigners });
            // Show the actual signature content to track duplicates
            output.precommits.forEach((sig, signer) => {
                const sigShort = sig.slice(0, 20);
                const proposalFromSig = sig.split('_')[2]?.slice(0, 10) || 'unknown';
                logger.consensus(`OUTPUT-${index + 1}-SIG-DETAIL: ${signer} -> ${sigShort}... (proposal: ${proposalFromSig})`, { entityId: output.entityId, signerId: output.signerId, signer, signature: sigShort, proposalHash: proposalFromSig });
            });
        }
        // Classify output type for clarity
        if (output.proposedFrame && output.precommits?.size) {
            logger.consensus(`OUTPUT-${index + 1}-TYPE: COMMIT_NOTIFICATION (frame + precommits)`, { entityId: output.entityId, signerId: output.signerId, outputType: 'COMMIT_NOTIFICATION' });
        }
        else if (output.precommits?.size) {
            logger.consensus(`OUTPUT-${index + 1}-TYPE: PRECOMMIT_VOTE (precommits only)`, { entityId: output.entityId, signerId: output.signerId, outputType: 'PRECOMMIT_VOTE' });
        }
        else if (output.proposedFrame) {
            logger.consensus(`OUTPUT-${index + 1}-TYPE: PROPOSAL (frame only)`, { entityId: output.entityId, signerId: output.signerId, outputType: 'PROPOSAL' });
        }
        else if (output.entityTxs?.length) {
            logger.consensus(`OUTPUT-${index + 1}-TYPE: TRANSACTION_FORWARD (txs only)`, { entityId: output.entityId, signerId: output.signerId, outputType: 'TRANSACTION_FORWARD' });
        }
        else {
            logger.consensus(`OUTPUT-${index + 1}-TYPE: UNKNOWN (empty output)`, { entityId: output.entityId, signerId: output.signerId, outputType: 'UNKNOWN' });
        }
    });
    return { newState: entityReplica.state, outputs: entityOutbox };
};
export const applyEntityFrame = async (env, entityState, entityTxs) => {
    logger.debug(`APPLY-ENTITY-FRAME: Processing ${entityTxs.length} transactions`, { txCount: entityTxs.length });
    entityTxs.forEach((tx, index) => {
        logger.debug(`Transaction ${index}: type="${tx.type}", data=${JSON.stringify(tx.data)}`, { transactionIndex: index, transactionType: tx.type });
    });
    let currentEntityState = entityState;
    const allOutputs = [];
    for (const entityTx of entityTxs) {
        const { newState, outputs } = await applyEntityTx(env, currentEntityState, entityTx);
        currentEntityState = newState;
        allOutputs.push(...outputs);
    }
    // AUTO-PROPOSE: Check if any accounts need to propose frames after processing transactions
    const { getAccountsToProposeFrames, proposeAccountFrame } = await import('./account-consensus');
    const accountsToProposeFrames = getAccountsToProposeFrames(currentEntityState);
    // TEMPORARILY DISABLED to test if this is causing infinite loop
    if (false && accountsToProposeFrames.length > 0) {
        logger.debug(`AUTO-PROPOSE: ${accountsToProposeFrames.length} accounts need frame proposals`, { accountCount: accountsToProposeFrames.length });
        for (const counterpartyEntityId of accountsToProposeFrames) {
            logger.debug(`AUTO-PROPOSE: Proposing frame for account with ${counterpartyEntityId.slice(0, 10)}`, { counterpartyEntityId: counterpartyEntityId.slice(0, 10) });
            const accountMachine = currentEntityState.accounts.get(counterpartyEntityId);
            if (accountMachine) {
                const proposal = proposeAccountFrame(accountMachine);
                // Debug: Check if state was actually modified
                logger.debug(`AFTER-PROPOSE: mempool=${accountMachine.mempool.length}, sent=${accountMachine.sentTransitions}, pending=${!!accountMachine.pendingFrame}`, { mempoolSize: accountMachine.mempool.length, sentTransitions: accountMachine.sentTransitions, hasPendingFrame: !!accountMachine.pendingFrame });
                if (proposal.success && proposal.accountInput) {
                    // Convert AccountInput to EntityInput for routing
                    allOutputs.push({
                        entityId: proposal.accountInput.toEntityId,
                        signerId: 'system',
                        entityTxs: [{
                                type: 'accountInput',
                                data: proposal.accountInput
                            }]
                    });
                    // Add events to entity messages
                    currentEntityState.messages.push(...proposal.events);
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
export const calculateQuorumPower = (config, signers) => {
    return signers.reduce((total, signerId) => {
        return total + (config.shares[signerId] || 0n);
    }, 0n);
};
export const sortSignatures = (signatures, config) => {
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
export const mergeEntityInputs = (inputs) => {
    const merged = new Map();
    let duplicateCount = 0;
    const timestamp = Date.now();
    // Always log input count for debugging with detailed breakdown
    logger.debug(`MERGE-START: [${timestamp}] Processing ${inputs.length} entity inputs for merging`, { inputCount: inputs.length });
    // Pre-analysis: Show all inputs before merging to identify potential Carol duplicates
    const inputAnalysis = inputs.map((input, i) => {
        const entityShort = input.entityId.slice(0, 10);
        const frameHash = input.proposedFrame?.hash?.slice(0, 10) || 'none';
        const precommitCount = input.precommits?.size || 0;
        const precommitSigners = input.precommits ? Array.from(input.precommits.keys()).join(',') : 'none';
        return `${i + 1}:${entityShort}:${input.signerId}(txs=${input.entityTxs?.length || 0},pc=${precommitCount}[${precommitSigners}],f=${frameHash})`;
    });
    logger.debug(`MERGE-INPUTS: ${inputAnalysis.join(' | ')}`, { inputAnalysis });
    // Look for potential Carol duplicates specifically
    const carolInputs = inputs.filter(input => input.signerId.includes('carol'));
    if (carolInputs.length > 1) {
        logger.warn(`MERGE-CAROL-ALERT: Found ${carolInputs.length} inputs from Carol - potential duplicate source!`, { carolInputCount: carolInputs.length });
        carolInputs.forEach((input, i) => {
            const entityShort = input.entityId.slice(0, 10);
            const precommitSigners = input.precommits ? Array.from(input.precommits.keys()).join(',') : 'none';
            logger.debug(`MERGE-CAROL-${i + 1}: ${entityShort}:${input.signerId} - precommits: ${precommitSigners}`, { entityId: input.entityId, signerId: input.signerId, precommitSigners });
        });
    }
    for (const input of inputs) {
        const key = `${input.entityId}:${input.signerId}`;
        const entityShort = input.entityId.slice(0, 10);
        if (merged.has(key)) {
            const existing = merged.get(key);
            duplicateCount++;
            logger.debug(`DUPLICATE-FOUND: Merging duplicate input ${duplicateCount} for ${entityShort}:${input.signerId}`, { entityId: input.entityId, signerId: input.signerId, duplicateNumber: duplicateCount });
            // Merge entity transactions
            if (input.entityTxs) {
                existing.entityTxs = [...(existing.entityTxs || []), ...input.entityTxs];
                logger.debug(`MERGE-TXS: Added ${input.entityTxs.length} transactions`, { entityId: input.entityId, signerId: input.signerId, addedTxs: input.entityTxs.length });
            }
            // Merge precommits
            if (input.precommits) {
                const existingPrecommits = existing.precommits || new Map();
                logger.debug(`MERGE-PRECOMMITS: Merging ${input.precommits.size} precommits into existing ${existingPrecommits.size} for ${entityShort}:${input.signerId}`, { entityId: input.entityId, signerId: input.signerId, newPrecommits: input.precommits.size, existingPrecommits: existingPrecommits.size });
                input.precommits.forEach((signature, signerId) => {
                    logger.debug(`MERGE-DETAIL: Adding precommit from ${signerId} (sig: ${signature.slice(0, 20)}...)`, { entityId: input.entityId, precommitSigner: signerId, signature: signature.slice(0, 20) });
                    existingPrecommits.set(signerId, signature);
                });
                existing.precommits = existingPrecommits;
                logger.debug(`MERGE-RESULT: Total ${existingPrecommits.size} precommits after merge`, { entityId: input.entityId, signerId: input.signerId, totalPrecommits: existingPrecommits.size });
            }
            // Keep the latest frame (simplified)
            if (input.proposedFrame)
                existing.proposedFrame = input.proposedFrame;
            logger.debug(`Merging inputs for ${key}: txs=${input.entityTxs?.length || 0}, precommits=${input.precommits?.size || 0}, frame=${!!input.proposedFrame}`, { entityId: input.entityId, signerId: input.signerId, txCount: input.entityTxs?.length || 0, precommitCount: input.precommits?.size || 0, hasFrame: !!input.proposedFrame });
        }
        else {
            merged.set(key, { ...input });
        }
    }
    if (duplicateCount > 0) {
        logger.warn(`CORNER CASE: Merged ${duplicateCount} duplicate inputs (${inputs.length} → ${merged.size})`, { duplicateCount, originalCount: inputs.length, mergedCount: merged.size });
    }
    return Array.from(merged.values());
};
/**
 * Gets entity state summary for debugging
 */
export const getEntityStateSummary = (replica) => {
    const hasProposal = replica.proposal ? '✓' : '✗';
    return `mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${hasProposal}`;
};
/**
 * Checks if entity should auto-propose (simplified version)
 */
export const shouldAutoPropose = (replica, config) => {
    const hasMempool = replica.mempool.length > 0;
    const isProposer = replica.isProposer;
    const hasProposal = replica.proposal !== undefined;
    return hasMempool && isProposer && !hasProposal;
};
/**
 * Processes empty transaction arrays (corner case)
 */
export const handleEmptyTransactions = () => {
    logger.warn(`CORNER CASE: Empty transaction array received - no mempool changes`);
};
/**
 * Logs large transaction batches (corner case)
 */
export const handleLargeBatch = (txCount) => {
    if (txCount >= 8) {
        logger.warn(`CORNER CASE: Large batch of ${txCount} transactions`, { txCount });
    }
};
/**
 * Handles gossip mode precommit distribution
 */
export const handleGossipMode = () => {
    logger.warn(`CORNER CASE: Gossip mode - all validators receive precommits`);
};
/**
 * Logs proposer with empty mempool corner case
 */
export const handleEmptyMempoolProposer = () => {
    logger.warn(`CORNER CASE: Proposer with empty mempool - no auto-propose`);
};
