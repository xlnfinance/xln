import { calculateQuorumPower } from '../entity-consensus';
import { DEBUG, log } from '../utils';
import { handleJEvent } from './j-events';
import { executeProposal, generateProposalId } from './proposals';
import { validateMessage } from './validation';
export const applyEntityTx = (env, entityState, entityTx) => {
    console.log(`🚨 APPLY-ENTITY-TX: type=${entityTx.type}, data=`, JSON.stringify(entityTx.data, null, 2));
    try {
        if (entityTx.type === 'chat') {
            const { from, message } = entityTx.data;
            if (!validateMessage(message)) {
                log.error(`❌ Invalid chat message from ${from}`);
                return entityState; // Return unchanged state
            }
            const currentNonce = entityState.nonces.get(from) || 0;
            const expectedNonce = currentNonce + 1;
            const newEntityState = {
                ...entityState,
                nonces: new Map(entityState.nonces),
                messages: [...entityState.messages],
                proposals: new Map(entityState.proposals),
                reserves: new Map(entityState.reserves),
                channels: new Map(entityState.channels),
                collaterals: new Map(entityState.collaterals),
            };
            newEntityState.nonces.set(from, expectedNonce);
            newEntityState.messages.push(`${from}: ${message}`);
            if (newEntityState.messages.length > 10) {
                newEntityState.messages.shift();
            }
            return newEntityState;
        }
        if (entityTx.type === 'propose') {
            const { action, proposer } = entityTx.data;
            const proposalId = generateProposalId(action, proposer, entityState);
            if (DEBUG)
                console.log(`    📝 Creating proposal ${proposalId} by ${proposer}: ${action.data.message}`);
            const proposal = {
                id: proposalId,
                proposer,
                action,
                // explicitly type votes map to match Proposal.vote value type
                votes: new Map([
                    [proposer, 'yes'],
                ]),
                status: 'pending',
                created: entityState.timestamp,
            };
            const proposerPower = entityState.config.shares[proposer] || BigInt(0);
            const shouldExecuteImmediately = proposerPower >= entityState.config.threshold;
            let newEntityState = {
                ...entityState,
                nonces: new Map(entityState.nonces),
                messages: [...entityState.messages],
                proposals: new Map(entityState.proposals),
                reserves: new Map(entityState.reserves),
                channels: new Map(entityState.channels),
                collaterals: new Map(entityState.collaterals),
            };
            if (shouldExecuteImmediately) {
                proposal.status = 'executed';
                newEntityState = executeProposal(newEntityState, proposal);
                if (DEBUG)
                    console.log(`    ⚡ Proposal executed immediately - proposer has ${proposerPower} >= ${entityState.config.threshold} threshold`);
            }
            else {
                if (DEBUG)
                    console.log(`    ⏳ Proposal pending votes - proposer has ${proposerPower} < ${entityState.config.threshold} threshold`);
            }
            newEntityState.proposals.set(proposalId, proposal);
            return newEntityState;
        }
        if (entityTx.type === 'vote') {
            console.log(`🗳️ PROCESSING VOTE: entityTx.data=`, entityTx.data);
            const { proposalId, voter, choice, comment } = entityTx.data;
            const proposal = entityState.proposals.get(proposalId);
            console.log(`🗳️ Vote lookup: proposalId=${proposalId}, found=${!!proposal}, status=${proposal?.status}`);
            console.log(`🗳️ Available proposals:`, Array.from(entityState.proposals.keys()));
            if (!proposal || proposal.status !== 'pending') {
                console.log(`    ❌ Vote ignored - proposal ${proposalId.slice(0, 12)}... not found or not pending`);
                return entityState;
            }
            console.log(`    🗳️  Vote by ${voter}: ${choice} on proposal ${proposalId.slice(0, 12)}...`);
            const newEntityState = {
                ...entityState,
                nonces: new Map(entityState.nonces),
                messages: [...entityState.messages],
                proposals: new Map(entityState.proposals),
                reserves: new Map(entityState.reserves),
                channels: new Map(entityState.channels),
                collaterals: new Map(entityState.collaterals),
            };
            const updatedProposal = {
                ...proposal,
                votes: new Map(proposal.votes),
            };
            // Only create the object variant when comment is provided (comment must be string)
            const voteData = comment !== undefined ? { choice, comment } : choice;
            updatedProposal.votes.set(voter, voteData);
            const yesVoters = Array.from(updatedProposal.votes.entries())
                .filter(([_, voteData]) => {
                const vote = typeof voteData === 'object' ? voteData.choice : voteData;
                return vote === 'yes';
            })
                .map(([voter, _]) => voter);
            const totalYesPower = calculateQuorumPower(entityState.config, yesVoters);
            if (DEBUG) {
                const totalShares = Object.values(entityState.config.shares).reduce((sum, val) => sum + val, BigInt(0));
                const percentage = ((Number(totalYesPower) / Number(entityState.config.threshold)) * 100).toFixed(1);
                console.log(`    🔍 Proposal votes: ${totalYesPower} / ${totalShares} [${percentage}% threshold${Number(totalYesPower) >= Number(entityState.config.threshold) ? '+' : ''}]`);
            }
            if (totalYesPower >= entityState.config.threshold) {
                updatedProposal.status = 'executed';
                const executedState = executeProposal(newEntityState, updatedProposal);
                executedState.proposals.set(proposalId, updatedProposal);
                return executedState;
            }
            newEntityState.proposals.set(proposalId, updatedProposal);
            return newEntityState;
        }
        if (entityTx.type === 'profile-update') {
            if (DEBUG)
                console.log(`    🏷️ Profile update transaction processed (gossip layer will handle storage)`);
            return entityState;
        }
        if (entityTx.type === 'j_event') {
            return handleJEvent(entityState, entityTx.data);
        }
        if (entityTx.type === 'j_tx') {
            // Handle jurisdiction transaction (reserve transfers, etc.)
            if (DEBUG)
                console.log(`    💸 j_tx transaction: processing reserve transfers`);
            const transferBatch = entityTx.data;
            let newEntityState = {
                ...entityState,
                reserves: new Map(entityState.reserves),
                channels: new Map(entityState.channels),
                collaterals: new Map(entityState.collaterals),
                messages: [...entityState.messages],
                nonces: new Map(entityState.nonces),
                proposals: new Map(entityState.proposals),
            };
            // Process reserveToReserve transfers (sending side)
            if (transferBatch.reserveToReserve && transferBatch.reserveToReserve.length > 0) {
                for (const transfer of transferBatch.reserveToReserve) {
                    const { receivingEntity, tokenId, amount } = transfer;
                    const tokenIdStr = String(tokenId);
                    // Reduce sender's reserves
                    const currentReserve = newEntityState.reserves.get(tokenIdStr);
                    if (!currentReserve) {
                        throw new Error(`❌ Transfer failed: Token ${tokenId} not found in sender reserves`);
                    }
                    const transferAmountBN = BigInt(amount);
                    if (currentReserve.amount < transferAmountBN) {
                        throw new Error(`❌ Transfer failed: Insufficient balance. Have: ${currentReserve.amount}, Need: ${transferAmountBN}`);
                    }
                    // Update sender's reserve
                    newEntityState.reserves.set(tokenIdStr, {
                        ...currentReserve,
                        amount: currentReserve.amount - transferAmountBN,
                    });
                    // Generate j_event for receiving entity
                    // This simulates the jurisdiction contract emitting a ReserveUpdated event
                    const receivingEntityReplica = Array.from(env.replicas.values()).find(replica => replica.entityId === receivingEntity);
                    if (receivingEntityReplica) {
                        // Calculate new balance for receiving entity
                        const receiverCurrentReserve = receivingEntityReplica.state.reserves.get(tokenIdStr);
                        const newReceiverBalance = (receiverCurrentReserve?.amount || 0n) + transferAmountBN;
                        // Create the reserve update event for the receiver
                        const reserveUpdateEvent = {
                            entityId: receivingEntity,
                            signerId: receivingEntityReplica.signerId,
                            entityTxs: [{
                                    type: 'j_event',
                                    data: {
                                        from: 'system', // System-generated event
                                        event: {
                                            type: 'ReserveUpdated',
                                            data: {
                                                entity: receivingEntity,
                                                tokenId: tokenId,
                                                newBalance: newReceiverBalance.toString(),
                                                name: currentReserve.symbol,
                                                symbol: currentReserve.symbol,
                                                decimals: currentReserve.decimals,
                                            },
                                        },
                                        observedAt: Date.now(),
                                        blockNumber: 1,
                                        transactionHash: `0xTRANSFER_${tokenId}_${entityState.entityId.slice(0, 10)}_TO_${receivingEntity.slice(0, 10)}`,
                                    },
                                }],
                        };
                        // Add to server input queue for processing in next cycle
                        env.serverInput.entityInputs.push(reserveUpdateEvent);
                        // ALSO directly update the receiving entity's state for immediate effect
                        // This simulates the blockchain state change happening atomically
                        const receiverCurrentReserveState = receivingEntityReplica.state.reserves.get(tokenIdStr);
                        receivingEntityReplica.state.reserves.set(tokenIdStr, {
                            symbol: currentReserve.symbol,
                            amount: newReceiverBalance,
                            decimals: currentReserve.decimals,
                        });
                        // Add message to receiver
                        receivingEntityReplica.state.messages.push(`Received ${transferAmountBN} ${currentReserve.symbol} from ${entityState.entityId.slice(0, 10)}...`);
                        if (DEBUG) {
                            console.log(`    💸 Generated reserve update event for receiving entity ${receivingEntity.slice(0, 10)}...: +${transferAmountBN} ${currentReserve.symbol}`);
                        }
                    }
                    newEntityState.messages.push(`Transferred ${transferAmountBN} ${currentReserve.symbol} to ${receivingEntity.slice(0, 10)}...`);
                    if (DEBUG) {
                        console.log(`    💸 Reserve transfer: -${transferAmountBN} ${currentReserve.symbol} from ${entityState.entityId.slice(0, 10)}...`);
                    }
                }
            }
            return newEntityState;
        }
        return entityState;
    }
    catch (error) {
        log.error(`❌ Transaction execution error: ${error}`);
        return entityState; // Return unchanged state on error
    }
};
