import type { EntityState, Env, Proposal, ProposalAction } from '../../types';
import { createHash } from '../../utils';
import { safeStringify } from '../../protocol/serialization';
import { createStructuredLogger, shortHash } from '../../infra/logger';
import { canonicalEntityBoardSignerId, hashEntityProposalAction } from '../authorization';
import { addMessage } from '../../state-helpers';
import { nextEntityCommandNonce, resolveEntityCommandBoard } from '../command';
import { LIMITS } from '../../constants';

const proposalLog = createStructuredLogger('entity.basic');

export const generateProposalId = (
  env: Env,
  action: ProposalAction,
  proposer: string,
  entityState: EntityState,
): string => {
  const actionHash = hashEntityProposalAction(action);
  const canonicalProposer = canonicalEntityBoardSignerId(proposer);
  const board = resolveEntityCommandBoard(env, entityState);
  // Timestamp is shared by every transaction in an Entity frame. It therefore
  // cannot distinguish two intentional same-action commands in that frame.
  // The signed per-board-epoch command nonce is already the exact replay fence: an
  // exact retry is skipped before this function, while a new nonce is a new
  // governance intent even when its action bytes are identical.
  const commandNonce = nextEntityCommandNonce(
    entityState,
    board.boardHash,
    board.boardEpoch,
    canonicalProposer,
  );
  const proposalData = safeStringify({
    actionHash,
    proposer: canonicalProposer,
    boardHash: board.boardHash,
    boardEpoch: board.boardEpoch,
    commandNonce,
  });

  const hash = createHash('sha256').update(proposalData).digest('hex');
  return `prop_${hash}`;
};

export const MAX_PENDING_ENTITY_PROPOSALS = LIMITS.MAX_PENDING_PROPOSALS_PER_ENTITY;
export const MAX_TERMINAL_ENTITY_PROPOSALS = LIMITS.MAX_TERMINAL_PROPOSALS_PER_ENTITY;

export const assertEntityProposalCapacity = (state: EntityState, rawProposer: string): void => {
  const proposer = canonicalEntityBoardSignerId(rawProposer);
  const pending = Array.from(state.proposals.values())
    .filter(proposal => proposal.status === 'pending').length;
  if (pending >= MAX_PENDING_ENTITY_PROPOSALS) {
    throw new Error(`ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED:${pending}:${MAX_PENDING_ENTITY_PROPOSALS}`);
  }
  const existing = Array.from(state.proposals.values())
    .find(proposal =>
      proposal.status === 'pending' &&
      canonicalEntityBoardSignerId(proposal.proposer) === proposer,
    );
  if (existing) {
    throw new Error(`ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT:${proposer}:${existing.id}`);
  }
};

export const pruneTerminalEntityProposals = (state: EntityState): EntityState => {
  const terminal = Array.from(state.proposals.values())
    .filter(proposal => proposal.status !== 'pending')
    .sort((left, right) => left.created - right.created || left.id.localeCompare(right.id));
  const removeCount = Math.max(0, terminal.length - MAX_TERMINAL_ENTITY_PROPOSALS);
  if (removeCount === 0) return state;
  const proposals = new Map(state.proposals);
  for (const proposal of terminal.slice(0, removeCount)) proposals.delete(proposal.id);
  return { ...state, proposals };
};

/**
 * A board rotation is a new governance authority namespace. Old-board pending
 * proposals must remain as terminal forensic evidence, but can never consume
 * capacity or be completed by the new board.
 */
export const normalizeEntityProposalBoard = (env: Env, state: EntityState): EntityState => {
  if (!Array.from(state.proposals.values()).some(proposal => proposal.status === 'pending')) {
    return pruneTerminalEntityProposals(state);
  }
  const currentBoard = resolveEntityCommandBoard(env, state);
  let proposals: Map<string, Proposal> | undefined;
  for (const [id, proposal] of state.proposals) {
    if (proposal.status !== 'pending') continue;
    const proposalBoardHash = String(proposal.boardHash ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(proposalBoardHash)) {
      throw new Error(`ENTITY_PROPOSAL_BOARD_HASH_INVALID:${id}:${proposalBoardHash || 'missing'}`);
    }
    if (!Number.isSafeInteger(proposal.boardEpoch) || proposal.boardEpoch < 0) {
      throw new Error(`ENTITY_PROPOSAL_BOARD_EPOCH_INVALID:${id}:${String(proposal.boardEpoch)}`);
    }
    if (
      proposalBoardHash === currentBoard.boardHash &&
      proposal.boardEpoch === currentBoard.boardEpoch
    ) continue;
    proposals ??= new Map(state.proposals);
    proposals.set(id, { ...proposal, status: 'rejected' });
  }
  return pruneTerminalEntityProposals(proposals ? { ...state, proposals } : state);
};

export const executeProposal = (entityState: EntityState, proposal: Proposal): EntityState => {
  if (proposal.action.type === 'collective_message') {
    const message = `[COLLECTIVE] ${proposal.action.data.message}`;
    proposalLog.debug('proposal.execute_collective_message', { proposal: shortHash(proposal.id) });

    const nextState = { ...entityState, messages: [...entityState.messages] };
    addMessage(nextState, message);
    return nextState;
  }
  return entityState;
};
