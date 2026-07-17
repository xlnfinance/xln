import { createOrderbookExtState, validateSpreadDistribution } from '../../../orderbook';
import type { EntityInput, EntityState, EntityTx, Env, Proposal } from '../../../types';
import { formatEntityId, log } from '../../../utils';
import { normalizeEntityName } from '../../../networking/gossip';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import {
  assertEntityProposalCapacity,
  executeProposal,
  generateProposalId,
  pruneTerminalEntityProposals,
} from '../proposals';
import {
  assertEntityProposalAction,
  hashEntityProposalAction,
  resolveCanonicalEntityBoardShares,
} from '../../authorization';
import { resolveEntityCommandBoard } from '../../command';
import { validateMessage } from '../validation';
import { createStructuredLogger, shortHash, shortId } from '../../../infra/logger';
import { buildCertifiedEntityOutput } from '../cross-j-outputs';
import { hashCertifiedEntityOutputSemantic } from '../../consensus/output-certification';

const basicLog = createStructuredLogger('entity.basic');

type BasicEntityTxResult = {
  newState: EntityState;
  outputs: EntityInput[];
  approvedEntityTxs?: EntityTx[];
};

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

export const handleChatEntityTx = (entityState: EntityState, entityTx: EntityTxOf<'chat'>): BasicEntityTxResult => {
  const { from, message } = entityTx.data;

  if (!validateMessage(message)) {
    log.error(`❌ Invalid chat message from ${from}`);
    return { newState: entityState, outputs: [] };
  }

  const newEntityState = cloneEntityState(entityState);
  addMessage(newEntityState, `${from}: ${message}`);

  return { newState: newEntityState, outputs: [] };
};

export const handleChatMessageEntityTx = (entityState: EntityState, entityTx: EntityTxOf<'chatMessage'>): BasicEntityTxResult => {
  const { message } = entityTx.data;
  const newEntityState = cloneEntityState(entityState);

  addMessage(newEntityState, message);

  return { newState: newEntityState, outputs: [] };
};

export const handleProposeEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'propose'>,
): BasicEntityTxResult => {
  const proposer = entityTx.data.proposer.trim().toLowerCase();
  const shares = resolveCanonicalEntityBoardShares(entityState.config);
  const proposerPower = shares.bySigner.get(proposer);
  if (proposerPower === undefined) throw new Error(`ENTITY_PROPOSAL_PROPOSER_UNKNOWN:${proposer}`);
  const board = resolveEntityCommandBoard(env, entityState);
  const action = assertEntityProposalAction(entityTx.data.action);
  assertEntityProposalCapacity(entityState, proposer);
  const proposalId = generateProposalId(env, action, proposer, entityState);
  if (entityState.proposals.has(proposalId)) throw new Error(`ENTITY_PROPOSAL_DUPLICATE:${proposalId}`);

  basicLog.debug('proposal.create', {
    proposal: shortHash(proposalId),
    proposer: shortId(proposer),
    action: action.type,
  });

  const proposal: Proposal = {
    id: proposalId,
    proposer,
    boardHash: board.boardHash,
    boardEpoch: board.boardEpoch,
    action,
    actionHash: hashEntityProposalAction(action),
    votes: new Map<string, 'yes' | 'no' | 'abstain' | { choice: 'yes' | 'no' | 'abstain'; comment: string }>([
      [proposer, 'yes'],
    ]),
    status: 'pending',
    created: entityState.timestamp,
  };

  const shouldExecuteImmediately = proposerPower >= entityState.config.threshold;
  let newEntityState = cloneEntityState(entityState);

  if (shouldExecuteImmediately) {
    proposal.status = 'executed';
    newEntityState = executeProposal(newEntityState, proposal);
    basicLog.debug('proposal.executed_immediately', {
      proposal: shortHash(proposalId),
      proposer: shortId(proposer),
      proposerPower: proposerPower.toString(),
      threshold: entityState.config.threshold.toString(),
    });
  } else {
    basicLog.debug('proposal.pending_votes', {
      proposal: shortHash(proposalId),
      proposer: shortId(proposer),
      proposerPower: proposerPower.toString(),
      threshold: entityState.config.threshold.toString(),
    });
  }

  newEntityState.proposals.set(proposalId, proposal);
  newEntityState = pruneTerminalEntityProposals(newEntityState);
  return {
    newState: newEntityState,
    outputs: [],
    ...(proposal.status === 'executed' && action.type === 'entity_transaction'
      ? { approvedEntityTxs: structuredClone(action.data.txs) }
      : {}),
  };
};

