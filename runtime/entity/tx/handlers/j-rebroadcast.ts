import type { EntityInput, EntityReplica, EntityState, EntityTx, Env, HashType, JInput, JTx } from '../../../types';
import { requireUsableContractAddress } from '../../../jurisdiction/contract-address';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import { batchOpCount, cloneJBatch, computeBatchHankoHash, encodeJBatch, isBatchEmpty } from '../../../jurisdiction/batch';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../../jurisdiction/jurisdiction-runtime';
import type { EntityTxReducerResult } from '../apply';
import { getEntityLeaderState } from '../../consensus/leader';

const MIN_GAS_BUMP_BPS = 0;
const MAX_GAS_BUMP_BPS = 20_000; // +200%

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

/**
 * Reject a terminal local retry at proposer ingress, before it enters Entity
 * consensus. Validator-local receipts cannot be read by deterministic frame
 * replay: doing so would make replicas apply the same frame differently.
 */
export const assertLocalJRebroadcastAllowed = (replica: EntityReplica): void => {
  const sent = replica.state.jBatchState?.sentBatch;
  if (sent?.terminalFailure) {
    throw new Error(
      `❌ Cannot rebroadcast quarantined J-submit nonce=${sent.entityNonce}: ${sent.terminalFailure.message}. ` +
      'Abort it explicitly after reviewing the finalized conflicting batch.',
    );
  }
  const local = replica.jSubmitState;
  if (
    !sent ||
    !local?.terminalFailure ||
    normalizeId(local.batchHash) !== normalizeId(sent.batchHash) ||
    local.entityNonce !== sent.entityNonce ||
    local.batchGeneration !== replica.state.jBatchState?.broadcastCount
  ) return;
  throw new Error(
    `❌ Cannot rebroadcast terminal J-submit nonce=${sent.entityNonce}: ${local.terminalFailure.message}. ` +
    'Abort or rebuild the sent batch before submitting again.',
  );
};

function normalizeGasBumpBps(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.floor(n);
  if (rounded < MIN_GAS_BUMP_BPS) return MIN_GAS_BUMP_BPS;
  if (rounded > MAX_GAS_BUMP_BPS) return MAX_GAS_BUMP_BPS;
  return rounded;
}

export async function handleJRebroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_rebroadcast' }>,
  env: Env,
): Promise<EntityTxReducerResult> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState?.sentBatch) {
    const msg = '⚠️ j_rebroadcast skipped: no sentBatch';
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }

  const sent = newState.jBatchState.sentBatch;
  if (sent.terminalFailure) {
    const msg =
      `❌ Cannot rebroadcast quarantined jBatch nonce=${sent.entityNonce}: ${sent.terminalFailure.message}`;
    addMessage(newState, msg);
    throw new Error(msg);
  }
  const signerId = getEntityLeaderState(entityState).activeValidatorId;
  if (!signerId) {
    const msg = '❌ No signerId available for j_rebroadcast';
    addMessage(newState, msg);
    throw new Error(msg);
  }

  const gasBumpBps = normalizeGasBumpBps(entityTx.data.gasBumpBps);
  const configuredJurisdictionName = getJurisdictionConfigName(newState.config.jurisdiction);
  if (!configuredJurisdictionName) {
    const msg = '❌ No jurisdiction configured for j_rebroadcast';
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }

  let jurisdiction;
  try {
    jurisdiction = requireRuntimeJurisdictionConfigByName(
      env,
      configuredJurisdictionName,
      newState.config.jurisdiction,
    );
  } catch (error) {
    const msg = `❌ Jurisdiction unavailable for j_rebroadcast: ${error instanceof Error ? error.message : String(error)}`;
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }
  const depositoryAddress = requireUsableContractAddress('depository', jurisdiction.depositoryAddress);
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  if (!chainId) {
    const msg = '❌ Missing chainId for j_rebroadcast';
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }
  const jurisdictionName = jurisdiction.name;
  const batchGeneration = newState.jBatchState.broadcastCount + 1;
  // j_rebroadcast must stay dumb on purpose:
  // resend the current sentBatch exactly as stored, without revalidation, filtering,
  // or any state-dependent mutation. Stale cleanup belongs to the transition paths
  // that move ops into or out of sentBatch, not to rebroadcast.
  const rebroadcastBatch = cloneJBatch(sent.batch);
  if (isBatchEmpty(rebroadcastBatch)) {
    delete newState.jBatchState.sentBatch;
    newState.jBatchState.status = isBatchEmpty(newState.jBatchState.batch) ? 'empty' : 'accumulating';
    addMessage(newState, `🧹 j_rebroadcast cleared empty stale sentBatch nonce=${sent.entityNonce}`);
    return { newState, outputs, jOutputs };
  }
  const encodedBatch = encodeJBatch(rebroadcastBatch);
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, BigInt(sent.entityNonce));

  const jTx: JTx = {
    type: 'batch',
    entityId: entityState.entityId,
    data: {
      batch: cloneJBatch(rebroadcastBatch),
      batchHash,
      encodedBatch,
      entityNonce: sent.entityNonce,
      batchGeneration,
      batchSize: batchOpCount(rebroadcastBatch),
      signerId,
      ...(gasBumpBps !== undefined
        ? { feeOverrides: { gasBumpBps } }
        : {}),
    },
    timestamp: newState.timestamp,
  };

  jOutputs.push({ jurisdictionName, jTxs: [jTx] });

  sent.batch = cloneJBatch(rebroadcastBatch);
  sent.batchHash = batchHash;
  sent.encodedBatch = encodedBatch;
  // Attempt counters are validator-local and are advanced only by the
  // replayable retryJSubmit RuntimeTx before external I/O.
  if (gasBumpBps !== undefined) sent.feeOverrides = { gasBumpBps };
  newState.jBatchState.lastBroadcast = newState.timestamp;
  newState.jBatchState.broadcastCount = batchGeneration;
  newState.jBatchState.status = 'sent';

  addMessage(
    newState,
    `📤 Rebroadcast intent queued nonce=${sent.entityNonce}` +
      (gasBumpBps !== undefined ? ` bump=${gasBumpBps}bps` : ''),
  );

  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [
    {
      hash: batchHash,
      type: 'jBatch',
      context: `jBatch:${entityState.entityId.slice(-4)}:nonce:${sent.entityNonce}:rebroadcast`,
    },
  ];

  return { newState, outputs, jOutputs, hashesToSign };
}
