import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityReplica , EntityFrameEvent } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { JPrefixCertificate } from '../../../types/jurisdiction-events';
import {
  ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
  createEntityFrameWirePrefixMeter,
} from '../frame';
import { LIMITS } from '../../../config/constants';
import { getPrevFrameHash } from '../frame/lineage';
import { entityLog } from '../entity-log';
import { timePerfPhase } from '../../../support/performance/profile';
import { hasReplayEntityContext, materializeEntityInfraContext } from './infra-context';

const DUMMY_ROOT = `0x${'00'.repeat(32)}`;
const MAX_FIT_ATTEMPTS = 16;

const isInfraByteLimit = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('ENTITY_INFRA_CONTEXT_BYTE_LIMIT_EXCEEDED');

const proposalWireMaxBytes = (): number =>
  LIMITS.MAX_FRAME_SIZE_BYTES
  - ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES
  - Math.floor(LIMITS.MAX_FRAME_SIZE_BYTES / 10);

const proposalWireTemplate = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityContext: EntityInfraContext,
  jPrefixCertificate: JPrefixCertificate | undefined,
) => ({
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

const fitTxPrefixToMeasuredBytes = (
  allTxs: EntityTx[],
  measure: (count: number) => number,
  initialCandidate: number,
): EntityTx[] => {
  const maxBytes = proposalWireMaxBytes();
  let candidate = Math.min(allTxs.length, Math.max(1, initialCandidate));
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
    const bytes = measure(candidate);
    if (bytes <= maxBytes) return allTxs.slice(0, candidate);
    const scaled = Math.floor(candidate * 0.9 * maxBytes / bytes);
    const next = Math.min(candidate - 1, scaled);
    if (next < 1) {
      throw new Error(`ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${bytes}:${maxBytes}`);
    }
    candidate = next;
  }
  throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
};

const fitHintKeyFor = (replica: EntityReplica): string =>
  `${replica.entityId.trim().toLowerCase()}:${replica.signerId.trim().toLowerCase()}`;

export const selectInitialEntityWireFitCount = (
  txCount: number,
  fitHint: number | undefined,
): number => {
  if (!Number.isSafeInteger(txCount) || txCount < 0) {
    throw new Error(`ENTITY_WIRE_FIT_TX_COUNT_INVALID:${txCount}`);
  }
  if (fitHint !== undefined && (!Number.isSafeInteger(fitHint) || fitHint < 0)) {
    throw new Error(`ENTITY_WIRE_FIT_HINT_INVALID:${fitHint}`);
  }
  if (txCount === 0) return 0;
  return fitHint !== undefined
    ? Math.max(1, Math.min(txCount, Math.ceil(fitHint * 1.15)))
    : txCount;
};

const initialFitCandidate = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  allTxs: EntityTx[],
): number => {
  const fitHint = env.infrastructure?.wireBudgetFitHints?.get(fitHintKeyFor(replica));
  // Hint is the last *sealed* tx count, not the empty-events fit. It only
  // ever narrows the first attempt, never widens it. Empty frames may record
  // zero; that must not starve the first later Account ACK forever.
  return selectInitialEntityWireFitCount(allTxs.length, fitHint);
};

/** Last sealed Entity-frame tx count. Empty-events fit must not write this. */
export const recordEntityWireBudgetFitHint = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  fittedCount: number,
): void => {
  if (!env.infrastructure) return;
  (env.infrastructure.wireBudgetFitHints ??= new Map()).set(fitHintKeyFor(replica), fittedCount);
};

/** Replay already has the WAL context; still drop the tail that exceeded the live wire budget. */
const fitTxsToPersistedWireContext = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  allTxs: EntityTx[],
  entityContext: EntityInfraContext,
  jPrefixCertificate: JPrefixCertificate | undefined,
): EntityTx[] => {
  if (allTxs.length === 0) return allTxs;
  const wire = proposalWireTemplate(env, replica, entityContext, jPrefixCertificate);
  const measurePrefix = createEntityFrameWirePrefixMeter(allTxs);
  const measureBoundPrefix = measurePrefix.forRest(wire);
  const fitted = timePerfPhase('entity.wireFit.measure', () =>
    fitTxPrefixToMeasuredBytes(
      allTxs,
      measureBoundPrefix,
      initialFitCandidate(env, replica, allTxs),
    ),
  );
  return fitted;
};

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
}): Promise<{ txs: EntityTx[]; entityContext: EntityInfraContext; replayed: boolean }> => {
  const { env, replica, jPrefixCertificate, usePersistedReplayContext } = params;
  // Reuse the WAL context so replay does not rematerialize gossip/HTLC, but
  // still defer the mempool tail. Taking every current mempool tx here packed
  // the deferred consensusOutput into the same Entity frame, so live-head
  // replica meta (mempoolCount + certified head) diverged on restore.
  if (usePersistedReplayContext && hasReplayEntityContext(env, replica)) {
    const entityContext = await materializeEntityInfraContext(env, replica, params.proposalTxs, {
      usePersistedReplayContext: true,
    });
    return {
      txs: fitTxsToPersistedWireContext(
        env,
        replica,
        params.proposalTxs,
        entityContext,
        jPrefixCertificate,
      ),
      entityContext,
      replayed: true,
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
        replayed: false,
      };
    }
    const rest = (entityContext: EntityInfraContext) =>
      proposalWireTemplate(env, replica, entityContext, jPrefixCertificate);
    // Slack covers applied events; the sealed frame also carries hashesToSign,
    // collectedSigs and hankos (~5-10% at 350 account inputs), so keep another
    // tenth in reserve — a post-apply overflow costs a full re-apply.
    const maxBytes = proposalWireMaxBytes();
    const measurePrefix = createEntityFrameWirePrefixMeter(allTxs);
    let candidate = initialFitCandidate(env, replica, allTxs);
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
      const measureBoundPrefix = timePerfPhase('entity.wireFit.measure', () => measurePrefix.forRest(wire));
      const bytes = measureBoundPrefix(candidate);
      if (bytes <= maxBytes) {
        if (slice.length >= 100 || slice.length < allTxs.length) {
          entityLog.info('proposal.wire_budget_fit', {
            entityId: replica.state.entityId,
            txs: slice.length,
            deferred: allTxs.length - slice.length,
            bytes,
            contextBytes: measureBoundPrefix(0),
            htlcEntries: materialized.entityContext.htlc.entries.length,
            originated: materialized.entityContext.htlc.originated.length,
            profiles: materialized.entityContext.gossipProfiles.length,
          });
        }
        return { txs: slice, entityContext: materialized.entityContext, replayed: false };
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
