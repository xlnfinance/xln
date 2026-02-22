import type { EntityInput, EntityState, EntityTx, Env, HashType, JInput, JTx } from '../../types';
import { addMessage, cloneEntityState } from '../../state-helpers';
import { batchOpCount, cloneJBatch } from '../../j-batch';
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
  const jurisdictionName =
    entityState.config.jurisdiction?.name || env.activeJurisdiction || 'default';

  const jTx: JTx = {
    type: 'batch',
    entityId: entityState.entityId,
    data: {
      batch: cloneJBatch(sent.batch),
      batchHash: sent.batchHash,
      encodedBatch: sent.encodedBatch,
      entityNonce: sent.entityNonce,
      batchSize: batchOpCount(sent.batch),
      signerId,
      ...(gasBumpBps !== undefined
        ? { feeOverrides: { gasBumpBps } }
        : {}),
    },
    timestamp: newState.timestamp,
  };

  jOutputs.push({ jurisdictionName, jTxs: [jTx] });

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
      hash: sent.batchHash,
      type: 'jBatch',
      context: `jBatch:${entityState.entityId.slice(-4)}:nonce:${sent.entityNonce}:rebroadcast`,
    },
  ];

  return { newState, outputs, jOutputs, hashesToSign };
}
