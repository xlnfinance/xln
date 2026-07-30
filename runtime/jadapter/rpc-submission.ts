import type { Signer } from 'ethers';
import { ethers } from 'ethers';
import { safeStringify } from '../protocol/serialization';
import type { RuntimeState } from '../runtime/types';
import type { JTx } from '../types/jurisdiction-runtime';
import { makeJAdapterFailureResult } from './failure';
import { parseReceiptLogsToJEvents } from './j-event-log-decoder';
import { DEV_CHAIN_IDS } from './chain-ids';
import { buildDisputeStartDebug } from './rpc-batch-dispute-debug';
import {
  applyBatchFeeOverrides,
  planRpcBatchSubmission,
} from './rpc-batch-plan';
import { preflightProcessBatch } from './rpc-batch-preflight';
import { eventCarriers, watcherErrorDetails, watcherErrorMessage } from './rpc-boundary';
import type { RpcChainIo } from './rpc-chain-io';
import type { RpcContractStack } from './rpc-contract-stack';
import {
  PROCESS_BATCH_GAS_FLOOR,
  applyProcessBatchGasFloor,
  rpcLog,
} from './rpc-public';
import { submitDebtEnforcement, submitMint } from './rpc-submit-basic';
import { submitEntityProviderAction } from './rpc-submit-entity-provider';
import type { RpcTransactionSequencer } from './rpc-transaction-sequencer';
import type { JAdapter, JAdapterConfig, JSubmitResult } from './types';
import type { RpcWriteMethods } from './rpc-write-methods';
import type { RpcReceiptReaders } from './rpc-receipts';

type SubmitOptions = {
  env: RuntimeState;
  signerId?: string;
  signerPrivateKey?: Uint8Array;
  timestamp?: number;
};

type SubmissionContext = {
  config: JAdapterConfig;
  signer: Signer;
  watchOnly: boolean;
  chainIo: RpcChainIo;
  stack: RpcContractStack;
  sequencer: RpcTransactionSequencer;
  receipts: RpcReceiptReaders;
  writes: RpcWriteMethods;
};

const isLocalSnapshotRace = (context: SubmissionContext, error: unknown): boolean => {
  if (!DEV_CHAIN_IDS.has(context.config.chainId)) return false;
  const detail = safeStringify({
    message: watcherErrorMessage(error),
    details: watcherErrorDetails(error),
  });
  return /missing revert data|CALL_EXCEPTION|BlockOutOfRangeError|Failed to load state snapshot|No such file/i.test(
    detail,
  );
};

const resolveBatchSubmitter = async (
  context: SubmissionContext,
  signerPrivateKey: Uint8Array | undefined,
  requiresExternalSubmitter: boolean,
  normalizedEntityId: string,
  expectedExternalSignerId: string,
): Promise<Signer | null> => {
  if (context.watchOnly && !signerPrivateKey) {
    throw new Error(`JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:batch:${normalizedEntityId}`);
  }
  const submitter = signerPrivateKey && (context.watchOnly || requiresExternalSubmitter)
    ? await context.chainIo.signerForPrivateKey(ethers.hexlify(signerPrivateKey))
    : null;
  if (!requiresExternalSubmitter) return submitter;
  if (!submitter) throw new Error(`EXTERNAL_BATCH_SIGNER_KEY_MISSING:${normalizedEntityId}`);
  const walletAddress = await submitter.getAddress();
  if (walletAddress.toLowerCase() !== expectedExternalSignerId.toLowerCase()) {
    throw new Error(
      `EXTERNAL_BATCH_EOA_MISMATCH:${normalizedEntityId}:` +
        `expected=${expectedExternalSignerId}:wallet=${walletAddress}`,
    );
  }
  return submitter;
};

