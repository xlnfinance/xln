import type { EntityState, Proposal, ProposalAction } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { createHash } from '../../../support/platform-crypto';
import { safeStringify } from '../../../protocol/serialization';
import { createStructuredLogger, shortHash } from '../../../support/logger';
import { canonicalEntityBoardSignerId, hashEntityProposalAction } from '../../auth/authorization';
import { addMessage } from '../../frame-events';
import { nextEntityCommandNonce, resolveEntityCommandBoard } from '../../command';
import { LIMITS } from '../../../config/constants';

const proposalLog = createStructuredLogger('entity.basic');

export const generateProposalId = (
  env: EntityRuntimeContext,
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

const MAX_PENDING_ENTITY_PROPOSALS = LIMITS.MAX_PENDING_PROPOSALS_PER_ENTITY;

export const assertEntityProposalCapacity = (state: EntityState, rawProposer: string): void => {
  const proposer = canonicalEntityBoardSignerId(rawProposer);
  if (state.proposals.size >= MAX_PENDING_ENTITY_PROPOSALS) {
    throw new Error(
      `ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED:${state.proposals.size}:${MAX_PENDING_ENTITY_PROPOSALS}`,
    );
  }
  const existing = Array.from(state.proposals.values())
    .find(proposal => canonicalEntityBoardSignerId(proposal.proposer) === proposer);
  if (existing) {
    throw new Error(`ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT:${proposer}:${existing.id}`);
  }
};

/**
 * A board rotation is a new governance authority namespace. Pending work from
 * the old board is deleted: presence means live, while the certified Entity
 * frame history is the terminal audit record. Retaining executed/rejected
 * proposal bodies in every future root would turn history into unbounded live
 * consensus state and duplicate the Runtime WAL.
 */
export const normalizeEntityProposalBoard = (env: EntityRuntimeContext, state: EntityState): EntityState => {
  if (state.proposals.size === 0) return state;
  const currentBoard = resolveEntityCommandBoard(env, state);
  let proposals: Map<string, Proposal> | undefined;
  for (const [id, proposal] of state.proposals) {
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
    proposals.delete(id);
  }
  return proposals ? { ...state, proposals } : state;
};

export const executeProposal = (entityState: EntityState, proposal: Proposal): EntityState => {
  if (proposal.action.type === 'collective_message') {
    const message = `[COLLECTIVE] ${proposal.action.data.message}`;
    proposalLog.debug('proposal.execute_collective_message', { proposal: shortHash(proposal.id) });

    const nextState = { ...entityState };
    addMessage(nextState, message);
    return nextState;
  }
  return entityState;
};
