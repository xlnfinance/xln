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

const executeSingleBoard = async (
  env: RuntimeReplica,
  actor: CompanyActor,
  txs: EntityTx[],
): Promise<void> => {
  const proposer = requireValidator(actor, 0);
  await processWithOffline(env, [{
    entityId: actor.id,
    signerId: proposer,
    entityTxs: txs,
  }], new Set());
  // A single-signer action can immediately emit J-events observed by a
  // multi-validator target Entity. Drain that certified prefix fanout too;
  // stopping when only the origin proposal is executed leaves the target's
  // read model behind the chain event this action just produced.
  await converge(env, 50);
  const pending = requireReplica(env, actor.id, proposer).state.proposals.size;
  if (pending !== 0) {
    throw new Error(`COMPANY_SINGLE_BOARD_GOVERNANCE_NOT_DRAINED:${actor.id}:${pending}`);
  }
};

export const executeCompanyAction = async (
  env: RuntimeReplica,
  actor: CompanyActor,
  txs: EntityTx[],
): Promise<void> => {
  if (actor.config.threshold === 1n) return executeSingleBoard(env, actor, txs);
  if (actor.config.threshold !== 2n || actor.validators.length !== 3) {
    throw new Error(`COMPANY_BOARD_SHAPE_UNSUPPORTED:${actor.config.threshold}:${actor.validators.length}`);
  }
  await executeCollectiveWithVotes(env, {
    entityId: actor.id,
    validators: actor.validators,
    proposer: requireValidator(actor, 0),
    voters: [requireValidator(actor, 1)],
    txs,
    offlineSigners: new Set(),
    convergenceCycles: 50,
  });
};
