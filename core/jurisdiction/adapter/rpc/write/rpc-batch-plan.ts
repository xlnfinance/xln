import { normalizeEntityId } from '../../../../entity/id';
import { isBatchEmpty, preflightBatchForE2, type JBatch } from '../../../machine/batch';
import { assertSealedJBatchBinding, type SealedBatchJTx } from '../../../machine/batch/sealed-batch';
import { resolveEntityProposerId } from '../../../../runtime/delivery/entity-output-signer';
import type { JTx } from '../../../../types/jurisdiction-runtime';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { FeeOverrides } from '../rpc-boundary';

type BatchJTx = Extract<JTx, { type: 'batch' }>;

type RpcBatchSubmissionPlan = {
  jTx: SealedBatchJTx;
  batch: JBatch;
  normalizedEntityId: string;
  requiresExternalSubmitter: boolean;
  expectedExternalSignerId: string;
  preflightIssues: readonly string[];
};

export type RpcBatchPlanResult =
  { kind: 'skip' } | { kind: 'reject'; error: string } | { kind: 'submit'; plan: RpcBatchSubmissionPlan };

type RequestedFeeOverrides = Extract<JTx, { type: 'batch' }>['data']['feeOverrides'];

export const applyBatchFeeOverrides = (base: FeeOverrides, requested: RequestedFeeOverrides): FeeOverrides => {
  const fees = { ...base };
  if (requested?.maxFeePerGasWei) {
    fees.maxFeePerGas = BigInt(requested.maxFeePerGasWei);
  }
  if (requested?.maxPriorityFeePerGasWei) {
    fees.maxPriorityFeePerGas = BigInt(requested.maxPriorityFeePerGasWei);
  }
  if (!requested?.gasBumpBps || requested.gasBumpBps <= 0) return fees;

  const factor = 10_000n + BigInt(Math.floor(requested.gasBumpBps));
  if (fees.maxFeePerGas) {
    fees.maxFeePerGas = (fees.maxFeePerGas * factor + 9_999n) / 10_000n;
  }
  if (fees.maxPriorityFeePerGas) {
    fees.maxPriorityFeePerGas = (fees.maxPriorityFeePerGas * factor + 9_999n) / 10_000n;
  }
  return fees;
};

export const planRpcBatchSubmission = (
  jTx: BatchJTx,
  env: RuntimeReplica,
  signerId: string | undefined,
  chainId: number,
  depositoryAddress: string,
): RpcBatchPlanResult => {
  assertSealedJBatchBinding(jTx, { chainId, depositoryAddress });
  const { batch } = jTx.data;
  if (isBatchEmpty(batch)) return { kind: 'skip' };

  const normalizedEntityId = normalizeEntityId(jTx.entityId);
  for (const settlement of batch.settlements) {
    if (
      (settlement.diffs.length > 0 || settlement.forgiveDebtsInTokenIds.length > 0) &&
      settlement.sig === '0x'
    ) {
      return { kind: 'reject', error: 'Settlement missing hanko sig' };
    }
  }

  const requiresExternalSubmitter = batch.externalTokenToReserve.length > 0;
  const expectedExternalSignerId = requiresExternalSubmitter
    ? resolveEntityProposerId(env, normalizedEntityId, 'jadapter.rpc.submitTx.external-batch')
    : '';
  const effectiveExternalSignerId = requiresExternalSubmitter ? String(signerId || jTx.data.signerId || '').trim() : '';
  if (requiresExternalSubmitter && !effectiveExternalSignerId) {
    return {
      kind: 'reject',
      error: `EXTERNAL_BATCH_SIGNER_MISSING:${normalizedEntityId}`,
    };
  }
  if (requiresExternalSubmitter && expectedExternalSignerId.toLowerCase() !== effectiveExternalSignerId.toLowerCase()) {
    return {
      kind: 'reject',
      error:
        `EXTERNAL_BATCH_SIGNER_MISMATCH:${normalizedEntityId}` +
        `:expected=${expectedExternalSignerId}` +
        `:got=${effectiveExternalSignerId}`,
    };
  }

  return {
    kind: 'submit',
    plan: {
      jTx,
      batch,
      normalizedEntityId,
      requiresExternalSubmitter,
      expectedExternalSignerId,
      preflightIssues: preflightBatchForE2(normalizedEntityId, batch),
    },
  };
};
