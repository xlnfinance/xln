/**
 * J-Broadcast Handler
 *
 * Entity broadcasts accumulated jBatch via entity consensus (hashesToSign pipeline).
 *
 * Flow:
 * 1. Validate batch is non-empty, jurisdiction configured
 * 2. Encode batch + compute batchHash (deterministic: uses tracked entity nonce)
 * 3. Create JTx WITHOUT hanko (will be attached post-commit by entity-consensus)
 * 4. Return hashesToSign with batchHash (type: 'jBatch')
 * 5. Entity consensus signs batchHash (single-signer shortcut or full multisig)
 * 6. Post-commit: entity-consensus attaches quorum hanko to JTx
 * 7. Runtime submits JTx via JAdapter
 */

import type { EntityState, EntityTx, EntityInput, Env, JTx, JInput, HashType } from '../../types';
import { cloneEntityState, addMessage } from '../../state-helpers';
import {
  isBatchEmpty, getBatchSize, cloneJBatch, encodeJBatch,
  computeBatchHankoHash, batchOpCount, createEmptyBatch,
} from '../../j-batch';
import type { ApplyEntityTxResult } from '../apply';

const ZERO_HASH_32 = `0x${'0'.repeat(64)}`;
const hasActiveDisputeHash = (hash: unknown): boolean => {
  const normalized = String(hash ?? '').toLowerCase();
  return normalized !== '' && normalized !== '0x' && normalized !== '0x0' && normalized !== ZERO_HASH_32;
};

function getEnvJAdapter(env: Env) {
  if (!env.jReplicas || env.jReplicas.size === 0) return null;
  const active = env.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction) : undefined;
  if (active?.jadapter) return active.jadapter;
  for (const replica of env.jReplicas.values()) {
    if (replica.jadapter) return replica.jadapter;
  }
  return null;
}

function resolveAccountByCounterparty(state: EntityState, counterpartyEntityId: string) {
  const target = String(counterpartyEntityId || '').toLowerCase();
  if (!target) return null;
  const direct = state.accounts.get(counterpartyEntityId);
  if (direct) return { key: counterpartyEntityId, account: direct };
  for (const [key, account] of state.accounts.entries()) {
    if (String(key || '').toLowerCase() === target) {
      return { key, account };
    }
  }
  return null;
}

async function pruneStaleDisputeFinalizations(
  state: EntityState,
  env: Env,
): Promise<{ removed: number; blocked: number }> {
  const jBatchState = state.jBatchState;
  if (!jBatchState) return { removed: 0, blocked: 0 };
  const finals = jBatchState.batch.disputeFinalizations || [];
  if (finals.length === 0) return { removed: 0, blocked: 0 };

  const jadapter = getEnvJAdapter(env);
  if (!jadapter || typeof jadapter.getAccountInfo !== 'function') {
    return { removed: 0, blocked: 0 };
  }

  const keep: typeof finals = [];
  let removed = 0;
  let blocked = 0;

  for (const op of finals) {
    const counterparty = String(op?.counterentity || '');
    if (!counterparty) {
      keep.push(op);
      continue;
    }
    try {
      const onchain = await jadapter.getAccountInfo(state.entityId, counterparty);
      if (!hasActiveDisputeHash(onchain.disputeHash)) {
        removed += 1;
        const found = resolveAccountByCounterparty(state, counterparty);
        if (found?.account?.activeDispute) {
          found.account.activeDispute.finalizeQueued = false;
          delete found.account.activeDispute;
        }
        continue;
      }
      keep.push(op);
    } catch {
      // Fail-closed: keep op if on-chain read is unavailable.
      blocked += 1;
      keep.push(op);
    }
  }

  if (removed > 0) {
    jBatchState.batch.disputeFinalizations = keep;
  }
  return { removed, blocked };
}