export const handleVoteEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'vote'>,
): BasicEntityTxResult => {
  const { proposalId, choice, comment } = entityTx.data;
  const voter = entityTx.data.voter.trim().toLowerCase();
  const proposal = entityState.proposals.get(proposalId);

  if (!proposal) throw new Error(`ENTITY_PROPOSAL_VOTE_TARGET_MISSING:${proposalId}`);
  if (proposal.status !== 'pending') throw new Error(`ENTITY_PROPOSAL_VOTE_NOT_PENDING:${proposalId}:${proposal.status}`);
  const shares = resolveCanonicalEntityBoardShares(entityState.config);
  if (!shares.bySigner.has(voter)) throw new Error(`ENTITY_PROPOSAL_VOTER_UNKNOWN:${voter}`);
  const board = resolveEntityCommandBoard(env, entityState);
  if (proposal.boardHash.toLowerCase() !== board.boardHash) {
    throw new Error(`ENTITY_PROPOSAL_BOARD_MISMATCH:${proposalId}:${proposal.boardHash}:${board.boardHash}`);
  }
  if (proposal.boardEpoch !== board.boardEpoch) {
    throw new Error(`ENTITY_PROPOSAL_EPOCH_MISMATCH:${proposalId}:${proposal.boardEpoch}:${board.boardEpoch}`);
  }
  if (proposal.votes.has(voter)) throw new Error(`ENTITY_PROPOSAL_DUPLICATE_VOTE:${proposalId}:${voter}`);

  basicLog.debug('vote.received', { proposal: shortHash(proposalId), voter: shortId(voter), choice });

  const newEntityState = cloneEntityState(entityState);
  const updatedProposal = {
    ...proposal,
    votes: new Map(proposal.votes),
  };
  const voteData: 'yes' | 'no' | { choice: 'yes' | 'no'; comment: string } =
    comment !== undefined ? { choice, comment } : choice;
  updatedProposal.votes.set(voter, voteData);

  const votePower = (choiceToCount: 'yes' | 'no'): bigint =>
    Array.from(updatedProposal.votes.entries()).reduce((total, [signerId, rawVote]) => {
      const vote = typeof rawVote === 'object' ? rawVote.choice : rawVote;
      return vote === choiceToCount ? total + shares.bySigner.get(signerId)! : total;
    }, 0n);
  const totalYesPower = votePower('yes');
  const totalNoPower = votePower('no');

  const totalShares = shares.total;
  const noPowerToBlockQuorum = totalShares - entityState.config.threshold + 1n;
  const percentage = ((Number(totalYesPower) / Number(entityState.config.threshold)) * 100).toFixed(1);
  basicLog.debug('vote.tally', {
    proposal: shortHash(proposalId),
    totalYesPower: totalYesPower.toString(),
    totalNoPower: totalNoPower.toString(),
    noPowerToBlockQuorum: noPowerToBlockQuorum.toString(),
    totalShares: totalShares.toString(),
    threshold: entityState.config.threshold.toString(),
    thresholdPercent: percentage,
  });

  if (totalYesPower >= entityState.config.threshold) {
    updatedProposal.status = 'executed';
    const executedState = executeProposal(newEntityState, updatedProposal);
    executedState.proposals.set(proposalId, updatedProposal);
    const boundedState = pruneTerminalEntityProposals(executedState);
    return {
      newState: boundedState,
      outputs: [],
      ...(updatedProposal.action.type === 'entity_transaction'
        ? { approvedEntityTxs: structuredClone(updatedProposal.action.data.txs) }
        : {}),
    };
  }

  // Reject as soon as the remaining possible yes power cannot reach the exact
  // threshold configured by this board.
  if (totalNoPower >= noPowerToBlockQuorum) {
    updatedProposal.status = 'rejected';
    newEntityState.proposals.set(proposalId, updatedProposal);
    return { newState: pruneTerminalEntityProposals(newEntityState), outputs: [] };
  }

  newEntityState.proposals.set(proposalId, updatedProposal);
  return { newState: newEntityState, outputs: [] };
};

export const handleReissueCertifiedOutputEntityTx = (
  _env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'reissueCertifiedOutput'>,
): BasicEntityTxResult => {
  const targetEntityId = String(entityTx.data.targetEntityId ?? '').trim().toLowerCase();
  const targetSignerId = String(entityTx.data.targetSignerId ?? '').trim().toLowerCase();
  const semanticHash = String(entityTx.data.semanticHash ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(targetEntityId)) {
    throw new Error(`CONSENSUS_OUTPUT_REISSUE_TARGET_INVALID:${targetEntityId || 'missing'}`);
  }
  if (!/^0x[0-9a-f]{40}$/.test(targetSignerId)) {
    throw new Error(`CONSENSUS_OUTPUT_REISSUE_TARGET_SIGNER_INVALID:${targetSignerId || 'missing'}`);
  }
  if (typeof entityTx.data.sequence !== 'bigint' || entityTx.data.sequence < 1n) {
    throw new Error(`CONSENSUS_OUTPUT_REISSUE_SEQUENCE_INVALID:${String(entityTx.data.sequence)}`);
  }
  if (!/^0x[0-9a-f]{64}$/.test(semanticHash)) {
    throw new Error(`CONSENSUS_OUTPUT_REISSUE_HASH_INVALID:${semanticHash || 'missing'}`);
  }
  if (!Array.isArray(entityTx.data.entityTxs) || entityTx.data.entityTxs.length === 0) {
    throw new Error('CONSENSUS_OUTPUT_REISSUE_PAYLOAD_REQUIRED');
  }
  const frontier = entityState.certifiedOutputSequences?.get(targetEntityId);
  if (!frontier) throw new Error(`CONSENSUS_OUTPUT_REISSUE_FRONTIER_MISSING:${targetEntityId}`);
  const computed = hashCertifiedEntityOutputSemantic(
    entityState.entityId,
    targetEntityId,
    'generic',
    entityTx.data.sequence,
    entityTx.data.entityTxs,
  );
  if (
    frontier.lastSequence !== entityTx.data.sequence ||
    frontier.lastSemanticHash.toLowerCase() !== semanticHash ||
    computed !== semanticHash
  ) {
    throw new Error(`CONSENSUS_OUTPUT_REISSUE_IDENTITY_MISMATCH:${targetEntityId}`);
  }
  const output = buildCertifiedEntityOutput(
    targetEntityId,
    targetSignerId,
    structuredClone(entityTx.data.entityTxs),
  );
  output.certifiedOutputIdentity = {
    lane: 'generic',
    sequence: entityTx.data.sequence,
    semanticHash,
  };
  return { newState: entityState, outputs: [output] };
};

export const handleProfileUpdateEntityTx = (
  _env: Env,
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
  // Reducer replay must never perform network I/O. The runtime lifecycle observes
  // the committed profile fingerprint and advertises only after quorum commit.
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
