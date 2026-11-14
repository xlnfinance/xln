import { keccak256, toQuantity, zeroPadValue, type TransactionReceipt, type TransactionRequest } from 'ethers';
import { isDeepStrictEqual } from 'node:util';
import { createEmptyBatch } from '../../../core/jurisdiction/machine/batch';
import { prepareSignedBatch } from '../../../core/hanko/batch';
import {
  readConfirmedReceipt,
  assertCanonicalChainPoint,
  type CanonicalChainPoint,
} from '../../../core/jurisdiction/adapter/stack-manager/receipts';
import { assertVerificationInputsUnchanged } from '../deployment/operator/readonly-identity';
import { receiptExpense } from '../deployment/operator/result';
import { requireBoundaryRecord } from '../../../core/protocol/boundary-validation';
import { tokenContract, readRoundtripPoint } from './balances';
import { ONE_USDC, type Context, type FinancialStage, type TransactionEvidence } from './types';

const fundTransaction = async (context: Context, request: TransactionRequest) => {
  const { provider, wallet } = context;
  const point = await readRoundtripPoint(context);
  const gas = BigInt(
    await provider.send('eth_estimateGas', [
      { from: wallet.address, to: request.to, data: request.data },
      toQuantity(point.number),
    ]),
  );
  const transaction = await wallet.populateTransaction({ ...request, gasLimit: gas });
  const fee = transaction.maxFeePerGas ?? transaction.gasPrice;
  if (fee === undefined || fee === null || BigInt(fee) <= 0n) throw new Error('USDC_ROUNDTRIP_FEE_ESTIMATE_INVALID');
  const available = await provider.getBalance(wallet.address, point.number);
  if (available < gas * BigInt(fee)) throw new Error(`USDC_ROUNDTRIP_NATIVE_FUNDING_INSUFFICIENT:${available}`);
  await assertCanonicalChainPoint(provider, point);
  await assertVerificationInputsUnchanged(context.input);
  return transaction;
};

const assertReceiptEvidence = (entry: TransactionEvidence, receipt: TransactionReceipt | null): TransactionReceipt => {
  const recorded = requireBoundaryRecord(entry.receipt, 'USDC_ROUNDTRIP_RECORDED_RECEIPT_MISSING');
  const expense = requireBoundaryRecord(entry.expense, 'USDC_ROUNDTRIP_EXPENSE_MISSING');
  if (
    !receipt ||
    receipt.status !== 1 ||
    receipt.hash !== entry.hash ||
    recorded['transactionHash'] !== receipt.hash ||
    recorded['status'] !== '0x1' ||
    recorded['blockHash'] !== receipt.blockHash ||
    recorded['blockNumber'] !== toQuantity(receipt.blockNumber) ||
    recorded['gasUsed'] !== toQuantity(receipt.gasUsed) ||
    recorded['effectiveGasPrice'] !== toQuantity(receipt.gasPrice) ||
    expense['status'] !== 'mined' ||
    expense['reverted'] !== false ||
    expense['transactionHash'] !== receipt.hash ||
    expense['blockHash'] !== receipt.blockHash ||
    expense['gasUsed'] !== receipt.gasUsed.toString()
  )
    throw new Error(`USDC_ROUNDTRIP_RECORDED_RECEIPT_CHANGED:${entry.hash}`);
  return receipt;
};

const confirmTransaction = async (context: Context, entry: TransactionEvidence) => {
  const receipt = await readConfirmedReceipt(context.provider, entry.hash, context.evidence.confirmations, value => {
    if (!value || value.status !== 1) throw new Error(`USDC_ROUNDTRIP_RECEIPT_FAILED:${entry.hash}`);
    return value;
  });
  entry.receipt = await context.provider.send('eth_getTransactionReceipt', [entry.hash]);
  entry.expense = await receiptExpense(context.provider, entry.hash);
  assertReceiptEvidence(entry, receipt);
  entry.confirmedAt = await readRoundtripPoint(context);
  await assertCanonicalChainPoint(context.provider, { number: receipt.blockNumber, hash: receipt.blockHash });
  entry.status = 'confirmed';
};

