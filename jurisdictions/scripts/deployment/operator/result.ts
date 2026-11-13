import type { JsonRpcProvider } from 'ethers';
import { listTransactions } from '@nomicfoundation/ignition-core';
import { HardhatArtifactResolver } from '@nomicfoundation/hardhat-ignition/helpers';
import type { ArtifactManager } from 'hardhat/types/artifacts';
import { record } from './inputs.ts';

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('XLN_DEPLOY_RECEIPT_FEE_INVALID');
  return BigInt(value);
};

const receiptExpense = async (provider: JsonRpcProvider, hash: string) => {
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

export const readDeploymentExpenses = async (directory: string, provider: JsonRpcProvider, artifacts: ArtifactManager) => {
  const transactions = await listTransactions(directory, new HardhatArtifactResolver(artifacts));
  const hashes = [...new Set(transactions.map(transaction => transaction.txHash))];
  const receipts = [];
  for (const hash of hashes) receipts.push(await receiptExpense(provider, hash));
  let total = 0n;
  let gasUsed = 0n;
  for (const receipt of receipts) if (receipt.status === 'mined') {
    total += BigInt(receipt.feeWei);
    gasUsed += BigInt(receipt.gasUsed);
  }
  return { coverage: 'known-native-journal-transactions', broadcasts: hashes.length,
    mined: receipts.filter(receipt => receipt.status === 'mined').length,
    gasUsed: gasUsed.toString(), attemptTransactionFeesWei: total.toString(), receipts };
};
