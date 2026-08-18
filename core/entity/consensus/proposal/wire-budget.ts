import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityReplica } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { JPrefixCertificate } from '../../../types/jurisdiction-events';
import {
  ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
  selectEntityFrameTxPrefixForWireBudget,
} from '../frame';
import { getPrevFrameHash } from '../frame/lineage';
import { entityLog } from '../entity-log';
import { materializeEntityInfraContext } from './infra-context';

const DUMMY_ROOT = `0x${'00'.repeat(32)}`;
const MAX_FIT_ATTEMPTS = 16;

const isInfraByteLimit = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('ENTITY_INFRA_CONTEXT_BYTE_LIMIT_EXCEEDED');

const materializeOrHalve = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  txs: EntityTx[],
): Promise<{ txs: EntityTx[]; entityContext: EntityInfraContext } | { txs: EntityTx[] }> => {
  try {
    return {
      txs,
      entityContext: await materializeEntityInfraContext(env, replica, txs, {
        usePersistedReplayContext: false,
      }),
    };
  } catch (error) {
    if (!isInfraByteLimit(error) || txs.length <= 1) throw error;
    return { txs: txs.slice(0, Math.max(1, Math.floor(txs.length / 2))) };
  }
};

/**
 * WAL replay must keep the exact stored txs. Live proposal defers the tail so
 * a Hub frame cannot halt on ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED after apply.
 */
export const fitEntityProposalToWireBudget = async (params: {
  env: EntityRuntimeContext;
  replica: EntityReplica;
  proposalTxs: EntityTx[];
  jPrefixCertificate?: JPrefixCertificate;
  usePersistedReplayContext: boolean;
}): Promise<{ txs: EntityTx[]; entityContext: EntityInfraContext }> => {
  const { env, replica, jPrefixCertificate, usePersistedReplayContext } = params;
  if (usePersistedReplayContext) {
    return {
      txs: params.proposalTxs,
      entityContext: await materializeEntityInfraContext(env, replica, params.proposalTxs, {
        usePersistedReplayContext: true,
      }),
    };
  }
  let txs = params.proposalTxs;
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
    const materialized = await materializeOrHalve(env, replica, txs);
    if (!('entityContext' in materialized)) {
      txs = materialized.txs;
      continue;
    }
    const fitted = selectEntityFrameTxPrefixForWireBudget(txs, {
      prevFrameHash: getPrevFrameHash(replica.state),
      height: replica.state.height + 1,
      timestamp: env.state.timestamp,
      events: [],
      entityId: replica.state.entityId,
      stateRoot: DUMMY_ROOT,
      authorityRoot: DUMMY_ROOT,
      entityContext: materialized.entityContext,
      ...(jPrefixCertificate ? { jPrefixCertificate } : {}),
    });
    if (fitted.length === txs.length) return { txs, entityContext: materialized.entityContext };
    entityLog.info('proposal.wire_budget_deferred', {
      entityId: replica.state.entityId,
      selected: fitted.length,
      deferred: txs.length - fitted.length,
      slackBytes: ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
    });
    txs = fitted;
  }
  throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
};
