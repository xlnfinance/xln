import { calculateQuorumPower } from '../../entity-consensus';
import { createOrderbookExtState, validateSpreadDistribution } from '../../orderbook';
import type { EntityInput, EntityState, EntityTx, Env, Proposal } from '../../types';
import { DEBUG, formatEntityId, log } from '../../utils';
import { normalizeEntityName } from '../../networking/gossip';
import { announceLocalEntityProfile } from '../../networking/gossip-helper';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { executeProposal, generateProposalId } from '../proposals';
import { validateMessage } from '../validation';

type BasicEntityTxResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

export const handleChatEntityTx = (entityState: EntityState, entityTx: EntityTxOf<'chat'>): BasicEntityTxResult => {
  const { from, message } = entityTx.data;

  if (!validateMessage(message)) {
    log.error(`❌ Invalid chat message from ${from}`);
    return { newState: entityState, outputs: [] };
  }

  const currentNonce = entityState.nonces.get(from) || 0;
  const expectedNonce = currentNonce + 1;
  const newEntityState = cloneEntityState(entityState);

  newEntityState.nonces.set(from, expectedNonce);
  addMessage(newEntityState, `${from}: ${message}`);

  return { newState: newEntityState, outputs: [] };
};

export const handleChatMessageEntityTx = (entityState: EntityState, entityTx: EntityTxOf<'chatMessage'>): BasicEntityTxResult => {
  const { message } = entityTx.data;
  const newEntityState = cloneEntityState(entityState);

  addMessage(newEntityState, message);

  return { newState: newEntityState, outputs: [] };
};

export const handleProposeEntityTx = (entityState: EntityState, entityTx: EntityTxOf<'propose'>): BasicEntityTxResult => {
  const { action, proposer } = entityTx.data;
  const proposalId = generateProposalId(action, proposer, entityState);

  if (DEBUG) console.log(`    📝 Creating proposal ${proposalId} by ${proposer}: ${action.data.message}`);

  const proposal: Proposal = {
    id: proposalId,
    proposer,
    action,
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
    if (DEBUG) {
      console.log(
        `    ⚡ Proposal executed immediately - proposer has ${proposerPower} >= ${entityState.config.threshold} threshold`,
      );
    }
  } else if (DEBUG) {
    console.log(
      `    ⏳ Proposal pending votes - proposer has ${proposerPower} < ${entityState.config.threshold} threshold`,
    );
  }

  newEntityState.proposals.set(proposalId, proposal);
  return { newState: newEntityState, outputs: [] };
};

export const handleVoteEntityTx = (entityState: EntityState, entityTx: EntityTxOf<'vote'>): BasicEntityTxResult => {
  const { proposalId, voter, choice, comment } = entityTx.data;
  const proposal = entityState.proposals.get(proposalId);

  if (!proposal || proposal.status !== 'pending') {
    if (DEBUG) console.log(`    ❌ Vote ignored - proposal ${proposalId.slice(0, 12)}... not found or not pending`);
    return { newState: entityState, outputs: [] };
  }

  if (DEBUG) console.log(`    🗳️  Vote by ${voter}: ${choice} on proposal ${proposalId.slice(0, 12)}...`);

  const newEntityState = cloneEntityState(entityState);
  const updatedProposal = {
    ...proposal,
    votes: new Map(proposal.votes),
  };
  const voteData: 'yes' | 'no' | { choice: 'yes' | 'no'; comment: string } =
    comment !== undefined ? { choice, comment } : choice;
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
};

export const handleProfileUpdateEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'profile-update'>,
): BasicEntityTxResult => {
  const profileData = entityTx.data.profile;
  if (!profileData || profileData.entityId !== entityState.entityId) {
    throw new Error(`PROFILE_UPDATE_INVALID_ENTITY: expected=${entityState.entityId} got=${String(profileData?.entityId || '')}`);
  }
  const newState = cloneEntityState(entityState);
  newState.profile = {
    name: normalizeEntityName(profileData.name ?? newState.profile?.name, newState.entityId),
    isHub: newState.profile.isHub,
    avatar: typeof profileData.avatar === 'string' ? profileData.avatar : (newState.profile?.avatar ?? ''),
    bio: typeof profileData.bio === 'string' ? profileData.bio : (newState.profile?.bio ?? ''),
    website: typeof profileData.website === 'string' ? profileData.website : (newState.profile?.website ?? ''),
  };
  newState.timestamp = env.timestamp;

  if (env.gossip) {
    announceLocalEntityProfile(env, newState, env.timestamp);
  }

  return { newState, outputs: [] };
};

export const handleInitOrderbookExtEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'initOrderbookExt'>,
): BasicEntityTxResult => {
  if (entityState.orderbookExt) {
    return { newState: entityState, outputs: [] };
  }

  if (!validateSpreadDistribution(entityTx.data.spreadDistribution)) {
    log.error(`❌ Invalid spread distribution for initOrderbookExt on ${formatEntityId(entityState.entityId)}`);
    return { newState: entityState, outputs: [] };
  }

  const hubProfile = {
    entityId: entityState.entityId,
    name: entityTx.data.name,
    spreadDistribution: entityTx.data.spreadDistribution,
    referenceTokenId: entityTx.data.referenceTokenId,
    minTradeSize: entityTx.data.minTradeSize,
    supportedPairs: [...entityTx.data.supportedPairs],
  };

  const newState = cloneEntityState(entityState);
  newState.orderbookExt = createOrderbookExtState(hubProfile);

  return { newState, outputs: [] };
};
