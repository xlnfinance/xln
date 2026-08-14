import type { Signer } from 'ethers';
import { ethers } from 'ethers';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { JTx } from '../../../../types/jurisdiction-runtime';
import { makeJAdapterFailureResult } from '../../core/failure';
import { parseReceiptLogsToJEvents } from '../../j-event-log-decoder';
import { DEV_CHAIN_IDS } from '../../chain-ids';
import { buildDisputeStartDebug } from './rpc-batch-dispute-debug';
import {
  applyBatchFeeOverrides,
  planRpcBatchSubmission,
} from './rpc-batch-plan';
import { preflightProcessBatch } from './rpc-batch-preflight';
import { eventCarriers } from '../rpc-boundary';
import type { RpcChainIo } from '../rpc-chain-io';
import type { RpcContractStack } from '../rpc-contract-stack';
import {
  resolveProcessBatchGasLimit,
  rpcLog,
} from '../../rpc-public';
import { submitDebtEnforcement, submitMint } from './rpc-submit-basic';
import {
  submitBoardActivation,
  submitControlBoardProposal,
  submitEntityProviderAction,
} from './rpc-submit-entity-provider';
import type { RpcTransactionSequencer } from './rpc-transaction-sequencer';
import type { JAdapter, JAdapterConfig, JSubmitResult } from '../../types';
import type { RpcWriteMethods } from './rpc-write-methods';
import type { RpcReceiptReaders } from '../rpc-receipts';
import type { JBatch } from '../../../machine/batch';
import { computeAccountKey } from '../../events/contract-codec';

