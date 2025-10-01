import { calculateQuorumPower } from '../entity-consensus';
import { formatEntityId } from '../entity-helpers';
import { processProfileUpdate } from '../name-resolution';
import { db } from '../server';
import { EntityState, EntityTx, Env, Proposal, Delta, AccountTx, AccountInput, EntityInput } from '../types';
import { DEBUG, log } from '../utils';
import { safeStringify } from '../serialization-utils';
import { buildEntityProfile } from '../gossip-helper';
import { createDemoDelta, getDefaultCreditLimit } from '../account-utils';
// import { addToReserves, subtractFromReserves } from './financial'; // Currently unused
import { handleAccountInput } from './handlers/account';
import { handleJEvent } from './j-events';
import { executeProposal, generateProposalId } from './proposals';
import { validateMessage } from './validation';
import { cloneEntityState } from '../state-helpers';
import { submitSettle } from '../evm';

export const applyEntityTx = async (env: Env, entityState: EntityState, entityTx: EntityTx): Promise<{ newState: EntityState, outputs: EntityInput[] }> => {
  if (!entityTx) {
    console.error(`❌ EntityTx is undefined!`);
    return { newState: entityState, outputs: [] };
  }

  console.log(`🚨🚨 APPLY-ENTITY-TX: type="${entityTx?.type}" (typeof: ${typeof entityTx?.type})`);
  console.log(`🚨🚨 APPLY-ENTITY-TX: data=`, safeStringify(entityTx?.data, 2));
  console.log(`🚨🚨 APPLY-ENTITY-TX: Available types: profile-update, j_event, accountInput, openAccount, directPayment`);
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
        return { newState: executedState, outputs: [] };
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
      const result = await handleAccountInput(entityState, entityTx.data, env);
      return result;
    }

    if (entityTx.type === 'openAccount') {
      console.log(`💳 OPEN-ACCOUNT: Opening account with ${entityTx.data.targetEntityId}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];

      // Add chat message about account opening
      newState.messages.push(`💳 Opening account with Entity ${formatEntityId(entityTx.data.targetEntityId)}...`);

      // STEP 1: Create local account machine
      if (!newState.accounts.has(entityTx.data.targetEntityId)) {
        console.log(`💳 LOCAL-ACCOUNT: Creating local account with Entity ${formatEntityId(entityTx.data.targetEntityId)}...`);

        // Initialize with default USDT delta showing credit limits
        const initialDeltas = new Map<number, Delta>();
        initialDeltas.set(2, createDemoDelta(2, 0n, 0n)); // USDT token

        newState.accounts.set(entityTx.data.targetEntityId, {
          counterpartyEntityId: entityTx.data.targetEntityId,
          mempool: [],
          currentFrame: { frameId: 0, timestamp: Date.now(), tokenIds: [], deltas: [] },
          sentTransitions: 0,
          ackedTransitions: 0,
          deltas: initialDeltas,
          globalCreditLimits: {
            ownLimit: getDefaultCreditLimit(3), // We extend 1M USD credit (USDC) to counterparty
            peerLimit: getDefaultCreditLimit(3), // Counterparty extends same credit to us
          },
          // Frame-based consensus fields
          currentFrameId: 0,
          pendingSignatures: [],
          rollbackCount: 0,
          // CHANNEL.TS REFERENCE: Proper message counters (NOT timestamps!)
          sendCounter: 0,    // Like Channel.ts line 131
          receiveCounter: 0, // Like Channel.ts line 132
          // Removed isProposer - use isLeft() function like old_src Channel.ts
          proofHeader: {
            fromEntity: entityState.entityId,
            toEntity: entityTx.data.targetEntityId,
            cooperativeNonce: 0,
            disputeNonce: 0,
          },
          proofBody: { tokenIds: [], deltas: [] },
          frameHistory: [] // Initialize empty frame history
        });
      }

      // STEP 2: Send initial AccountInput to target entity to establish bilateral account
      console.log(`💳 Sending initial AccountInput to ${formatEntityId(entityTx.data.targetEntityId)} to establish account`);

      // Create AccountInput with initial account opening handshake
      const accountInput: AccountInput = {
        fromEntityId: entityState.entityId,
        toEntityId: entityTx.data.targetEntityId,
        accountTx: {
          type: 'account_payment',
          data: {
            tokenId: 2, // USDT - initial account opening transaction
            amount: 0n
          }
        }
      };

      // Get the proposer of the target entity (default to 'alice' if not found)
      let targetProposerId = 'alice';
      const targetReplicaKeys = Array.from(env.replicas.keys()).filter(key => key.startsWith(entityTx.data.targetEntityId + ':'));
      if (targetReplicaKeys.length > 0) {
        const firstKey = targetReplicaKeys[0];
        if (firstKey) {
          const firstTargetReplica = env.replicas.get(firstKey);
          const firstValidator = firstTargetReplica?.state.config.validators[0];
          if (firstValidator) {
            targetProposerId = firstValidator;
          }
        }
      }
      console.log(`💳 Target entity ${entityTx.data.targetEntityId.slice(0,10)} has proposer: ${targetProposerId}`);

      // Queue AccountInput to be sent to target entity
      outputs.push({
        entityId: entityTx.data.targetEntityId,
        signerId: targetProposerId,
        entityTxs: [{
          type: 'accountInput',
          data: accountInput
        }]
      });
      console.log(`📤 Queued AccountInput for Entity ${formatEntityId(entityTx.data.targetEntityId)}`);

      // Add success message to chat
      newState.messages.push(`✅ Account opening request sent to Entity ${formatEntityId(entityTx.data.targetEntityId)}`);

      // Broadcast updated profile to gossip layer
      if (env.gossip) {
        const profile = buildEntityProfile(newState);
        env.gossip.announce(profile);
        console.log(`📡 Broadcast profile for ${entityState.entityId} with ${newState.accounts.size} accounts`);
      }

      return { newState, outputs };
    }

    if (entityTx.type === 'directPayment') {
      console.log(`💸 DIRECT-PAYMENT: Initiating payment to ${entityTx.data.targetEntityId}`);

      const newState = cloneEntityState(entityState);
      const outputs: EntityInput[] = [];

      // Extract payment details
      let { targetEntityId, tokenId, amount, route, description } = entityTx.data;

      // If no route provided, check for direct account or calculate route
      if (!route || route.length === 0) {
        // Check if we have a direct account with target
        if (newState.accounts.has(targetEntityId)) {
          console.log(`💸 Direct account exists with ${formatEntityId(targetEntityId)}`);
          route = [entityState.entityId, targetEntityId];
        } else {
          // Find route through network using gossip
          console.log(`💸 No direct account, finding route to ${formatEntityId(targetEntityId)}`);

          // Try to find a route through the network
          if (env.gossip) {
            const networkGraph = env.gossip.getNetworkGraph();
            const paths = networkGraph.findPaths(entityState.entityId, targetEntityId);

            if (paths.length > 0) {
              // Use the shortest path
              route = paths[0].path;
              console.log(`💸 Found route: ${route.map(e => formatEntityId(e)).join(' → ')}`);
            } else {
              console.error(`❌ No route found to ${formatEntityId(targetEntityId)}`);
              newState.messages.push(`❌ Payment failed: No route to ${formatEntityId(targetEntityId)}`);
              return { newState, outputs: [] };
            }
          } else {
            console.error(`❌ Cannot find route: Gossip layer not available`);
            newState.messages.push(`❌ Payment failed: Network routing unavailable`);
            return { newState, outputs: [] };
          }
        }
      }

      // Validate route starts with current entity
      if (route.length < 2 || route[0] !== entityState.entityId) {
        console.error(`❌ Invalid route: doesn't start with current entity`);
        return { newState: entityState, outputs: [] };
      }

      // Determine next hop
      const nextHop = route[1];
      if (!nextHop) {
        console.error(`❌ Invalid route: no next hop specified in route`);
        return { newState: entityState, outputs: [] };
      }

      // Check if we have an account with next hop
      if (!newState.accounts.has(nextHop)) {
        console.error(`❌ No account with next hop: ${nextHop}`);
        newState.messages.push(`❌ Payment failed: No account with ${formatEntityId(nextHop)}`);
        return { newState, outputs: [] };
      }

      // Create AccountTx for the payment
      const accountTx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId,
          amount,
          route: route.slice(1), // Remove current entity from route
          description: description || `Payment to ${formatEntityId(targetEntityId)}`,
        },
      };

      // Add to account machine mempool
      const accountMachine = newState.accounts.get(nextHop);
      if (accountMachine) {
        accountMachine.mempool.push(accountTx);
        console.log(`💸 Added payment to mempool for account with ${formatEntityId(nextHop)}`);
        console.log(`💸 Account mempool now has ${accountMachine.mempool.length} pending transactions`);
        const isLeft = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity;
        console.log(`💸 Is left entity: ${isLeft}, Has pending frame: ${!!accountMachine.pendingFrame}`);

        // Message about payment initiation
        newState.messages.push(
          `💸 Sending ${amount} (token ${tokenId}) to ${formatEntityId(targetEntityId)} via ${route.length - 1} hops`
        );

        // The payment is now in our local mempool with the next hop
        // It will be processed through bilateral consensus in the next round
        // The auto-propose logic in entity-consensus will handle proposing the frame
        console.log(`💸 Payment queued for bilateral consensus with ${formatEntityId(nextHop)}`);
        console.log(`💸 Account ${formatEntityId(nextHop)} should be added to proposableAccounts`);

        // Note: The entity-consensus applyEntityFrame will add this account to proposableAccounts
        // and trigger bilateral frame proposal at the end of the processing round

        // Return a trigger output to ensure processUntilEmpty continues
        // This ensures the AUTO-PROPOSE logic runs to process the payment
        const firstValidator = entityState.config.validators[0];
        if (firstValidator) {
          outputs.push({
            entityId: entityState.entityId,
            signerId: firstValidator,
            entityTxs: [] // Empty transaction array - just triggers processing
          });
        }
        console.log(`💸 Added processing trigger to ensure bilateral consensus runs`);
      }

      return { newState, outputs };
    }

    if (entityTx.type === 'settleDiffs') {
      console.log(`🏦 SETTLE-DIFFS: Processing settlement with ${entityTx.data.counterpartyEntityId}`);

      const newState = cloneEntityState(entityState);
      const { counterpartyEntityId, diffs, description } = entityTx.data;

      // Step 1: Validate invariant for all diffs
      for (const diff of diffs) {
        const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
        if (sum !== 0n) {
          console.error(`❌ INVARIANT-VIOLATION: leftDiff + rightDiff + collateralDiff = ${sum} (must be 0)`);
          throw new Error(`Settlement invariant violation: ${sum} !== 0`);
        }
      }

      // Step 2: Validate account exists
      if (!newState.accounts.has(counterpartyEntityId)) {
        console.error(`❌ No account exists with ${formatEntityId(counterpartyEntityId)}`);
        throw new Error(`No account with ${counterpartyEntityId}`);
      }

      // Step 3: Determine canonical left/right order
      const isLeft = entityState.entityId < counterpartyEntityId;
      const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
      const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

      console.log(`🏦 Canonical order: left=${leftEntity.slice(0,10)}..., right=${rightEntity.slice(0,10)}...`);
      console.log(`🏦 We are: ${isLeft ? 'LEFT' : 'RIGHT'}`);

      // Step 4: Get jurisdiction config
      const jurisdiction = entityState.config.jurisdiction;
      if (!jurisdiction) {
        throw new Error('No jurisdiction configured for this entity');
      }

      // Step 5: Convert diffs to contract format (preserve perspective)
      const contractDiffs = diffs.map(d => ({
        tokenId: d.tokenId,
        leftDiff: d.leftDiff.toString(),
        rightDiff: d.rightDiff.toString(),
        collateralDiff: d.collateralDiff.toString(),
        ondeltaDiff: d.ondeltaDiff.toString(),
      }));

      console.log(`🏦 Calling submitSettle with diffs:`, safeStringify(contractDiffs, 2));

      // Step 6: Call Depository.settle() - fire and forget (j-watcher handles result)
      try {
        const result = await submitSettle(jurisdiction, leftEntity, rightEntity, contractDiffs);
        console.log(`✅ Settlement transaction sent: ${result.txHash}`);

        // Add message to chat
        newState.messages.push(
          `🏦 ${description || 'Settlement'} tx: ${result.txHash.slice(0, 10)}... (block ${result.blockNumber})`
        );
      } catch (error) {
        console.error(`❌ Settlement transaction failed:`, error);
        newState.messages.push(`❌ Settlement failed: ${(error as Error).message}`);
        throw error; // Re-throw to trigger outer catch
      }

      return { newState, outputs: [] };
    }

    return { newState: entityState, outputs: [] };
  } catch (error) {
    log.error(`❌ Transaction execution error: ${error}`);
    return { newState: entityState, outputs: [] }; // Return unchanged state on error
  }
};
