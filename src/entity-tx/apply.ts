import { calculateQuorumPower } from '../entity-consensus';
import { processProfileUpdate } from '../name-resolution';
import { db } from '../server';
import { EntityState, EntityTx, Env, Proposal } from '../types';
import { DEBUG, log } from '../utils';
// import { addToReserves, subtractFromReserves } from './financial'; // Currently unused
import { handleAccountInput } from './handlers/account';
import { handleJEvent } from './j-events';
import { executeProposal, generateProposalId } from './proposals';
import { validateMessage } from './validation';
import { cloneEntityState } from '../state-helpers';

export const applyEntityTx = async (env: Env, entityState: EntityState, entityTx: EntityTx): Promise<{ newState: EntityState, outputs: EntityInput[] }> => {
  console.log(`🚨🚨 APPLY-ENTITY-TX: type="${entityTx.type}" (typeof: ${typeof entityTx.type})`);
  console.log(`🚨🚨 APPLY-ENTITY-TX: data=`, JSON.stringify(entityTx.data, null, 2));
  console.log(`🚨🚨 APPLY-ENTITY-TX: Available types: profile-update, j_event, accountInput, openAccount`);
  try {
    if (entityTx.type === 'chat') {
      const { from, message } = entityTx.data;

      if (!validateMessage(message)) {
        log.error(`❌ Invalid chat message from ${from}`);
        return { newState: entityState, outputs: [] }; // Return unchanged state
      }

      const currentNonce = entityState.nonces.get(from) || 0;
      const expectedNonce = currentNonce + 1;

      const newEntityState = cloneEntityState(entityState);

      newEntityState.nonces.set(from, expectedNonce);
      newEntityState.messages.push(`${from}: ${message}`);

      if (newEntityState.messages.length > 10) {
        newEntityState.messages.shift();
      }

      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'propose') {
      const { action, proposer } = entityTx.data;
      const proposalId = generateProposalId(action, proposer, entityState);

      if (DEBUG) console.log(`    📝 Creating proposal ${proposalId} by ${proposer}: ${action.data.message}`);

      const proposal: Proposal = {
        id: proposalId,
        proposer,
        action,
        // explicitly type votes map to match Proposal.vote value type
        votes: new Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>([
          [proposer, 'yes'],
        ]),
        status: 'pending',
        created: entityState.timestamp,
      };

      const proposerPower = entityState.config.shares[proposer] || BigInt(0);
      const shouldExecuteImmediately = proposerPower >= entityState.config.threshold;

      let newEntityState = cloneEntityState(entityState);

      if (shouldExecuteImmediately) {
        proposal.status = 'executed';
        newEntityState = executeProposal(newEntityState, proposal);
        if (DEBUG)
          console.log(
            `    ⚡ Proposal executed immediately - proposer has ${proposerPower} >= ${entityState.config.threshold} threshold`,
          );
      } else {
        if (DEBUG)
          console.log(
            `    ⏳ Proposal pending votes - proposer has ${proposerPower} < ${entityState.config.threshold} threshold`,
          );
      }

      newEntityState.proposals.set(proposalId, proposal);
      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'vote') {
      console.log(`🗳️ PROCESSING VOTE: entityTx.data=`, entityTx.data);
      const { proposalId, voter, choice, comment } = entityTx.data;
      const proposal = entityState.proposals.get(proposalId);

      console.log(`🗳️ Vote lookup: proposalId=${proposalId}, found=${!!proposal}, status=${proposal?.status}`);
      console.log(`🗳️ Available proposals:`, Array.from(entityState.proposals.keys()));

      if (!proposal || proposal.status !== 'pending') {
        console.log(`    ❌ Vote ignored - proposal ${proposalId.slice(0, 12)}... not found or not pending`);
        return { newState: entityState, outputs: [] };
      }

      console.log(`    🗳️  Vote by ${voter}: ${choice} on proposal ${proposalId.slice(0, 12)}...`);

      const newEntityState = cloneEntityState(entityState);

      const updatedProposal = {
        ...proposal,
        votes: new Map(proposal.votes),
      };
      // Only create the object variant when comment is provided (comment must be string)
      const voteData: 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string } =
        comment !== undefined ? ({ choice, comment } as { choice: 'yes' | 'no' | 'abstain'; comment: string }) : choice;
      updatedProposal.votes.set(voter, voteData);

      const yesVoters = Array.from(updatedProposal.votes.entries())
        .filter(([_voter, voteData]) => {
          const vote = typeof voteData === 'object' ? voteData.choice : voteData;
          return vote === 'yes';
        })
        .map(([voter, _voteData]) => voter);

      const totalYesPower = calculateQuorumPower(entityState.config, yesVoters);

      if (DEBUG) {
        const totalShares = Object.values(entityState.config.shares).reduce((sum, val) => sum + val, BigInt(0));
        const percentage = ((Number(totalYesPower) / Number(entityState.config.threshold)) * 100).toFixed(1);
        console.log(
          `    🔍 Proposal votes: ${totalYesPower} / ${totalShares} [${percentage}% threshold${Number(totalYesPower) >= Number(entityState.config.threshold) ? '+' : ''}]`,
        );
      }

      if (totalYesPower >= entityState.config.threshold) {
        updatedProposal.status = 'executed';
        const executedState = executeProposal(newEntityState, updatedProposal);
        executedState.proposals.set(proposalId, updatedProposal);
        return executedState;
      }

      newEntityState.proposals.set(proposalId, updatedProposal);
      return { newState: newEntityState, outputs: [] };
    }

    if (entityTx.type === 'profile-update') {
      console.log(`🏷️ Profile update transaction processing - data:`, entityTx.data);

      // Extract profile update data
      const profileData = entityTx.data.profile;
      console.log(`🏷️ Extracted profileData:`, profileData);

      if (profileData && profileData.entityId) {
        console.log(`🏷️ Calling processProfileUpdate for entity ${profileData.entityId}`);
        // Process profile update synchronously to ensure gossip is updated before snapshot
        try {
          await processProfileUpdate(db, profileData.entityId, profileData, profileData.hankoSignature || '', env);
        } catch (error) {
          console.error(`❌ Failed to process profile update for ${profileData.entityId}:`, error);
        }
      } else {
        console.warn(`⚠️ Invalid profile-update transaction data:`, entityTx.data);
        console.warn(`⚠️ ProfileData missing or invalid:`, profileData);
      }

      return { newState: entityState, outputs: [] };
    }

    if (entityTx.type === 'j_event') {
      const newState = handleJEvent(entityState, entityTx.data);
      return { newState, outputs: [] };
    }

    if (entityTx.type === 'accountInput') {
      const newState = await handleAccountInput(entityState, entityTx.data, env);
      return { newState, outputs: [] };
    }

    if (entityTx.type === 'place_order') {
      const newState = cloneEntityState(entityState);

      // Initialize orderbook if not exists
      if (!newState.orderbook) {
        // Import the production orderbook from lob_core
        const { createOrderbook } = await import('../orderbook/lob_core');
        newState.orderbook = createOrderbook();
      }

      // Add order to orderbook
      const order = {
        id: `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        ...entityTx.data
      };

      // TODO: Call orderbook.addOrder(order) when lob_core is properly typed
      newState.messages.push(`📊 Order placed: ${order.side} ${order.amount} @ ${order.price}`);

      return { newState, outputs: [] };
    }

    if (entityTx.type === 'cancel_order') {
      const newState = cloneEntityState(entityState);

      if (newState.orderbook) {
        // TODO: Call orderbook.cancelOrder(entityTx.data.orderId)
        newState.messages.push(`❌ Order cancelled: ${entityTx.data.orderId}`);
      }

      return { newState, outputs: [] };
    }

    if (entityTx.type === 'modify_order') {
      const newState = cloneEntityState(entityState);

      if (newState.orderbook) {
        // TODO: Cancel old order and place new one
        newState.messages.push(`✏️ Order modified: ${entityTx.data.orderId}`);
      }

      return { newState, outputs: [] };
    }

    if (entityTx.type === 'openAccount') {
      console.log(`💳 OPEN-ACCOUNT: Opening account with ${entityTx.data.targetEntityId}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];

      // Check if account already exists to prevent duplicate opening
      if (entityState.accounts.has(entityTx.data.targetEntityId)) {
        console.log(`💳 ACCOUNT-EXISTS: Account with ${entityTx.data.targetEntityId.slice(0,10)} already exists, skipping`);
        newState.messages.push(`💳 Account already open with Entity ${entityTx.data.targetEntityId.slice(-4)}`);
        return { newState, outputs: [] };
      }

      // Add chat message about account opening
      newState.messages.push(`💳 Opening account with Entity ${entityTx.data.targetEntityId.slice(-4)}...`);

      // STEP 1: Create local account machine
      if (!newState.accounts.has(entityTx.data.targetEntityId)) {
        console.log(`💳 LOCAL-ACCOUNT: Creating local account with ${entityTx.data.targetEntityId.slice(0,10)}...`);

        newState.accounts.set(entityTx.data.targetEntityId, {
          counterpartyEntityId: entityTx.data.targetEntityId,
          mempool: [],
          currentFrame: { frameId: 0, timestamp: Date.now(), tokenIds: [], deltas: [] },
          sentTransitions: 0,
          ackedTransitions: 0,
          deltas: new Map(),
          globalCreditLimits: {
            ownLimit: 1000000n, // We extend 1M USD credit to counterparty
            peerLimit: 1000000n, // Counterparty extends 1M USD credit to us
          },
          // Frame-based consensus fields
          currentFrameId: 0,
          pendingFrame: undefined,
          pendingSignatures: [],
          rollbackCount: 0,
          isProposer: entityState.entityId < entityTx.data.targetEntityId, // Lexicographically smaller is proposer
          clonedForValidation: undefined,
          proofHeader: {
            fromEntity: entityState.entityId,
            toEntity: entityTx.data.targetEntityId,
            cooperativeNonce: 0,
            disputeNonce: 0,
          },
          proofBody: { tokenIds: [], deltas: [] }
        });
      }

      // STEP 2: Bubble up AccountInput to target entity
      console.log(`💳 BUBBLE-OUTPUT: Creating AccountInput for target entity ${entityTx.data.targetEntityId.slice(0,10)}...`);

      const accountInputForTarget: EntityInput = {
        entityId: entityTx.data.targetEntityId,
        signerId: 'system', // System-generated input
        entityTxs: [{
          type: 'accountInput',
          data: {
            fromEntityId: entityState.entityId,
            toEntityId: entityTx.data.targetEntityId,
            accountTx: {
              type: 'initial_ack',
              data: { message: 'Account opening request' }
            },
            metadata: {
              purpose: 'account_opening_request',
              description: `Account opening initiated by Entity ${entityState.entityId.slice(-4)}`
            }
          }
        }]
      };

      outputs.push(accountInputForTarget);
      console.log(`💳 OUTPUT-CREATED: Will route AccountInput to ${entityTx.data.targetEntityId.slice(0,10)}...`);

      // Add success message to chat
      newState.messages.push(`✅ Account opening request sent to Entity ${entityTx.data.targetEntityId.slice(-4)}`);

      return { newState, outputs };
    }

    return { newState: entityState, outputs: [] };
  } catch (error) {
    log.error(`❌ Transaction execution error: ${error}`);
    return { newState: entityState, outputs: [] }; // Return unchanged state on error
  }
};
