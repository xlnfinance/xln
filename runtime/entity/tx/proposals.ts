import type { EntityState, Proposal, ProposalAction } from '../../types';
import { createHash } from '../../utils';
import { safeStringify } from '../../protocol/serialization';
import { createStructuredLogger, shortHash } from '../../infra/logger';

const proposalLog = createStructuredLogger('entity.basic');

export const generateProposalId = (action: ProposalAction, proposer: string, entityState: EntityState): string => {
  const proposalData = safeStringify({
    type: action.type,
    data: action.data,
    proposer,
    timestamp: entityState.timestamp,
  });

  const hash = createHash('sha256').update(proposalData).digest('hex');
  return `prop_${hash.slice(0, 12)}`;
};

export const executeProposal = (entityState: EntityState, proposal: Proposal): EntityState => {
  if (proposal.action.type === 'collective_message') {
    const message = `[COLLECTIVE] ${proposal.action.data.message}`;
    proposalLog.debug('proposal.execute_collective_message', { proposal: shortHash(proposal.id) });

    const newMessages = [...entityState.messages, message];

    if (newMessages.length > 10) {
      newMessages.shift();
    }

    return {
      ...entityState,
      messages: newMessages,
    };
  }
  return entityState;
};
