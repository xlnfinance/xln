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
import { timePerfPhase } from '../../../support/performance/profile';
import { materializeEntityInfraContext } from './infra-context';
import type { EntityFrameEvent } from '../../types';

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
 *
 * Context size tracks the txs (HTLC routes → gossipProfiles). Measuring a
 * prefix against the full-mempool context underpacks; rematerialize then grow.
 */
export const fitEntityProposalToWireBudget = async (params: {
  env: EntityRuntimeContext;
  replica: EntityReplica;
  proposalTxs: EntityTx[];
  jPrefixCertificate?: JPrefixCertificate | undefined;
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
  return timePerfPhase('entity.wireFit', async () => {
    const allTxs = params.proposalTxs;
    if (allTxs.length === 0) {
      return {
        txs: allTxs,
        entityContext: await materializeEntityInfraContext(env, replica, allTxs, {
          usePersistedReplayContext: false,
        }),
      };
    }
    const rest = (entityContext: EntityInfraContext) => ({
      prevFrameHash: getPrevFrameHash(replica.state),
      height: replica.state.height + 1,
      timestamp: env.state.timestamp,
      events: [] as EntityFrameEvent[],
      entityId: replica.state.entityId,
      stateRoot: DUMMY_ROOT,
      authorityRoot: DUMMY_ROOT,
      entityContext,
      ...(jPrefixCertificate ? { jPrefixCertificate } : {}),
    });
    let knownFit = 0;
    let knownFail = allTxs.length + 1;
    let candidate = allTxs.length;
    let best: { txs: EntityTx[]; entityContext: EntityInfraContext } | undefined;
    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
      const slice = allTxs.slice(0, candidate);
      const materialized = await materializeOrHalve(env, replica, slice);
      if (!('entityContext' in materialized)) {
        knownFail = Math.min(knownFail, candidate);
        candidate = materialized.txs.length;
        continue;
      }
      const fitted = selectEntityFrameTxPrefixForWireBudget(slice, rest(materialized.entityContext));
      if (fitted.length === slice.length) {
        best = { txs: slice, entityContext: materialized.entityContext };
        knownFit = candidate;
        if (knownFit + 1 >= knownFail) return best;
        candidate = Math.min(allTxs.length, Math.floor((knownFit + knownFail) / 2));
        if (candidate <= knownFit) return best;
        continue;
      }
      entityLog.info('proposal.wire_budget_deferred', {
        entityId: replica.state.entityId,
        selected: fitted.length,
        deferred: slice.length - fitted.length,
        slackBytes: ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
      });
      knownFail = candidate;
      candidate = fitted.length;
      if (candidate <= knownFit) {
        if (best) return best;
        throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
      }
    }
    if (best) return best;
    throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
  });
};