const executeBatchSubmission = async (
  context: SubmissionContext,
  planned: Extract<ReturnType<typeof planRpcBatchSubmission>, { kind: 'submit' }>,
  options: SubmitOptions,
): Promise<JSubmitResult> => {
  const plan = planned.plan;
  const submitter = await resolveBatchSubmitter(
    context,
    options.signerPrivateKey,
    plan.requiresExternalSubmitter,
    plan.normalizedEntityId,
    plan.expectedExternalSignerId,
  );
  const depository = submitter
    ? context.stack.depository.connect(submitter)
    : context.stack.depository;
  const data = plan.jTx.data;
  const entityNonce = BigInt(data.entityNonce);
  const disputeDebug = await buildDisputeStartDebug(plan.batch, plan.normalizedEntityId, {
    chainId: context.config.chainId,
    depositoryAddress: await context.stack.getDepositoryAddress(),
  });
  try {
    const estimate = await context.chainIo.estimateGasResult(
      () => depository.processBatch.estimateGas(data.encodedBatch, data.hankoSignature, entityNonce),
      PROCESS_BATCH_GAS_FLOOR,
    );
    const gasLimit = context.config.mode === 'tron'
      ? estimate.gasLimit
      : applyProcessBatchGasFloor(estimate.gasLimit, plan.batch.disputeFinalizations.length > 0);
    const preflightFailure = await preflightProcessBatch({
      depository,
      encodedBatch: data.encodedBatch,
      hankoData: data.hankoSignature,
      entityNonce,
      gasLimit,
      gasEstimateUsedFallback: estimate.usedFallback,
      disputeStartDebug: disputeDebug,
      isLocalSnapshotRace: error => isLocalSnapshotRace(context, error),
    });
    if (preflightFailure) return preflightFailure;
    const receipt = await context.sequencer.send(
      submitter ?? context.signer,
      'submitTx:processBatch',
      (nonce, fees) => depository.processBatch(
        data.encodedBatch,
        data.hankoSignature,
        entityNonce,
        { gasLimit, nonce, ...applyBatchFeeOverrides(fees, data.feeOverrides) },
      ),
    );
    if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
      throw new Error(`J_ADAPTER_MINED_RECEIPT_BLOCK_INVALID:${String(receipt.blockNumber)}`);
    }
    return {
      success: true,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      events: parseReceiptLogsToJEvents(
        receipt,
        eventCarriers(context.stack.depository, context.stack.entityProvider),
      ),
    };
  } catch (error) {
    rpcLog.error('process_batch.failed', {
      entityId: plan.normalizedEntityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return makeJAdapterFailureResult(error);
  }
};

const submitBatch = async (
  context: SubmissionContext,
  jTx: Extract<JTx, { type: 'batch' }>,
  options: SubmitOptions,
): Promise<JSubmitResult> => {
  let planned: ReturnType<typeof planRpcBatchSubmission>;
  try {
    planned = planRpcBatchSubmission(
      jTx,
      options.env,
      options.signerId,
      context.config.chainId,
      context.stack.addresses.depository,
    );
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
  if (planned.kind === 'skip') return { success: true };
  if (planned.kind === 'reject') return { success: false, error: planned.error };
  if (planned.plan.preflightIssues.length > 0) {
    rpcLog.warn('process_batch.preflight_issues', {
      entityId: planned.plan.normalizedEntityId,
      issues: planned.plan.preflightIssues,
    });
  }
  return context.sequencer.run(() => executeBatchSubmission(context, planned, options));
};

export const createRpcSubmitTx = (
  context: SubmissionContext,
): JAdapter['submitTx'] => async (jTx, options) => {
  console.log(`📤 [JAdapter:rpc] submitTx type=${jTx.type} entity=${jTx.entityId.slice(-4)}`);
  if (jTx.type === 'debtEnforcement') {
    return submitDebtEnforcement(jTx, context.writes.enforceDebts);
  }
  if (
    jTx.type === 'entityProviderTransfer' ||
    jTx.type === 'entityProviderReleaseControlShares' ||
    jTx.type === 'entityProviderCancelAction'
  ) {
    return submitEntityProviderAction(
      {
        chainId: context.config.chainId,
        watchOnly: context.watchOnly,
        signer: context.signer,
        entityProvider: context.stack.entityProvider,
        depository: context.stack.depository,
        getDepositoryAddress: () => context.stack.getDepositoryAddress(),
        getEntityProviderAddress: () => context.stack.getEntityProviderAddress(),
        signerForPrivateKey: context.chainIo.signerForPrivateKey,
        readActionReceipt: context.receipts.readEntityProviderActionReceipt,
        runSerialized: context.sequencer.run,
        estimateGas: context.chainIo.estimateGas,
        send: context.sequencer.send,
      },
      jTx,
      options.signerPrivateKey,
    );
  }
  if (jTx.type === 'batch') return submitBatch(context, jTx, options);
  if (jTx.type === 'mint') {
    return submitMint(jTx, DEV_CHAIN_IDS.has(context.config.chainId), context.writes.debugFundReserves);
  }
  const unhandledType: never = jTx;
  return { success: false, error: `Unknown JTx type: ${String(unhandledType)}` };
};
