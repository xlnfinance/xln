/**
 * XLN Entity Transaction Processing
 * Handles execution of individual entity transactions and proposals
 */

import {
  EntityState, EntityTx, Proposal, ProposalAction, Env, ConsensusConfig, VoteData, AssetBalance
} from './types.js';
import { createHash, DEBUG, log } from './utils.js';
import { calculateQuorumPower } from './entity-consensus.js';

// === FINANCIAL HELPER FUNCTIONS ===

export const formatAssetAmount = (balance: AssetBalance): string => {
  const divisor = BigInt(10) ** BigInt(balance.decimals);
  const wholePart = balance.amount / divisor;
  const fractionalPart = balance.amount % divisor;

  if (fractionalPart === 0n) {
    return `${wholePart} ${balance.symbol}`;
  }

  const fractionalStr = fractionalPart.toString().padStart(balance.decimals, '0');
  return `${wholePart}.${fractionalStr} ${balance.symbol}`;
};

export const addToReserves = (reserves: Map<string, AssetBalance>, symbol: string, amount: bigint, decimals: number, contractAddress?: string): void => {
  const existing = reserves.get(symbol);
  if (existing) {
    existing.amount += amount;
  } else {
    reserves.set(symbol, { symbol, amount, decimals, contractAddress });
  }
};

export const subtractFromReserves = (reserves: Map<string, AssetBalance>, symbol: string, amount: bigint): boolean => {
  const existing = reserves.get(symbol);
  if (!existing || existing.amount < amount) {
    return false; // Insufficient balance
  }
  existing.amount -= amount;
  if (existing.amount === 0n) {
    reserves.delete(symbol);
  }
  return true;
};

// === SECURITY VALIDATION ===

/**
 * Validates nonce to prevent replay attacks
 */
