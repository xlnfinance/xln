import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityReplica , EntityFrameEvent } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { JPrefixCertificate } from '../../../types/jurisdiction-events';
import {
  ENTITY_FRAME_WIRE_EVENT_SLACK_BYTES,
  MAX_ENTITY_FRAME_TX_BYTES,
  createEntityFrameWirePrefixMeter,
  type EntityFrameWirePrefixMeter,
} from '../frame';
import { LIMITS } from '../../../config/constants';
import { getPrevFrameHash } from '../frame/lineage';
import { entityLog } from '../entity-log';
import { timePerfPhase } from '../../../support/performance/profile';
import { countOp } from '../../../support/performance/op-counters';
import { preparedHtlcBindingKey } from '../../../types/entity/htlc-infra-context';
import { collectInboundHtlcBindingKeys } from '../../htlc/materialize-context';
import { hasReplayEntityContext, materializeEntityInfraContext } from './infra-context';
import {
  hashEntityProposalTxPrefix,
  requireEntityProposalReplayOracleEntry,
} from './replay-oracle';

const DUMMY_ROOT = `0x${'00'.repeat(32)}`;
const MAX_FIT_ATTEMPTS = 16;


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
  measureTxs: (count: number) => number,
  initialCandidate: number,
  requiredPrefixCount = 0,
): EntityTx[] => {
  const maxBytes = proposalWireMaxBytes();
  let candidate = Math.min(
    allTxs.length,
    Math.max(1, initialCandidate, requiredPrefixCount),
  );
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
    const bytes = measure(candidate);
    const txBytes = measureTxs(candidate);
    if (bytes <= maxBytes && txBytes <= MAX_ENTITY_FRAME_TX_BYTES) {
      return allTxs.slice(0, candidate);
    }
    const ratio = Math.min(maxBytes / bytes, MAX_ENTITY_FRAME_TX_BYTES / txBytes);
    const scaled = Math.floor(candidate * 0.9 * ratio);
    const next = Math.min(candidate - 1, scaled);
    if (next < Math.max(1, requiredPrefixCount)) {
      throw new Error(
        requiredPrefixCount > 0
          ? `ENTITY_REQUIRED_TX_PREFIX_UNFITTABLE:${requiredPrefixCount}:${bytes}:${txBytes}`
          : txBytes > MAX_ENTITY_FRAME_TX_BYTES
          ? `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${txBytes}:${MAX_ENTITY_FRAME_TX_BYTES}`
          : `ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${bytes}:${maxBytes}`,
      );
    }
    candidate = next;
  }
  throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
};

/** Replay already has the WAL context; still drop the tail that exceeded the live wire budget. */
const fitTxsToPersistedWireContext = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  allTxs: EntityTx[],
  entityContext: EntityInfraContext,
  jPrefixCertificate: JPrefixCertificate | undefined,
  wirePrefixMeter?: EntityFrameWirePrefixMeter,
  requiredPrefixCount = 0,
): EntityTx[] => {
  if (allTxs.length === 0) return allTxs;
  const wire = proposalWireTemplate(env, replica, entityContext, jPrefixCertificate);
  const measurePrefix = wirePrefixMeter ?? createEntityFrameWirePrefixMeter(allTxs);
  measurePrefix.txBytes(allTxs.length);
  const measureBoundPrefix = measurePrefix.forRest(wire);
  const fitted = timePerfPhase('entity.wireFit.measure', () =>
    fitTxPrefixToMeasuredBytes(
      allTxs,
      measureBoundPrefix,
      measurePrefix.txBytes,
      allTxs.length,
      requiredPrefixCount,
    ),
  );
  const persistedKeys = new Set(
    entityContext.htlc.entries.map(entry => preparedHtlcBindingKey(entry.binding)),
  );
  const observedKeys = new Set<string>();
  let compatiblePrefixCount = 0;
  let completePrefixCount = persistedKeys.size === 0 ? 0 : -1;
  for (let index = 0; index < allTxs.length; index += 1) {
    const tx = allTxs[index];
    if (!tx) throw new Error(`ENTITY_REPLAY_TX_PREFIX_GAP:${index}`);
    const keys = collectInboundHtlcBindingKeys(replica.state, [tx]);
    if (keys.some(key => !persistedKeys.has(key))) break;
    for (const key of keys) observedKeys.add(key);
    compatiblePrefixCount = index + 1;
    if (completePrefixCount < 0 && observedKeys.size === persistedKeys.size) {
      completePrefixCount = compatiblePrefixCount;
    }
  }
  if (observedKeys.size !== persistedKeys.size || completePrefixCount < 0) {
    throw new Error(
      `ENTITY_REPLAY_HTLC_PREFIX_MISSING:` +
      `expected=${persistedKeys.size}:observed=${observedKeys.size}`,
    );
  }
  const replayCount = Math.min(fitted.length, compatiblePrefixCount);
  if (replayCount < Math.max(requiredPrefixCount, completePrefixCount)) {
    throw new Error(
      `ENTITY_REPLAY_HTLC_PREFIX_UNFITTABLE:` +
      `required=${Math.max(requiredPrefixCount, completePrefixCount)}:fitted=${replayCount}`,
    );
  }
  return allTxs.slice(0, replayCount);
};

