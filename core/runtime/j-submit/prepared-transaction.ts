import { authorizedEvmFeeLimits, signedEvmFeeLimits, withinEvmFeeLimits } from './evm/evm-fee-authorization';
import { validateEvmReplacement } from './evm/evm-fees';
import { validateTronReplacement } from '../../jurisdiction/adapter/operations/tron-replacement';
import { completedJSubmitAttempt } from './j-submit-state';
import { ethers } from 'ethers';
import { Depository__factory } from '../../../jurisdictions/typechain-types';
import { compactHankoForChain } from '../../hanko/short';
import { assertSealedJBatchBinding } from '../../jurisdiction/machine/batch/sealed-batch';
import { decodeSignedTronTransaction } from '../../jurisdiction/adapter/operations/tron-transaction';
import { validatePreparedTransaction } from '../../jurisdiction/adapter/rpc/write/prepared/durable-transaction';
import type { RuntimeReplica, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import type { JTx } from '../../types/jurisdiction-runtime';

type Batch = Extract<JTx, { type: 'batch' }>;
const contract = Depository__factory.createInterface();

export const decodePreparedJTransaction = (raw: string, nativeTron: boolean) =>
  nativeTron ? decodeSignedTronTransaction(raw) : ethers.Transaction.from(raw);

export const validatePreparedJBatch = (env: RuntimeReplica, jurisdictionName: string, batch: Batch, raw: string): void => {
  if (!/^0x(?:[0-9a-f]{2})+$/.test(raw) || raw.length > 524_290) throw new Error('J_PREPARED_WIRE_NON_CANONICAL');
  const jurisdiction = env.state.jReplicas.get(jurisdictionName);
  const address = jurisdiction?.contracts?.depository;
  if (!jurisdiction?.chainId || !address) throw new Error('J_PREPARED_JURISDICTION_MISSING');
  assertSealedJBatchBinding(batch, { chainId: jurisdiction.chainId, depositoryAddress: address });
  const nativeTron = jurisdiction.watcherReceiptCommitment === 'tron-rpc-attested';
  const decoded = decodePreparedJTransaction(raw, nativeTron);
  if (!decoded.from) throw new Error('J_PREPARED_SIGNER_MISSING');
  // The trusted local preparation callback checked the configured gas payer.
  // Replay checks the recovered signature and exact certified financial call;
  // operator keys and RPC nonce allocation are not consensus state.
  validatePreparedTransaction(raw, { nativeTron, from: decoded.from, to: address, value: 0n,
    nonce: decoded.nonce, chainId: BigInt(jurisdiction.chainId), data: contract.encodeFunctionData('processBatch', [
      batch.data.encodedBatch, compactHankoForChain(batch.data.hankoSignature, batch.data.batchHash), BigInt(batch.data.entityNonce),
    ]) });
};

export const applyRecordJPreparedTransaction = (
  env: RuntimeReplica,
  tx: Extract<RuntimeTx, { type: 'recordJPreparedTransaction' | 'replaceJPreparedTransaction' }>,
): JInput[] => {
  const inputs = env.infrastructure?.pendingCommittedJOutbox ?? [];
  for (const input of inputs) {
    if (input.jurisdictionName !== tx.data.jurisdictionName) continue;
    for (const batch of input.jTxs) {
      if (batch.type !== 'batch' || batch.data.runtimeSubmitAttempt?.attemptId !== tx.data.attemptId) continue;
      validatePreparedJBatch(env, input.jurisdictionName, batch, tx.data.rawTransaction);
      const attempt = batch.data.runtimeSubmitAttempt;
      if (tx.type === 'replaceJPreparedTransaction') {
        if ('kind' in tx.data.evidence) {
          const fees = signedEvmFeeLimits(tx.data.rawTransaction);
          if (!attempt.evmFeeLimits || !withinEvmFeeLimits({ maxFeePerGas: BigInt(fees.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGasWei) }, attempt.evmFeeLimits))
            throw new Error('EVM_REPLACEMENT_FEE_LIMIT_EXCEEDED');
        }
        if (!attempt.rawTransaction) throw new Error('J_PREPARED_REPLACEMENT_PREVIOUS_MISSING');
        if (attempt.rawTransaction === tx.data.rawTransaction) {
          if ('kind' in tx.data.evidence) {
            const previous = attempt.competingTransactions?.find(raw => ethers.keccak256(raw) === tx.data.previousTransactionHash);
            if (!previous) throw new Error('EVM_REPLACEMENT_PREVIOUS_MISSING');
            validateEvmReplacement(previous, tx.data.rawTransaction, tx.data.previousTransactionHash, tx.data.evidence.minimumBumpBps);
          } else validateTronReplacement(attempt.rawTransaction, tx.data.rawTransaction, tx.data.previousTransactionHash, tx.data.evidence);
          return [];
        }
        if (completedJSubmitAttempt(env, batch)) throw new Error('J_PREPARED_REPLACEMENT_COMPLETED_ATTEMPT');
        const native = env.state.jReplicas.get(input.jurisdictionName)?.watcherReceiptCommitment === 'tron-rpc-attested';
        if ('kind' in tx.data.evidence) {
          if (native) throw new Error('J_PREPARED_REPLACEMENT_CHAIN_MISMATCH');
          validateEvmReplacement(attempt.rawTransaction, tx.data.rawTransaction, tx.data.previousTransactionHash, tx.data.evidence.minimumBumpBps);
          attempt.competingTransactions = [...(attempt.competingTransactions ?? []), attempt.rawTransaction];
          attempt.feeBumpedAt = env.state.timestamp;
          attempt.requestedGasBumpBps = batch.data.feeOverrides?.gasBumpBps ?? 0;
        } else {
          if (!native) throw new Error('J_PREPARED_REPLACEMENT_CHAIN_MISMATCH');
          validateTronReplacement(attempt.rawTransaction, tx.data.rawTransaction, tx.data.previousTransactionHash, tx.data.evidence);
        }
        attempt.rawTransaction = tx.data.rawTransaction;
        return [{ jurisdictionName: input.jurisdictionName, jTxs: [batch] }];
      }
      const native = env.state.jReplicas.get(input.jurisdictionName)?.watcherReceiptCommitment === 'tron-rpc-attested';
      if (native && tx.data.feeAuthorization) throw new Error('EVM_FEE_AUTHORIZATION_CHAIN');
      if (attempt.rawTransaction !== undefined) {
        if (attempt.rawTransaction !== tx.data.rawTransaction) {
          // A queued payer authorization may lose to a same-nonce replacement.
          // Verify the exact known sibling, but never raise the current limits.
          if (!tx.data.feeAuthorization || !attempt.competingTransactions?.includes(tx.data.rawTransaction))
            throw new Error('J_PREPARED_TRANSACTION_CONFLICT');
          authorizedEvmFeeLimits(input.jurisdictionName, attempt.attemptId, tx.data.rawTransaction, tx.data.feeAuthorization);
          return [];
        }
        if (tx.data.feeAuthorization) attempt.evmFeeLimits = authorizedEvmFeeLimits(input.jurisdictionName, attempt.attemptId, tx.data.rawTransaction, tx.data.feeAuthorization);
        return [];
      }
      if (!native) attempt.evmFeeLimits = authorizedEvmFeeLimits(input.jurisdictionName, attempt.attemptId, tx.data.rawTransaction, tx.data.feeAuthorization);
      attempt.rawTransaction = tx.data.rawTransaction;
      return [{ jurisdictionName: input.jurisdictionName, jTxs: [batch] }];
    }
  }
  // Authenticated watcher ingress may retire the attempt before preparation arrives.
  return [];
};