export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  env: Env
): Promise<ApplyEntityTxResult> {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const jOutputs: JInput[] = [];

  if (!newState.jBatchState) {
    const msg = '❌ No jBatchState found for j_broadcast';
    addMessage(newState, msg);
    throw new Error(msg);
  }

  if (newState.jBatchState.sentBatch) {
    const sent = newState.jBatchState.sentBatch;
    const msg = `❌ Cannot broadcast: sentBatch pending nonce=${sent.entityNonce} attempts=${sent.submitAttempts}`;
    addMessage(newState, msg);
    throw new Error(msg);
  }

  const { removed: removedStaleFinalizes, blocked: blockedFinalizeChecks } =
    await pruneStaleDisputeFinalizations(newState, env);
  if (removedStaleFinalizes > 0) {
    addMessage(
      newState,
      `🧹 Dropped ${removedStaleFinalizes} stale disputeFinalize op(s) before broadcast (already finalized on-chain)`,
    );
  }
  if (blockedFinalizeChecks > 0) {
    addMessage(
      newState,
      `ℹ️ disputeFinalize preflight skipped for ${blockedFinalizeChecks} op(s) due to on-chain read failure`,
    );
  }

  // ── Validate: jBatch exists and is non-empty ──
  if (isBatchEmpty(newState.jBatchState.batch)) {
    const msg = 'ℹ️ j_broadcast skipped: jBatch is empty';
    addMessage(newState, msg);
    return { newState, outputs, jOutputs };
  }

  // ── Validate: jurisdiction configured ──
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    addMessage(newState, '❌ No jurisdiction configured for this entity');
    return { newState, outputs, jOutputs };
  }

  const depositoryAddress = jurisdiction.depositoryAddress;
  const chainId = BigInt(jurisdiction.chainId ?? 0);
  if (!depositoryAddress || depositoryAddress === '0x0000000000000000000000000000000000000000') {
    addMessage(newState, '❌ Missing depository address');
    return { newState, outputs, jOutputs };
  }
  if (!chainId) {
    addMessage(newState, '❌ Missing chainId');
    return { newState, outputs, jOutputs };
  }

  // ── Validate: signerId available ──
  const signerId = entityState.config.validators[0];
  if (!signerId) {
    addMessage(newState, '❌ No signerId available');
    return { newState, outputs, jOutputs };
  }

  // ── Compute batch hash (deterministic: uses tracked confirmed nonce) ──
  // Entity nonce must only advance from finalized HankoBatchProcessed events.
  // Contract expects currentNonce + 1 for a new submission.
  const currentEntityNonce = BigInt(newState.jBatchState.entityNonce ?? 0);
  const nextNonce = currentEntityNonce + 1n;

  // Set entityProvider on settlements before encoding
  const entityProviderAddress = jurisdiction.entityProviderAddress;
  for (const settlement of newState.jBatchState.batch.settlements) {
    if (settlement.diffs.length > 0 || settlement.forgiveDebtsInTokenIds.length > 0) {
      settlement.entityProvider = entityProviderAddress;
    }
  }

  const encodedBatch = encodeJBatch(newState.jBatchState.batch);
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);

  const batchSize = getBatchSize(newState.jBatchState.batch);
  const opCount = batchOpCount(newState.jBatchState.batch);
  const jurisdictionName = jurisdiction.name || env.activeJurisdiction || 'default';

  console.log(`📤 j_broadcast: ${entityState.entityId.slice(-4)} | ${batchSize} ops | nonce=${nextNonce} | hash=${batchHash.slice(0, 10)}...`);
  console.log(
    `[REB][3][J_BROADCAST_SUBMIT] entity=${entityState.entityId.slice(-8)} nonce=${nextNonce} ops=${opCount} hash=${batchHash}`,
  );

  // ── Create JTx WITHOUT hanko (attached post-commit by entity-consensus) ──
  const jTx: JTx = {
    type: 'batch',
    entityId: entityState.entityId,
    data: {
      batch: cloneJBatch(newState.jBatchState.batch),
      batchHash,
      encodedBatch,
      entityNonce: Number(nextNonce),
      ...(entityTx.data?.feeOverrides ? { feeOverrides: { ...entityTx.data.feeOverrides } } : {}),
      batchSize,
      signerId,
    },
    timestamp: newState.timestamp,
  };

  jOutputs.push({
    jurisdictionName,
    jTxs: [jTx],
  });

  // ── Move current batch → sentBatch, clear current ──
  const firstSubmittedAt = newState.timestamp;
  newState.jBatchState.sentBatch = {
    batch: cloneJBatch(newState.jBatchState.batch),
    batchHash,
    encodedBatch,
    entityNonce: Number(nextNonce),
    firstSubmittedAt,
    lastSubmittedAt: firstSubmittedAt,
    submitAttempts: 1,
  };
  newState.jBatchState.batch = createEmptyBatch();

  // ── Update batch state metadata ──
  newState.jBatchState.broadcastCount++;
  newState.jBatchState.lastBroadcast = newState.timestamp;
  newState.jBatchState.status = 'sent';
  // IMPORTANT: do not advance entityNonce optimistically here.
  // If network submission fails, optimistic increment causes permanent nonce desync.
  // entityNonce is advanced only when HankoBatchProcessed is observed.

  addMessage(newState, `📤 Batch (${opCount} ops) → hashesToSign [nonce=${nextNonce}]`);

  // ── Return hashesToSign for entity consensus ──
  const hashesToSign: Array<{ hash: string; type: HashType; context: string }> = [{
    hash: batchHash,
    type: 'jBatch',
    context: `jBatch:${entityState.entityId.slice(-4)}:nonce:${nextNonce}`,
  }];

  return { newState, outputs, jOutputs, hashesToSign };
}