const fitTxsToCertifiedReplayOracle = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  allTxs: EntityTx[],
  requiredPrefixCount: number,
): EntityTx[] | undefined => {
  const oracle = env.infrastructure?.replayEntityProposalOracle;
  if (!oracle) return undefined;
  const height = replica.state.height + 1;
  const entry = requireEntityProposalReplayOracleEntry(oracle, replica.entityId, height);
  if (entry.txCount < requiredPrefixCount) {
    throw new Error(`HLT_ENTITY_PROPOSAL_ORACLE_REQUIRED_PREFIX:${requiredPrefixCount}:${entry.txCount}`);
  }
  if (entry.txCount > allTxs.length) {
    throw new Error(`HLT_ENTITY_PROPOSAL_ORACLE_PREFIX_MISSING:${entry.txCount}:${allTxs.length}`);
  }
  const txs = allTxs.slice(0, entry.txCount);
  const actualHash = hashEntityProposalTxPrefix(replica.entityId, height, txs);
  if (actualHash !== entry.txPrefixHash) {
    throw new Error(`HLT_ENTITY_PROPOSAL_ORACLE_PREFIX_HASH_MISMATCH:${height}:${entry.txPrefixHash}:${actualHash}`);
  }
  return txs;
};

type EntityProposalWireBudgetParams = {
  env: EntityRuntimeContext;
  replica: EntityReplica;
  proposalTxs: EntityTx[];
  jPrefixCertificate?: JPrefixCertificate | undefined;
  usePersistedReplayContext: boolean;
  wirePrefixMeter?: EntityFrameWirePrefixMeter;
  /** Exact FIFO prefix ending at a Runtime-tagged atomic AccountInput. */
  requiredPrefixCount?: number;
};

/** Last certified wire bytes / tx bytes per Entity; a prediction, never a bound. */
const lastWireToTxByteRatio = new Map<string, number>();

