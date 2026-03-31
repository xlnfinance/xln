import type { EntityInput, EntityState, EntityTx, Env, HashType, JInput, JTx } from '../../types';
import { requireUsableContractAddress } from '../../contract-address';
import { addMessage, cloneEntityState } from '../../state-helpers';
import { batchOpCount, cloneJBatch, computeBatchHankoHash, encodeJBatch, isBatchEmpty } from '../../j-batch';
import { resolveRuntimeJurisdictionConfig } from '../../jurisdiction-runtime';
import type { ApplyEntityTxResult } from '../apply';

const MIN_GAS_BUMP_BPS = 0;
const MAX_GAS_BUMP_BPS = 20_000; // +200%

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
): Promise<ApplyEntityTxResult> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState?.sentBatch) {
    const msg = '⚠️ j_rebroadcast skipped: no sentBatch';
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }

  const sent = newState.jBatchState.sentBatch;
  const signerId = entityState.config.validators[0];
  if (!signerId) {
    const msg = '❌ No signerId available for j_rebroadcast';
    addMessage(newState, msg);
    throw new Error(msg);
  }

  const gasBumpBps = normalizeGasBumpBps(entityTx.data.gasBumpBps);
  const jurisdiction = resolveRuntimeJurisdictionConfig(env, newState.config.jurisdiction);
  if (!jurisdiction) {
    const msg = '❌ No jurisdiction configured for j_rebroadcast';
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
  const jurisdictionName = jurisdiction.name || env.activeJurisdiction || 'default';
  // j_rebroadcast must stay dumb on purpose:
  // resend the current sentBatch exactly as stored, without revalidation, filtering,
  // or any state-dependent mutation. Stale cleanup belongs to the transition paths
  // that move ops into or out of sentBatch, not to rebroadcast.
  const rebroadcastBatch = cloneJBatch(sent.batch);
  if (isBatchEmpty(rebroadcastBatch)) {
    newState.jBatchState.sentBatch = undefined;
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
  sent.submitAttempts += 1;
  sent.lastSubmittedAt = newState.timestamp;
  newState.jBatchState.lastBroadcast = newState.timestamp;
  newState.jBatchState.broadcastCount += 1;
  newState.jBatchState.status = 'sent';

  addMessage(
    newState,
    `📤 Rebroadcast sentBatch nonce=${sent.entityNonce} attempt=${sent.submitAttempts}` +
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