type SubmitOptions = {
  env: RuntimeReplica;
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

type ProcessedBatchFailureReconciliation = {
  receipts: Pick<RpcReceiptReaders, 'hasProcessedBatch'>;
  entityId: string;
  batchHash: string;
  entityNonce: bigint;
  failure: JSubmitResult;
};

type CompetingFinalizationReconciliation = {
  receipts: Pick<RpcReceiptReaders, 'readDisputeFinalizationReceipt'>;
  entityId: string;
  counterentity: string;
  initialNonce: bigint;
  initialProofbodyHash: string;
  failure: JSubmitResult;
};

const NO_ACTIVE_DISPUTE_SELECTOR = ethers.id('E5()').slice(0, 10).toLowerCase();
const STALE_FINALIZATION_AWAITING_FINALITY = 'STALE_FINALIZATION_AWAITING_FINALITY';
const DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME =
  'DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME';

type FinalizationChainAccount = Readonly<{
  nonce: bigint;
  disputeHash: string;
  disputeTimeout: bigint;
  disputeInitialProofbodyHash: string;
  disputeStartedByLeft: boolean;
}>;

type TimedFinalization = JBatch['disputeFinalizations'][number];

/**
 * Runtime time may lead the jurisdiction head under parallel load. Solidity's
 * timeout is authoritative, so a timeout-only proof must not even be
 * simulated until that exact L1 deadline. Never generalize this to E2: E2 is
 * also used for malformed authority, nonce, and role failures.
 */
export const classifyFinalizationChainTimeGate = (
  finalization: TimedFinalization,
  account: FinalizationChainAccount,
  chainTimestamp: number,
): JSubmitResult | null => {
  const notBefore = finalization.submitNotBeforeTimestamp;
  if (notBefore === undefined) return null;
  if (!Number.isSafeInteger(notBefore) || notBefore <= 0) {
    throw new Error(`DISPUTE_FINALIZATION_NOT_BEFORE_INVALID:${String(notBefore)}`);
  }
  if (!Number.isSafeInteger(chainTimestamp) || chainTimestamp < 0) {
    throw new Error(`J_CHAIN_BLOCK_TIMESTAMP_INVALID:${String(chainTimestamp)}`);
  }
  // A competing finalizer may already have consumed the dispute. Let the
  // existing exact receipt/evidence reconciliation classify that E5 race.
  if (account.disputeHash.toLowerCase() === ethers.ZeroHash) return null;
  const mismatch =
    account.nonce !== BigInt(finalization.initialNonce)
    || account.disputeTimeout !== BigInt(notBefore)
    || account.disputeInitialProofbodyHash.toLowerCase()
      !== finalization.initialProofbodyHash.toLowerCase()
    || account.disputeStartedByLeft !== finalization.startedByLeft;
  if (mismatch) {
    throw new Error(
      `DISPUTE_FINALIZATION_CHAIN_IDENTITY_MISMATCH:`
      + `nonce=${account.nonce.toString()}/${finalization.initialNonce}:`
      + `timeout=${account.disputeTimeout.toString()}/${notBefore}:`
      + `hash=${account.disputeInitialProofbodyHash}/${finalization.initialProofbodyHash}:`
      + `startedByLeft=${String(account.disputeStartedByLeft)}/${String(finalization.startedByLeft)}`,
    );
  }
  if (chainTimestamp >= notBefore) return null;
  return makeJAdapterFailureResult(DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME, {
    category: 'transient',
    code: DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME,
    message: `${DISPUTE_FINALIZATION_AWAITING_CHAIN_TIME}:`
      + `head=${chainTimestamp}:notBefore=${notBefore}`,
  });
};

type FinalizationChainTimeGateReaders = Readonly<{
  batch: JBatch;
  readAccount(finalization: TimedFinalization): Promise<FinalizationChainAccount>;
  readLatestBlockTimestamp(): Promise<number>;
}>;

export const readFinalizationChainTimeGate = async (
  input: FinalizationChainTimeGateReaders,
): Promise<JSubmitResult | null> => {
  const timed = input.batch.disputeFinalizations.filter(
    finalization => finalization.submitNotBeforeTimestamp !== undefined,
  );
  if (timed.length === 0) return null;
  if (input.batch.disputeFinalizations.length !== 1 || timed.length !== 1) {
    throw new Error(
      `DISPUTE_FINALIZATION_CHAIN_GATE_CARDINALITY_INVALID:`
      + `${timed.length}/${input.batch.disputeFinalizations.length}`,
    );
  }
  const finalization = timed[0]!;
  const account = await input.readAccount(finalization);
  const chainTimestamp = await input.readLatestBlockTimestamp();
  return classifyFinalizationChainTimeGate(finalization, account, chainTimestamp);
};

const readSubmissionFinalizationChainTimeGate = async (
  context: SubmissionContext,
  planned: Extract<ReturnType<typeof planRpcBatchSubmission>, { kind: 'submit' }>,
): Promise<JSubmitResult | null> => {
  try {
    return await readFinalizationChainTimeGate({
      batch: planned.plan.batch,
      readAccount: finalization => context.stack.depository._accounts(computeAccountKey(
        planned.plan.normalizedEntityId,
        finalization.counterentity,
      )),
      readLatestBlockTimestamp: context.chainIo.readLatestBlockTimestamp,
    });
  } catch (error) {
    return makeJAdapterFailureResult(error);
  }
};

const nestedErrorRecords = (error: unknown): Array<Record<string, unknown>> => {
  const records: Array<Record<string, unknown>> = [];
  let current = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
  for (let depth = 0; current && depth < 5; depth += 1) {
    records.push(current);
    current = typeof current['error'] === 'object' && current['error'] !== null
      ? current['error'] as Record<string, unknown>
      : typeof current['info'] === 'object' && current['info'] !== null &&
          typeof (current['info'] as Record<string, unknown>)['error'] === 'object'
        ? (current['info'] as Record<string, unknown>)['error'] as Record<string, unknown>
        : null;
  }
  return records;
};

const hasNoActiveDisputeSelector = (error: unknown): boolean =>
  nestedErrorRecords(error).some(record => {
    const data = record['data'];
    return typeof data === 'string' && data.slice(0, 10).toLowerCase() === NO_ACTIVE_DISPUTE_SELECTOR;
  });

export const classifyCompetingFinalizationReceipt = (
  failure: JSubmitResult,
  receipt: Readonly<{ blockNumber: number; transactionHash: string }>,
): JSubmitResult => {
  if (failure.success) return failure;
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
    throw new Error('STALE_FINALIZATION_RECEIPT_BOUNDARY_INVALID');
  }
  // A globally visible receipt is not Runtime authority. The local watcher may
  // still be behind its finality-safe head (or its bounded poll range), and
  // Tron uses a distinct SolidityNode head. Only the authenticated J-event may
  // retire the immutable sent batch; the receipt merely proves that retrying
  // the same finalization must wait for watcher convergence.
  return makeJAdapterFailureResult(failure.error || 'competing dispute finalization', {
    category: 'transient',
    code: STALE_FINALIZATION_AWAITING_FINALITY,
    message: `${STALE_FINALIZATION_AWAITING_FINALITY}:` +
      `tx=${receipt.transactionHash}:block=${receipt.blockNumber}`,
  });
};

/**
 * A provider may lose a mined receipt and make the next static call fail with
 * an already-consumed nonce. Only the exact canonical event proves success;
 * any other consumed nonce remains the original failure.
 */
export const reconcileProcessedBatchFailure = async (
  input: ProcessedBatchFailureReconciliation,
): Promise<JSubmitResult> => {
  try {
    return await input.receipts.hasProcessedBatch(
      input.entityId,
      input.batchHash,
      input.entityNonce,
    )
      ? { success: true }
      : input.failure;
  } catch (error) {
    // Receipt authority is unavailable, so the outcome is unknown rather than
    // a proven terminal contradiction. Preserve the reader's failure class.
    return makeJAdapterFailureResult(error);
  }
};