const fitLiveEntityProposal = async (
  params: EntityProposalWireBudgetParams,
  requiredPrefixCount: number,
): Promise<{ txs: EntityTx[]; entityContext: EntityInfraContext; replayed: false }> =>
  timePerfPhase('entity.wireFit', async () => {
    const { env, replica } = params;
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
      proposalWireTemplate(env, replica, entityContext, params.jPrefixCertificate);
    const maxBytes = proposalWireMaxBytes();
    const measurePrefix = params.wirePrefixMeter ?? createEntityFrameWirePrefixMeter(allTxs);
    measurePrefix.txBytes(allTxs.length);
    // Always start from the whole mempool: the byte measurement below is the
    // only authority on what fits. A "last certified count" hint once capped the
    // first attempt at 1.15x the previous frame, which turned every lull into
    // a 30-frame slow start while hundreds of inputs waited (2026-08-22).
    // Each extra attempt re-materializes the whole HTLC context. The measured
    // wire/tx byte ratio of this Entity's last certified frame predicts where the
    // first attempt will land; tx bytes are exact from the prefix meter and the
    // loop below remains the only authority, so this is never a cap.
    let candidate = allTxs.length;
    const lastRatio = lastWireToTxByteRatio.get(replica.state.entityId);
    if (lastRatio !== undefined && measurePrefix.txBytes(allTxs.length) * lastRatio > maxBytes) {
      let low = Math.max(1, requiredPrefixCount);
      let high = allTxs.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const txBytes = measurePrefix.txBytes(mid);
        if (txBytes * lastRatio <= maxBytes && txBytes <= MAX_ENTITY_FRAME_TX_BYTES) low = mid;
        else high = mid - 1;
      }
      candidate = low;
    }
    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt += 1) {
      const slice = allTxs.slice(0, candidate);
      countOp('entity.wireFit.attempt', slice.length);
      const entityContext = await timePerfPhase(
        'entity.wireFit.materialize',
        () => materializeEntityInfraContext(env, replica, slice, { usePersistedReplayContext: false }),
      );
      const measureBoundPrefix = timePerfPhase(
        'entity.wireFit.measure',
        () => measurePrefix.forRest(rest(entityContext)),
      );
      const bytes = measureBoundPrefix(candidate);
      const txBytes = measurePrefix.txBytes(candidate);
      if (bytes <= maxBytes && txBytes <= MAX_ENTITY_FRAME_TX_BYTES) {
        if (txBytes > 0 && candidate >= 16) {
          lastWireToTxByteRatio.set(replica.state.entityId, bytes / txBytes);
        }
        if (requiredPrefixCount > 0 || slice.length >= 100 || slice.length < allTxs.length) {
          entityLog.info('proposal.wire_budget_fit', {
            entityId: replica.state.entityId,
            txs: slice.length,
            deferred: allTxs.length - slice.length,
            requiredPrefixCount,
            bytes,
            contextBytes: measureBoundPrefix(0),
            htlcEntries: entityContext.htlc.entries.length,
            originated: entityContext.htlc.originated.length,
            profiles: entityContext.gossipProfiles.length,
          });
        }
        return { txs: slice, entityContext, replayed: false };
      }
      const ratio = Math.min(maxBytes / bytes, MAX_ENTITY_FRAME_TX_BYTES / txBytes);
      const next = Math.min(candidate - 1, Math.floor(candidate * 0.9 * ratio));
      if (next < Math.max(1, requiredPrefixCount)) {
        throw new Error(
          requiredPrefixCount > 0
            ? `ENTITY_REQUIRED_TX_PREFIX_UNFITTABLE:${requiredPrefixCount}:${bytes}:${txBytes}`
            : txBytes > MAX_ENTITY_FRAME_TX_BYTES
            ? `ENTITY_FRAME_HEAD_TX_BYTE_LIMIT_EXCEEDED:${txBytes}:${MAX_ENTITY_FRAME_TX_BYTES}`
            : `ENTITY_FRAME_HEAD_WIRE_LIMIT_EXCEEDED:${bytes}:${maxBytes}`,
        );
      }
      candidate = next;
    }
    throw new Error('ENTITY_FRAME_WIRE_BUDGET_FIT_EXHAUSTED');
  });

/**
 * WAL replay must keep the exact stored txs. Live proposal defers the tail so
 * a Hub frame cannot halt on ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED after apply.
 *
 * Context size tracks the txs (HTLC routes → gossipProfiles). Measuring a
 * prefix against the full-mempool context underpacks; rematerialize then grow.
 */
export const fitEntityProposalToWireBudget = async (
  params: EntityProposalWireBudgetParams,
): Promise<{ txs: EntityTx[]; entityContext: EntityInfraContext; replayed: boolean }> => {
  const { env, replica, jPrefixCertificate, usePersistedReplayContext } = params;
  const requiredPrefixCount = params.requiredPrefixCount ?? 0;
  if (
    !Number.isSafeInteger(requiredPrefixCount) ||
    requiredPrefixCount < 0 ||
    requiredPrefixCount > params.proposalTxs.length
  ) {
    throw new Error(
      `ENTITY_WIRE_FIT_REQUIRED_PREFIX_INVALID:${requiredPrefixCount}:${params.proposalTxs.length}`,
    );
  }
  // Reuse the WAL context so replay does not rematerialize gossip/HTLC, but
  // still defer the mempool tail. Taking every current mempool tx here packed
  // the deferred consensusOutput into the same Entity frame, so live-head
  // replica meta (mempoolCount + certified head) diverged on restore.
  if (usePersistedReplayContext && hasReplayEntityContext(env, replica)) {
    const entityContext = await materializeEntityInfraContext(env, replica, params.proposalTxs, {
      usePersistedReplayContext: true,
    });
    return {
      txs: fitTxsToCertifiedReplayOracle(
        env,
        replica,
        params.proposalTxs,
        requiredPrefixCount,
      ) ?? fitTxsToPersistedWireContext(
        env,
        replica,
        params.proposalTxs,
        entityContext,
        jPrefixCertificate,
        params.wirePrefixMeter,
        requiredPrefixCount,
      ),
      entityContext,
      replayed: true,
    };
  }
  return fitLiveEntityProposal(params, requiredPrefixCount);
};
