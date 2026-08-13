import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import { shortId } from '../../../infra/logger';
import { nodeProcess } from '../../../infra/process/runtime-process';
import type { EntityTx } from '../../../types/entity-tx';
import { prepareLocallyAuthoredEntityTxs } from '../../command';
import { appendDefaultProposerCrossJMaterializations } from '../../transition/cross-j-proposer-materialization';
import { assertLocalJRebroadcastAllowed } from '../../tx/handlers/jurisdiction/j-rebroadcast';
import { prioritizeScheduledWakeTransactions } from './merge';
import type { ApplyEntityInputContext } from './types';
import {
  getEntityQuorumSafetyWarning,
  getReplicaProposalLeader,
  isReplicaProposalLeader,
} from '../leader';
import { entityLog } from '../entity-log';

export type EntityTransactionAdmission = {
  localCanPropose: boolean;
  trustedLocalEntityTxs: EntityTx[];
};

const addAdmittedTransactions = (
  context: ApplyEntityInputContext,
  admitted: EntityTx[],
  supplied: EntityTx[],
  localCanPropose: boolean,
  trustedLocalCrossJurisdiction: boolean,
): EntityTx[] => {
  const { env, workingReplica } = context;
  if (admitted.length === 0) return [];
  if (!localCanPropose && workingReplica.lastConsensusProgressAt === undefined) {
    workingReplica.lastConsensusProgressAt = env.state.timestamp;
  }
  const voteCount = supplied.filter(tx => tx.type === 'vote').length;
  if (voteCount > 0) {
    entityLog.debug('vote.mempool', {
      signer: shortId(workingReplica.signerId),
      count: voteCount,
    });
  }
  if (trustedLocalCrossJurisdiction) {
    if (!localCanPropose) {
      throw haltRuntimeFailure("CROSS_J_LOCAL_COMMAND_PROPOSER_REQUIRED", `CROSS_J_LOCAL_COMMAND_PROPOSER_REQUIRED:` +
          `${workingReplica.entityId}:${workingReplica.signerId}`);
    }
    return prepareLocallyAuthoredEntityTxs(
      env,
      workingReplica.state,
      workingReplica.signerId,
      admitted,
    );
  }
  workingReplica.mempool = prioritizeScheduledWakeTransactions(
    prepareLocallyAuthoredEntityTxs(
      env,
      workingReplica.state,
      workingReplica.signerId,
      [...workingReplica.mempool, ...admitted],
    ),
  );
  return [];
};

const forwardValidatorMempool = (
  context: ApplyEntityInputContext,
  localCanPropose: boolean,
): void => {
  const { entityInput, entityOutbox, workingReplica } = context;
  if (localCanPropose || workingReplica.mempool.length === 0) return;
  const proposerId = getReplicaProposalLeader(workingReplica).activeValidatorId;
  if (!proposerId) {
    throw new Error(
      `ENTITY_CONSENSUS_FATAL_PROPOSER_MISSING:` +
        workingReplica.state.config.validators.join(','),
    );
  }
  entityOutbox.push({
    entityId: entityInput.entityId,
    signerId: proposerId,
    entityTxs: [...workingReplica.mempool],
  });
  entityLog.debug('mempool.forwarded_to_proposer', {
    txs: workingReplica.mempool.length,
    proposer: shortId(proposerId),
  });
};

export const admitEntityTransactions = async (
  context: ApplyEntityInputContext,
  trustedLocalCrossJurisdiction: boolean,
): Promise<EntityTransactionAdmission> => {
  const { env, entityInput, workingReplica } = context;
  const warning = getEntityQuorumSafetyWarning(workingReplica.state.config);
  if (warning && workingReplica.state.height === 0) {
    entityLog.warn('board.quorum_safety', { warning });
  }
  const localCanPropose = isReplicaProposalLeader(workingReplica);
  workingReplica.isProposer = localCanPropose;
  if (
    localCanPropose &&
    entityInput.entityTxs?.some(tx => tx.type === 'j_rebroadcast')
  ) {
    assertLocalJRebroadcastAllowed(workingReplica);
  }

  const supplied = entityInput.entityTxs ?? [];
  const admitted = appendDefaultProposerCrossJMaterializations(
    env,
    workingReplica,
    supplied,
  );
  if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
    entityLog.info('replica_meta.admission_debug', {
      entityId: workingReplica.entityId,
      entityHeight: workingReplica.state.height,
      runtimeHeight: env.state.height,
      supplied: supplied.map(tx => tx.type),
      admitted: admitted.map(tx => tx.type),
      mempoolBefore: workingReplica.mempool.map(tx => tx.type),
    });
  }
  const trustedLocalEntityTxs = addAdmittedTransactions(
    context,
    admitted,
    supplied,
    localCanPropose,
    trustedLocalCrossJurisdiction,
  );
  if (admitted.length > 0) {
    entityLog.debug('mempool.added', {
      added: admitted.length,
      external: workingReplica.mempool.length,
      localRuntime: trustedLocalEntityTxs.length,
    });
  }
  forwardValidatorMempool(context, localCanPropose);
  return { localCanPropose, trustedLocalEntityTxs };
};
