/**
 * XLN State Management Helpers
 * Utilities for entity replica cloning, snapshots, and state persistence
 */
import { encode } from './snapshot-coder.js';
import { DEBUG } from './utils.js';
// === SNAPSHOT UTILITIES ===
export const deepCloneReplica = (replica) => {
    const cloneMap = (map) => new Map(map);
    const cloneArray = (arr) => [...arr];
    return {
        entityId: replica.entityId,
        signerId: replica.signerId,
        state: {
            height: replica.state.height,
            timestamp: replica.state.timestamp,
            nonces: cloneMap(replica.state.nonces),
            messages: cloneArray(replica.state.messages),
            proposals: new Map(Array.from(replica.state.proposals.entries()).map(([id, proposal]) => [
                id,
                { ...proposal, votes: cloneMap(proposal.votes) }
            ])),
            config: replica.state.config
        },
        mempool: cloneArray(replica.mempool),
        proposal: replica.proposal ? {
            height: replica.proposal.height,
            txs: cloneArray(replica.proposal.txs),
            hash: replica.proposal.hash,
            newState: replica.proposal.newState,
            signatures: cloneMap(replica.proposal.signatures)
        } : undefined,
        lockedFrame: replica.lockedFrame ? {
            height: replica.lockedFrame.height,
            txs: cloneArray(replica.lockedFrame.txs),
            hash: replica.lockedFrame.hash,
            newState: replica.lockedFrame.newState,
            signatures: cloneMap(replica.lockedFrame.signatures)
        } : undefined,
        isProposer: replica.isProposer
    };
};
export const captureSnapshot = (env, envHistory, db, serverInput, serverOutputs, description) => {
    const snapshot = {
        height: env.height,
        timestamp: env.timestamp,
        replicas: new Map(Array.from(env.replicas.entries()).map(([key, replica]) => [
            key,
            deepCloneReplica(replica)
        ])),
        serverInput: {
            serverTxs: [...serverInput.serverTxs],
            entityInputs: serverInput.entityInputs.map(input => ({
                ...input,
                entityTxs: input.entityTxs ? [...input.entityTxs] : undefined,
                precommits: input.precommits ? new Map(input.precommits) : undefined
            }))
        },
        serverOutputs: serverOutputs.map(output => ({
            ...output,
            entityTxs: output.entityTxs ? [...output.entityTxs] : undefined,
            precommits: output.precommits ? new Map(output.precommits) : undefined
        })),
        description
    };
    envHistory.push(snapshot);
    // --- PERSISTENCE WITH BATCH OPERATIONS ---
    // Use batch operations for better performance
    const batch = db.batch();
    batch.put(Buffer.from(`snapshot:${snapshot.height}`), encode(snapshot));
    batch.put(Buffer.from('latest_height'), Buffer.from(snapshot.height.toString()));
    batch.write();
    if (DEBUG) {
        console.log(`📸 Snapshot captured: "${description}" (${envHistory.length} total)`);
        if (serverInput.serverTxs.length > 0) {
            console.log(`    🖥️  ServerTxs: ${serverInput.serverTxs.length}`);
            serverInput.serverTxs.forEach((tx, i) => {
                console.log(`      ${i + 1}. ${tx.type} ${tx.entityId}:${tx.signerId} (${tx.data.isProposer ? 'proposer' : 'validator'})`);
            });
        }
        if (serverInput.entityInputs.length > 0) {
            console.log(`    📨 EntityInputs: ${serverInput.entityInputs.length}`);
            serverInput.entityInputs.forEach((input, i) => {
                const parts = [];
                if (input.entityTxs?.length)
                    parts.push(`${input.entityTxs.length} txs`);
                if (input.precommits?.size)
                    parts.push(`${input.precommits.size} precommits`);
                if (input.proposedFrame)
                    parts.push(`frame: ${input.proposedFrame.hash.slice(0, 10)}...`);
                console.log(`      ${i + 1}. ${input.entityId}:${input.signerId} (${parts.join(', ') || 'empty'})`);
            });
        }
    }
};
