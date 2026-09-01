import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import { shortId } from '../../../support/logger';
import { nodeProcess } from '../../../support/process/runtime-process';
import type { EntityTx } from '../../../types/entity-tx';
import { prepareLocallyAuthoredEntityTxs } from '../../command';
import { appendDefaultProposerCrossJMaterializations } from '../../transition/cross-j-proposer-materialization';
import { assertLocalJRebroadcastAllowed } from '../../tx/handlers/j-batch/j-rebroadcast';
import { prioritizeScheduledWakeTransactions } from './merge';
import type { ApplyEntityInputContext } from './types';
import {
  getEntityQuorumSafetyWarning,
  getReplicaProposalLeader,
  isReplicaProposalLeader,
} from '../leader';
import { entityLog } from '../entity-log';
import {
  getPendingBoardHandoverConfig,
  withBoardAuthority,
} from '../authority/board-handover';
import { txFingerprint } from '../../../protocol/state/tx-multiset';

export type EntityTransactionAdmission = {
  localCanPropose: boolean;
  trustedLocalEntityTxs: EntityTx[];
};

/**
 * A non-proposer may forward its retained mempool again while Entity consensus
 * is still certifying the frame. Exact Account inputs are transport retries,
 * not repeatable financial commands: their inner Account frame already owns
 * transaction multiplicity. Collapse only their complete wire fingerprint;
 * every other Entity transaction keeps its original order and multiplicity.
 * No committed-history set belongs here: a retry after commit must reach the
 * Account duplicate path so it can regenerate a peer ACK lost in transport.
 */
export const appendEntityMempoolTransactions = (
  mempool: readonly EntityTx[],
  admitted: readonly EntityTx[],
): EntityTx[] => {
  if (!admitted.some(tx => tx.type === 'accountInput')) return [...mempool, ...admitted];
  const seen = new Set(
    mempool.filter(tx => tx.type === 'accountInput').map(txFingerprint),
  );
  const appended = [...mempool];
  for (const tx of admitted) {
    if (tx.type !== 'accountInput') {
      appended.push(tx);
      continue;
    }
    const fingerprint = txFingerprint(tx);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    appended.push(tx);
  }
  return appended;
};

const addAdmittedTransactions = (
  context: ApplyEntityInputContext,
  admitted: EntityTx[],
  supplied: EntityTx[],
  localCanPropose: boolean,
  trustedLocalCrossJurisdiction: boolean,
): EntityTx[] => {
  const { env, workingReplica } = context;
  const deduped = appendEntityMempoolTransactions([], admitted);
  if (deduped.length === 0) return [];
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
      deduped,
    );
  }
  if (deduped.every(tx => tx.type === 'accountInput')) {
    // AccountInput is already authenticated/decoded at the Entity boundary and
    // is forbidden inside an EntityCommand. Old mempool entries were prepared
    // when first admitted; re-running the whole growing prefix through command
    // canonicalization made Hub ingress quadratic. Append the exact new
    // protocol delta and preserve FIFO order.
    workingReplica.mempool = appendEntityMempoolTransactions(
      workingReplica.mempool,
      deduped,
    );
    return [];
  }
  workingReplica.mempool = prioritizeScheduledWakeTransactions(
    prepareLocallyAuthoredEntityTxs(
      env,
      workingReplica.state,
      workingReplica.signerId,
      appendEntityMempoolTransactions(workingReplica.mempool, deduped),
    ),
  );
  return [];
};

const forwardValidatorMempool = (
  context: ApplyEntityInputContext,
  localCanPropose: boolean,
  authorityReplica: typeof context.workingReplica,
): void => {
  const { entityInput, entityOutbox, workingReplica } = context;
  if (localCanPropose || workingReplica.mempool.length === 0) return;
  const proposerId = getReplicaProposalLeader(authorityReplica).activeValidatorId;
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
  accountWorkOnly = false,
): Promise<EntityTransactionAdmission> => {
  const { env, entityInput, workingReplica } = context;
  const pendingConfig = getPendingBoardHandoverConfig(
    workingReplica.state,
    [...workingReplica.mempool, ...(entityInput.entityTxs ?? [])],
  );
  const authorityReplica = pendingConfig
    ? { ...workingReplica, state: withBoardAuthority(workingReplica.state, pendingConfig) }
    : workingReplica;
  const warning = getEntityQuorumSafetyWarning(authorityReplica.state.config);
  if (warning && workingReplica.state.height === 0) {
    entityLog.warn('board.quorum_safety', { warning });
  }
  const localCanPropose = isReplicaProposalLeader(authorityReplica);
  workingReplica.isProposer = localCanPropose;
  if (
    localCanPropose &&
    entityInput.entityTxs?.some(tx => tx.type === 'j_rebroadcast')
  ) {
    assertLocalJRebroadcastAllowed(workingReplica);
  }

  const supplied = entityInput.entityTxs ?? [];
  const admitted = accountWorkOnly
    ? []
    : appendDefaultProposerCrossJMaterializations(
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
  if (!accountWorkOnly) {
    forwardValidatorMempool(context, localCanPropose, authorityReplica);
  }
  return { localCanPropose, trustedLocalEntityTxs };
};
