import { createHash, DEBUG } from '../utils';
export const generateProposalId = (action, proposer, entityState) => {
    const proposalData = JSON.stringify({
        type: action.type,
        data: action.data,
        proposer,
        timestamp: entityState.timestamp,
    });
    const hash = createHash('sha256').update(proposalData).digest('hex');
    return `prop_${hash.slice(0, 12)}`;
};
export const executeProposal = (entityState, proposal) => {
    if (proposal.action.type === 'collective_message') {
        const message = `[COLLECTIVE] ${proposal.action.data.message}`;
        if (DEBUG)
            console.log(`    🏛️  Executing collective proposal: "${message}"`);
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
