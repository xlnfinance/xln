import { getSignerPrivateKeyIfAvailable } from '../../account/crypto';
import { extractEntityId, extractSignerId } from '../../ids';
import { createStructuredLogger } from '../../infra/logger';
import { isDeliveryDelivered } from '../../protocol/payments/delivery-result';
import type { Env } from '../../types';
import { ensureRuntimeState } from '../runtime-state';
import { finalizeReliableIngressCommit } from '../reliable-delivery';
import type { FrameExecutionState } from './execution-state';

const runtimeLog = createStructuredLogger('runtime');

export const collectLocallySignableEntityIds = (env: Env): Set<string> => {
  const entityIds = new Set<string>();
  for (const replicaKey of env.eReplicas.keys()) {
    const signerId = extractSignerId(replicaKey);
    if (!signerId || getSignerPrivateKeyIfAvailable(env, signerId) === null) continue;
    entityIds.add(extractEntityId(replicaKey).toLowerCase());
  }
  return entityIds;
};

export const runCommittedRecoveryBarrier = async (
  env: Env,
  frame: FrameExecutionState,
  remoteOutputCount: number,
  jSideEffectCount: number,
  runtimeInfraEffectCount: number,
): Promise<void> => {
  const barrier = ensureRuntimeState(env).recoveryBackupBarrier;
  const receiptCount = frame.reliableIngressCommits.reduce(
    (count, commit) => count + commit.targetRuntimeIds.length,
    0,
  );
  const remoteCount = remoteOutputCount + receiptCount;
  const jInputCount = jSideEffectCount + runtimeInfraEffectCount;
  if (!barrier || (remoteCount === 0 && jInputCount === 0)) return;
  try {
    await barrier(env, { height: env.height, remoteOutputCount: remoteCount, jInputCount });
  } catch (error) {
    env.error('system', 'RECOVERY_BACKUP_BARRIER_FAILED', {
      height: env.height,
      remoteOutputCount: remoteCount,
      jInputCount,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const finalizeCommittedReceiptDeliveries = (
  env: Env,
  frame: FrameExecutionState,
): void => {
  frame.reliableReceiptDeliveries = [
    ...frame.immediateReliableReceiptDeliveries,
    ...finalizeReliableIngressCommit(env, frame.reliableIngressCommits),
  ];
  const accountAcks = frame.reliableReceiptDeliveries
    .filter(delivery => delivery.receipt.body.identity.kind === 'account-ack')
    .map(delivery => ({
      targetRuntimeId: delivery.runtimeId,
      height: delivery.receipt.body.identity.height,
      coverage: delivery.receipt.body.coverage,
      entityId: delivery.receipt.body.identity.entityId,
    }));
  if (accountAcks.length > 0) {
    runtimeLog.info('reliable.account_receipts.finalized', { receipts: accountAcks });
  }
};

export const dispatchCommittedReceipts = (env: Env, frame: FrameExecutionState): void => {
  if (frame.reliableReceiptDeliveries.length === 0) return;
  const state = ensureRuntimeState(env);
  const p2p = state.p2p ?? null;
  for (const delivery of frame.reliableReceiptDeliveries) {
    const direct = state.directReliableReceiptDispatch?.(delivery.runtimeId, delivery.receipt);
    const usedDirect = Boolean(direct && isDeliveryDelivered(direct));
    const result = usedDirect
      ? direct
      : (p2p?.enqueueReliableReceiptDelivery(delivery.runtimeId, delivery.receipt) ?? direct);
    if (delivery.receipt.body.identity.kind === 'account-ack') {
      runtimeLog.info('reliable.account_receipt.dispatch', {
        targetRuntimeId: delivery.runtimeId,
        height: delivery.receipt.body.identity.height,
        coverage: delivery.receipt.body.coverage,
        transport: usedDirect ? 'direct' : 'p2p',
        delivered: Boolean(result && isDeliveryDelivered(result)),
        code: result?.code ?? null,
      });
    }
    if (!result || !isDeliveryDelivered(result)) {
      env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
        targetRuntimeId: delivery.runtimeId,
        delivery: result ?? null,
      });
    }
  }
};