const sendTransaction = async (context: Context, stage: FinancialStage, request: TransactionRequest) => {
  context.evidence.stage = stage;
  const transaction = await fundTransaction(context, request);
  // Keep the exact identifier before transport: a lost broadcast response must
  // leave a known hash for manual inspection, never authorize another send.
  context.signal.throwIfAborted();
  const signed = await context.wallet.signTransaction(transaction);
  const entry: TransactionEvidence = { stage, hash: keccak256(signed), status: 'broadcast-attempt' };
  context.evidence.transactions.push(entry);
  context.signal.throwIfAborted();
  process.stderr.write(`USDC_ROUNDTRIP_BROADCAST_ATTEMPT:${stage}:${entry.hash}\n`);
  const response = await context.provider.broadcastTransaction(signed);
  entry.status = 'broadcast';
  process.stderr.write(`USDC_ROUNDTRIP_BROADCAST:${stage}:${entry.hash}\n`);
  const mined = await response.wait(1, 120_000);
  if (!mined || mined.status !== 1) throw new Error(`USDC_ROUNDTRIP_TRANSACTION_FAILED:${entry.hash}`);
  await confirmTransaction(context, entry);
};

export const approveRoundtrip = async (context: Context): Promise<void> => {
  context.evidence.stage = 'approval';
  const token = tokenContract(context);
  const request = await token
    .getFunction('approve')
    .populateTransaction(context.input.manifest.contracts.depository, ONE_USDC);
  await sendTransaction(context, 'approval', request);
};

const reserveBatch = (context: Context, stage: 'deposit' | 'withdrawal') => {
  const batch = createEmptyBatch();
  if (stage === 'deposit')
    batch.externalTokenToReserve.push({
      entity: context.entityId,
      contractAddress: context.options.token,
      externalTokenId: 0n,
      tokenType: 0,
      internalTokenId: 1,
      amount: ONE_USDC,
    });
  else
    batch.reserveToExternalToken.push({
      receivingEntity: zeroPadValue(context.wallet.address, 32),
      tokenId: 1,
      amount: ONE_USDC,
    });
  return batch;
};

export const sendReserveOperation = async (context: Context, stage: 'deposit' | 'withdrawal'): Promise<void> => {
  context.evidence.stage = stage;
  const point = await readRoundtripPoint(context);
  const nonce = await context.depository.entityNonces(context.entityId, { blockTag: point.number });
  // Only this wallet's single-signer lazy Entity authorizes this chain-bound
  // old->next nonce. Reusing deposit Hanko for withdrawal is a different batch.
  context.signal.throwIfAborted();
  const signed = prepareSignedBatch(
    reserveBatch(context, stage),
    context.entityId,
    context.wallet.privateKey,
    BigInt(context.options.chainId),
    context.input.manifest.contracts.depository,
    nonce,
  );
  const request = await context.depository.processBatch.populateTransaction(
    signed.encodedBatch,
    signed.hankoData,
    signed.nextNonce,
  );
  await assertCanonicalChainPoint(context.provider, point);
  await sendTransaction(context, stage, request);
};

export const verifyRoundtripReceipts = async (context: Context, point: CanonicalChainPoint): Promise<void> => {
  for (const entry of context.evidence.transactions) {
    if (!isDeepStrictEqual(entry.expense, await receiptExpense(context.provider, entry.hash)))
      throw new Error(`USDC_ROUNDTRIP_RECORDED_EXPENSE_CHANGED:${entry.hash}`);
    await readConfirmedReceipt(
      context.provider,
      entry.hash,
      context.evidence.confirmations,
      receipt => {
        if (entry.status !== 'confirmed') throw new Error(`USDC_ROUNDTRIP_RECORDED_RECEIPT_CHANGED:${entry.hash}`);
        return assertReceiptEvidence(entry, receipt);
      },
      point.number,
    );
  }
  await assertVerificationInputsUnchanged(context.input);
  const deployment = context.evidence.deployment;
  if (!deployment) throw new Error('USDC_ROUNDTRIP_DEPLOYMENT_EVIDENCE_MISSING');
  for (const snapshot of Object.values(context.evidence.snapshots))
    await assertCanonicalChainPoint(context.provider, snapshot.point);
  await assertCanonicalChainPoint(context.provider, deployment.verifiedAt);
  await assertCanonicalChainPoint(context.provider, point);
};