const validateNonce = (currentNonce: number, expectedNonce: number, from: string): boolean => {
  try {
    if (expectedNonce !== currentNonce + 1) {
      log.error(`❌ Invalid nonce from ${from}: expected ${currentNonce + 1}, got ${expectedNonce}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Nonce validation error: ${error}`);
    return false;
  }
};

/**
 * Validates message content to prevent DoS attacks
 */
const validateMessage = (message: string): boolean => {
  try {
    if (typeof message !== 'string') {
      log.error(`❌ Message must be string, got: ${typeof message}`);
      return false;
    }
    if (message.length > 1000) {
      log.error(`❌ Message too long: ${message.length} > 1000 chars`);
      return false;
    }
    if (message.length === 0) {
      log.error(`❌ Empty message not allowed`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Message validation error: ${error}`);
    return false;
  }
};

/**
 * Apply a single entity transaction to the entity state
 * COMPLETE IMPLEMENTATION moved from server.ts
 */
export const applyEntityTx = (env: Env, entityState: EntityState, entityTx: EntityTx): EntityState => {
  console.log(`🚨 APPLY-ENTITY-TX: type=${entityTx.type}, data=`, entityTx.data);
  try {
    if (entityTx.type === 'chat') {
      const { from, message } = entityTx.data;

      // SECURITY: Validate message content
      if (!validateMessage(message)) {
        log.error(`❌ Invalid chat message from ${from}`);
        return entityState; // Return unchanged state
      }

      const currentNonce = entityState.nonces.get(from) || 0;

      // SECURITY: For now, we auto-increment nonces but should validate them
      // TODO: Add explicit nonce in transaction data and validate
      const expectedNonce = currentNonce + 1;

      // Create new state (immutable at transaction level)
      const newEntityState = {
        ...entityState,
        nonces: new Map(entityState.nonces),
        messages: [...entityState.messages],
        proposals: new Map(entityState.proposals),
        // 💰 Clone financial state
        reserves: new Map(entityState.reserves),
        channels: new Map(entityState.channels),
        collaterals: new Map(entityState.collaterals)
      };

      newEntityState.nonces.set(from, expectedNonce);
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
      votes: new Map([[proposer, 'yes']]), // Proposer automatically votes yes without comment
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
      proposals: new Map(entityState.proposals),
      // 💰 Clone financial state
      reserves: new Map(entityState.reserves),
      channels: new Map(entityState.channels),
      collaterals: new Map(entityState.collaterals)
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
      // 💰 Clone financial state
      reserves: new Map(entityState.reserves),
      channels: new Map(entityState.channels),
      collaterals: new Map(entityState.collaterals)
    };

    const updatedProposal = {
      ...proposal,
      votes: new Map(proposal.votes)
    };
    // Store vote with comment if provided
    const voteData = comment ? { choice, comment } : choice;
    updatedProposal.votes.set(voter, voteData);

    // Calculate voting power for 'yes' votes
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

  if (entityTx.type === 'profile-update') {
    // Profile updates are processed via consensus but don't change entity state
    // The actual profile update happens in the gossip layer after consensus
    if (DEBUG) console.log(`    🏷️ Profile update transaction processed (gossip layer will handle storage)`);
    return entityState; // State unchanged, profile update handled separately
  }

  if (entityTx.type === 'j_event') {
    console.log(`🚨 PROCESSING J-EVENT: entityTx.data=`, entityTx.data);
    const { from, event, observedAt, blockNumber, transactionHash } = entityTx.data;

    if (DEBUG) {
      console.log(`    🔭 J-EVENT: ${from} observed ${event.type} at block ${blockNumber}`);
      console.log(`    🔭 J-EVENT-DATA:`, entityTx.data);
    }

    const isSingleSig = entityState.config.mode === 'proposer-based' && entityState.config.threshold === 1n;

    if (isSingleSig) {
      // === INSTANT EXECUTION ===
      const newEntityState = {
        ...entityState,
        messages: [...entityState.messages],
        nonces: new Map(entityState.nonces),
        proposals: new Map(entityState.proposals),
        reserves: new Map(entityState.reserves),
        channels: new Map(entityState.channels),
        collaterals: new Map(entityState.collaterals),
      };

      newEntityState.messages.push(
        `${from} observed j-event: ${event.type} (block ${blockNumber}, tx ${transactionHash.slice(0, 10)}...)`
      );

      switch (event.type) {
        // --- Depository.sol ---
        case "reserveToReserve":
          console.log(`    🔄 Executing reserveToReserve: ${event.data.amount} ${event.data.asset}`);
          subtractFromReserves(newEntityState.reserves, event.data.asset, BigInt(event.data.amount));
          addToReserves(newEntityState.reserves, event.data.asset, BigInt(event.data.amount), event.data.decimals || 18);
          break;

        case "TransferReserveToCollateral":
          subtractFromReserves(newEntityState.reserves, `token-${event.data.tokenId}`, BigInt(event.data.amount));
          addToReserves(newEntityState.collaterals, `token-${event.data.tokenId}`, BigInt(event.data.collateral), 18);
          break;

        case "DisputeStarted":
          const peer = event.data.peer;
          const channelKey = peer;

          const existingChannel = newEntityState.channels.get(channelKey) || {
            counterparty: peer,
            myBalance: 0n,
            theirBalance: 0n,
            collateral: [],
            nonce: 0,
            isActive: true,
            lastUpdate: observedAt,
          };

          // TODO: Handle dispute state in channel (not yet implemented in ChannelState)
          // For now, just log the dispute start
          // In a full implementation, you'd update the channel state to reflect the dispute
          // e.g.,
          // newEntityState.channels.set(channelKey, {
          //   ...existingChannel,
          //   dispute: {
          //     nonce: event.data.disputeNonce,
          //     startedAt: observedAt,
          //     initialArguments: event.data.initialArguments,
          //   },
          //   lastUpdate: observedAt,
          // });

          newEntityState.messages.push(`⚡ Dispute started with ${peer} (nonce=${event.data.disputeNonce})`);
          break;

        case "CooperativeClose":
          newEntityState.channels.delete(event.data.peer);
          break;

        case "ControlSharesReceived":
          addToReserves(newEntityState.reserves, event.data.tokenId, BigInt(event.data.amount), event.data.decimals || 0);
          break;

        case "ControlSharesTransferred":
          subtractFromReserves(newEntityState.reserves, `share-${event.data.internalTokenId}`, BigInt(event.data.amount));
          addToReserves(newEntityState.reserves, `share-${event.data.internalTokenId}`, BigInt(event.data.amount), 0);
          break;

        // --- EntityProvider.sol ---
        case "GovernanceEnabled":
          addToReserves(newEntityState.reserves, `control-${event.data.controlTokenId}`, BigInt(1e15), 0);
          addToReserves(newEntityState.reserves, `dividend-${event.data.dividendTokenId}`, BigInt(1e15), 0);
          break;

        case "ControlSharesReleased":
          subtractFromReserves(newEntityState.reserves, `control-${event.data.entityId}`, BigInt(event.data.controlAmount));
          subtractFromReserves(newEntityState.reserves, `dividend-${event.data.entityId}`, BigInt(event.data.dividendAmount));
          break;

        default:
          newEntityState.messages.push(`⚠️ Unhandled j-event type: ${event.type}`);
      }

      return newEntityState;
    } else {
      console.log(`    🏛️  Multi-sig entity - wrapping j_event as proposal for voting`);
      // === MULTI-SIG ENTITY: WRAP AS PROPOSAL ===
      const action: ProposalAction = {
        type: 'collective_message',
        data: {
          message: `${from} proposed j-event: ${event.type} (block ${blockNumber}, tx ${transactionHash.slice(0,10)}...)`
        }
      };
      const proposalId = generateProposalId(action, from, entityState);
      const proposal: Proposal = {
        id: proposalId,
        proposer: from,
        action,
        votes: new Map([[from, 'yes']]),
        status: 'pending',
        created: observedAt,
      };

      const newProposals = new Map(entityState.proposals);
      newProposals.set(proposalId, proposal);

      return {
        ...entityState,
        proposals: newProposals,
        messages: [...entityState.messages, `${from} proposed j-event: ${event.type}`],
      };
    }
  }


  // TODO: In the future, j-events could trigger:
  // - Automatic proposals based on jurisdiction events
  // - State updates based on confirmed external actions
  // - Consensus on what external events were observed

  return entityState;
  } catch (error) {
    log.error(`❌ Transaction execution error: ${error}`);
    return entityState; // Return unchanged state on error
  }
};

/**
 * Generate deterministic proposal ID from action and context
 * COMPLETE IMPLEMENTATION moved from server.ts
 */
export const generateProposalId = (action: ProposalAction, proposer: string, entityState: EntityState): string => {
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

export const executeProposal = (entityState: EntityState, proposal: Proposal): EntityState => {
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