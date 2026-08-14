/**
 * Routes every company operation through the same Entity governance path used
 * in production. A one-member board executes its proposal immediately; a
 * 2-of-3 board records independent votes before the action can mutate state.
 */

import type { RuntimeReplica } from '../../runtime/types';
import type { EntityTx } from '../../types/entity-tx';
import { executeCollectiveWithVotes, requireReplica } from '../consensus/multi-sig';
import { converge, processWithOffline } from '../harness/helpers';
import type { CompanyActor } from './model';

const requireValidator = (actor: CompanyActor, index: number): string => {
  const validator = actor.validators[index];
  if (!validator) throw new Error(`COMPANY_BOARD_VALIDATOR_MISSING:${actor.id}:${index}`);
  return validator;
};

const newestProposalId = (before: Set<string>, actor: CompanyActor, env: RuntimeReplica): string => {
  const proposal = [...requireReplica(env, actor.id, requireValidator(actor, 0)).state.proposals.values()]
    .find(candidate => !before.has(candidate.id));
  if (!proposal) throw new Error(`COMPANY_GOVERNANCE_PROPOSAL_MISSING:${actor.id}`);
  return proposal.id;
};

const executeSingleBoard = async (
  env: RuntimeReplica,
  actor: CompanyActor,
  txs: EntityTx[],
): Promise<string> => {
  const proposer = requireValidator(actor, 0);
  const replica = requireReplica(env, actor.id, proposer);
  const before = new Set(replica.state.proposals.keys());
  await processWithOffline(env, [{
    entityId: actor.id,
    signerId: proposer,
    entityTxs: txs,
  }], new Set());
  await converge(env, 20);
  const proposalId = newestProposalId(before, actor, env);
  const proposal = requireReplica(env, actor.id, proposer).state.proposals.get(proposalId);
  if (proposal?.status !== 'executed') {
    throw new Error(`COMPANY_SINGLE_BOARD_ACTION_NOT_EXECUTED:${proposalId}:${proposal?.status ?? 'missing'}`);
  }
  return proposalId;
};

export const executeCompanyAction = async (
  env: RuntimeReplica,
  actor: CompanyActor,
  txs: EntityTx[],
): Promise<string> => {
  if (actor.config.threshold === 1n) return executeSingleBoard(env, actor, txs);
  if (actor.config.threshold !== 2n || actor.validators.length !== 3) {
    throw new Error(`COMPANY_BOARD_SHAPE_UNSUPPORTED:${actor.config.threshold}:${actor.validators.length}`);
  }
  return executeCollectiveWithVotes(env, {
    entityId: actor.id,
    validators: actor.validators,
    proposer: requireValidator(actor, 0),
    voters: [requireValidator(actor, 1)],
    txs,
    offlineSigners: new Set(),
    convergenceCycles: 50,
  });
};
