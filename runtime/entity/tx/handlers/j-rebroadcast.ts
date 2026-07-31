import type { EntityInput, EntityReplica, EntityState, HashType } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../types/entity-tx';
import type { JTx } from '../../../types/jurisdiction-runtime';
import { requireUsableContractAddress } from '../../../jurisdiction/machine/contract-address';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { batchOpCount, cloneJBatch, computeBatchHankoHash, encodeJBatch, isBatchEmpty } from '../../../jurisdiction/machine/batch';
import {
  getJurisdictionConfigName,
  requireRuntimeJurisdictionConfigByName,
} from '../../../jurisdiction/machine/jurisdiction-runtime';
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

const resolveRebroadcastJurisdiction = (
  env: EntityRuntimeContext,
  state: EntityState,
): { name: string; chainId: bigint; depositoryAddress: string } | undefined => {
  const configuredName = getJurisdictionConfigName(state.config.jurisdiction);
  if (!configuredName) {
    addMessage(state, '❌ No jurisdiction configured for j_rebroadcast');
    return undefined;
  }
  try {
    const jurisdiction = requireRuntimeJurisdictionConfigByName(
      env,
      configuredName,
      state.config.jurisdiction,
    );
    const chainId = BigInt(jurisdiction.chainId ?? 0);
    if (!chainId) {
      addMessage(state, '❌ Missing chainId for j_rebroadcast');
      return undefined;
    }
    return {
      name: jurisdiction.name,
      chainId,
      depositoryAddress: requireUsableContractAddress(
        'depository',
        jurisdiction.depositoryAddress,
      ),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addMessage(state, `❌ Jurisdiction unavailable for j_rebroadcast: ${detail}`);
    return undefined;
  }
};

const buildRebroadcastJTx = (
  entityState: EntityState,
  signerId: string,
  batchGeneration: number,
  gasBumpBps: number | undefined,
  batch: ReturnType<typeof cloneJBatch>,
  batchHash: string,
  encodedBatch: string,
): JTx => {
  const sent = entityState.jBatchState!.sentBatch!;
  return {
    type: 'batch',
    entityId: entityState.entityId,
    data: {
      batch: cloneJBatch(batch),
      batchHash,
      encodedBatch,
      entityNonce: sent.entityNonce,
      batchGeneration,
      batchSize: batchOpCount(batch),
      signerId,
      ...(gasBumpBps !== undefined ? { feeOverrides: { gasBumpBps } } : {}),
    },
    timestamp: entityState.timestamp,
  };
};

export async function handleJRebroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_rebroadcast' }>,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<EntityTxReducerResult> {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
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
  const jurisdiction = resolveRebroadcastJurisdiction(env, newState);
  if (!jurisdiction) return { newState, outputs, jOutputs };
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
  const batchHash = computeBatchHankoHash(
    jurisdiction.chainId,
    jurisdiction.depositoryAddress,
    encodedBatch,
    BigInt(sent.entityNonce),
  );
  const jTx = buildRebroadcastJTx(
    newState,
    signerId,
    batchGeneration,
    gasBumpBps,
    rebroadcastBatch,
    batchHash,
    encodedBatch,
  );

  jOutputs.push({ jurisdictionName: jurisdiction.name, jTxs: [jTx] });

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
