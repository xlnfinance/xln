import type { JsonRpcProvider } from 'ethers';
import { readNativeTransactions } from '../transactions.cjs';
import { record } from './inputs.ts';
import type { CanonicalChainPoint } from '../../../../core/jurisdiction/adapter/stack-manager/receipts.ts';

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('XLN_DEPLOY_RECEIPT_FEE_INVALID');
  return BigInt(value);
};

export const receiptExpense = async (provider: JsonRpcProvider, hash: string) => {
  const raw: unknown = await provider.send('eth_getTransactionReceipt', [hash]);
  if (raw === null) return { transactionHash: hash, status: 'unmined' as const };
  const receipt = record(raw);
  const block = record(await provider.send('eth_getBlockByNumber', [receipt['blockNumber'], false]));
  if (receipt['transactionHash'] !== hash || block['hash'] !== receipt['blockHash']
    || !['0x0', '0x1'].includes(String(receipt['status']))) throw new Error('XLN_DEPLOY_EXPENSE_RECEIPT_CONFLICT');
  const gasUsed = quantity(receipt['gasUsed']);
  const executionFeeWei = gasUsed * quantity(receipt['effectiveGasPrice']);
  // Nitro's L1 poster component is already included in gasUsed. Own blob fees
  // are additive only for type-3 receipts; never add gasUsedForL1 a second time.
  const blobFeeWei = quantity(receipt['type']) === 3n
    ? quantity(receipt['blobGasUsed']) * quantity(receipt['blobGasPrice']) : 0n;
  return { transactionHash: hash, status: 'mined' as const, reverted: receipt['status'] === '0x0',
    blockHash: receipt['blockHash'], gasUsed: gasUsed.toString(), executionFeeWei: executionFeeWei.toString(),
    blobFeeWei: blobFeeWei.toString(), feeWei: (executionFeeWei + blobFeeWei).toString() };
};

type ExpenseAttempt = Readonly<{ directory: string; deployer: string; identity: Readonly<{
  origin: Readonly<{ blockNumber: number; blockHash: string; balanceWei: string }>;
}> }>;

export const readDeploymentExpenses = async (attempt: ExpenseAttempt, provider: JsonRpcProvider, atPoint?: CanonicalChainPoint) => {
  const transactions = await readNativeTransactions(attempt.directory);
  const unique = new Map(transactions.map(transaction => [transaction.txHash, transaction]));
  const receipts = [];
  for (const [hash, transaction] of unique) receipts.push({ ...await receiptExpense(provider, hash),
    futureId: transaction.futureId, networkInteractionId: transaction.networkInteractionId,
    nonce: transaction.nonce, journalStatus: transaction.status });
  let total = 0n;
  let gasUsed = 0n;
  for (const receipt of receipts) if (receipt.status === 'mined') {
    total += BigInt(receipt.feeWei);
    gasUsed += BigInt(receipt.gasUsed);
  }
  const block = atPoint || await provider.getBlock('latest');
  if (!block?.hash) throw new Error('XLN_DEPLOY_BALANCE_BLOCK_INVALID');
  const current = await provider.getBalance(attempt.deployer, block.number);
  const origin = attempt.identity.origin;
  const delta = BigInt(origin.balanceWei) - current;
  return { coverage: 'known-native-journal-transactions', broadcasts: unique.size,
    mined: receipts.filter(receipt => receipt.status === 'mined').length,
    gasUsed: gasUsed.toString(), attemptTransactionFeesWei: total.toString(), receipts,
    balance: { initialBlockNumber: origin.blockNumber, initialBlockHash: origin.blockHash, initialWei: origin.balanceWei,
      currentBlockNumber: block.number, currentBlockHash: block.hash, currentWei: current.toString(),
      deltaWei: delta.toString(), unaccountedDeltaWei: (delta - total).toString() } };
};
