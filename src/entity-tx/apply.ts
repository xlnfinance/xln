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

export const applyEntityTx = async (env: Env, entityState: EntityState, entityTx: EntityTx): Promise<EntityState> => {
  console.log(`🚨 APPLY-ENTITY-TX: type=${entityTx.type}, data=`, JSON.stringify(entityTx.data, null, 2));
  console.log(`🚨 APPLY-ENTITY-TX: Available types: profile-update, j_event, accountInput`);
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
      return newEntityState;
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

      return entityState;
    }

    if (entityTx.type === 'j_event') {
      return handleJEvent(entityState, entityTx.data);
    }

    if (entityTx.type === 'accountInput') {
      return await handleAccountInput(entityState, entityTx.data, env);
    }

    return entityState;
  } catch (error) {
    log.error(`❌ Transaction execution error: ${error}`);
    return entityState; // Return unchanged state on error
  }
};
