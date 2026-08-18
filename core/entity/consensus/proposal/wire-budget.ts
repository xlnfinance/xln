import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityReplica } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { JPrefixCertificate } from '../../../types/jurisdiction-events';
import {
  ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
  measureEntityFrameWireBytes,
} from '../frame';
import { LIMITS } from '../../../config/constants';
import { getPrevFrameHash } from '../frame/lineage';
import { entityLog } from '../entity-log';
import { timePerfPhase } from '../../../support/performance/profile';
import { hasReplayEntityContext, materializeEntityInfraContext } from './infra-context';
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
  // Replay must keep the exact stored txs; a live proposal (no stored context
  // for this height) must be fitted even when the flag allows replay reuse —
  // skipping the fit here let 14 MB frames through to the post-apply check.
  if (usePersistedReplayContext && hasReplayEntityContext(env, replica)) {
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
    const maxBytes = LIMITS.MAX_FRAME_SIZE_BYTES - ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES;
    let candidate = allTxs.length;
    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
      const slice = allTxs.slice(0, candidate);
      const materialized = await materializeOrHalve(env, replica, slice);
      if (!('entityContext' in materialized)) {
        candidate = materialized.txs.length;
        continue;
      }
      // Context bytes track the txs (one HTLC entry per forwarded lock), so a
      // prefix must be re-materialized before it is measured; scale the prefix
      // by the measured ratio instead of binary-searching against a context
      // built for the whole slice.
      const wire = rest(materialized.entityContext);
      const bytes = measureEntityFrameWireBytes({ ...wire, txs: slice });
      if (bytes <= maxBytes) {
        if (slice.length >= 100 || slice.length < allTxs.length) {
          entityLog.info('proposal.wire_budget_fit', {
            entityId: replica.state.entityId,
            txs: slice.length,
            deferred: allTxs.length - slice.length,
            bytes,
            contextBytes: measureEntityFrameWireBytes({ ...wire, txs: [] }),
            htlcEntries: materialized.entityContext.htlc.entries.length,
            originated: materialized.entityContext.htlc.originated.length,
            profiles: materialized.entityContext.gossipProfiles.length,
          });
        }
        return { txs: slice, entityContext: materialized.entityContext };
      }
      const scaled = Math.floor(candidate * 0.9 * maxBytes / bytes);
      const next = Math.min(candidate - 1, scaled);
      if (next < 1) {
        throw new Error(`ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${bytes}:${maxBytes}`);
      }
      candidate = next;
    }
    throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
  });
};