export const reconcileCompetingFinalizationReceipt = async (
  input: CompetingFinalizationReconciliation,
): Promise<JSubmitResult> => {
  let receipt;
  try {
    receipt = await input.receipts.readDisputeFinalizationReceipt(
      input.entityId,
      input.counterentity,
      input.initialNonce,
      input.initialProofbodyHash,
    );
  } catch (error) {
    rpcLog.warn('competing_finalization.receipt_read_failed', {
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Unknown transport outcomes remain retryable; contradictory or malformed
    // receipt evidence remains a loud terminal integrity failure. Never hide
    // either class behind the original E5 revert.
    return makeJAdapterFailureResult(error);
  }
  return receipt ? classifyCompetingFinalizationReceipt(input.failure, receipt) : input.failure;
};

export const selectCompetingFinalization = (
  batch: JBatch,
): TimedFinalization | null =>
  batch.disputeFinalizations.length === 1
    ? batch.disputeFinalizations[0]!
    : null;

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

const reconcileCompetingFinalization = async (
  context: SubmissionContext,
  planned: Extract<ReturnType<typeof planRpcBatchSubmission>, { kind: 'submit' }>,
  failure: JSubmitResult,
  noActiveDispute: boolean,
): Promise<JSubmitResult> => {
  if (failure.success || !noActiveDispute) return failure;
  // The exact receipt only makes this finalization stale; it does not claim
  // that co-batched evidence or value operations were mined. Keep the whole
  // sealed batch transient until authenticated DisputeFinalized ingress
  // removes the stale finalization and deterministically requeues the rest.
  const finalization = selectCompetingFinalization(planned.plan.batch);
  if (!finalization) return failure;
  return reconcileCompetingFinalizationReceipt({
    receipts: context.receipts,
    entityId: planned.plan.normalizedEntityId,
    counterentity: finalization.counterentity,
    initialNonce: BigInt(finalization.initialNonce),
    initialProofbodyHash: finalization.initialProofbodyHash,
    failure,
  });
};

const executeBatchSubmission = async (
  context: SubmissionContext,
  planned: Extract<ReturnType<typeof planRpcBatchSubmission>, { kind: 'submit' }>,
  options: SubmitOptions,
): Promise<JSubmitResult> => {
  const plan = planned.plan;
  const chainTimeGate = await readSubmissionFinalizationChainTimeGate(context, planned);
  if (chainTimeGate) return chainTimeGate;
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
  const reconcileFailure = async (
    failure: JSubmitResult,
    noActiveDispute: boolean,
  ): Promise<JSubmitResult> => {
    const processed = await reconcileProcessedBatchFailure({
      receipts: context.receipts,
      entityId: plan.normalizedEntityId,
      batchHash: data.batchHash,
      entityNonce,
      failure,
    });
    // An exact absence returns the original object. Any replacement is already
    // classified receipt-authority evidence (including integrity failures) and
    // must not be overwritten by a second reconciliation source.
    if (processed.success || processed !== failure) return processed;
    return reconcileCompetingFinalization(context, planned, processed, noActiveDispute);
  };
  const disputeDebug = await buildDisputeStartDebug(plan.batch, plan.normalizedEntityId, {
    chainId: context.config.chainId,
    depositoryAddress: await context.stack.getDepositoryAddress(),
  });
  try {
    const estimatedGas = await context.chainIo.estimateGas(
      () => depository.processBatch.estimateGas(data.encodedBatch, data.hankoSignature, entityNonce),
    );
    const gasLimit = resolveProcessBatchGasLimit(
      estimatedGas,
      plan.batch,
      context.config.mode,
    );
    const preflightFailure = await preflightProcessBatch({
      depository,
      encodedBatch: data.encodedBatch,
      hankoData: data.hankoSignature,
      entityNonce,
      gasLimit,
      disputeStartDebug: disputeDebug,
    });
    if (preflightFailure) {
      return await reconcileFailure(
        preflightFailure,
        preflightFailure.failure?.code === 'NO_ACTIVE_DISPUTE',
      );
    }
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
    const failure = await reconcileFailure(
      makeJAdapterFailureResult(error),
      hasNoActiveDisputeSelector(error),
    );
    if (!failure.success) {
      // The Runtime owns the durable failure classification after one final
      // authenticated watcher poll. A counterparty may have finalized the
      // dispute while this RPC was in flight; logging an error here would
      // misclassify that externally ordered but protocol-valid event race.
      rpcLog.debug('process_batch.rejected', {
        entityId: plan.normalizedEntityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return failure;
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
  if (jTx.type === 'entityProviderProposeControlBoard') {
    return submitControlBoardProposal(
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
  if (jTx.type === 'entityProviderActivateBoard') {
    return submitBoardActivation(
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
