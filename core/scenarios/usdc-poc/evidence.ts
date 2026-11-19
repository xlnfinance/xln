import type { JsonRpcProvider, TransactionReceipt, TransactionResponse } from 'ethers';
import { safeStringify } from '../../protocol/serialization';
import { Depository__factory } from '../../../jurisdictions/typechain-types';

export type MinedReceipt = Readonly<{ transaction: TransactionResponse; receipt: TransactionReceipt }>;

export const receiptFields = ({ transaction, receipt }: MinedReceipt) => ({
  hash: receipt.hash,
  blockHash: receipt.blockHash,
  blockNumber: receipt.blockNumber,
  payer: transaction.from.toLowerCase(),
  gasUsed: receipt.gasUsed,
  gasPrice: receipt.gasPrice,
  fee: receipt.fee,
  transaction: transaction.toJSON() as unknown,
  receipt: receipt.toJSON() as unknown,
});

export const buildIngressEvidence = async (
  provider: JsonRpcProvider,
  entries: readonly MinedReceipt[],
  firstBlock: number,
  lastBlock: number,
) => {
  const receipts = entries.map(receiptFields);
  const native = [];
  for (const payer of new Set(receipts.map(receipt => receipt.payer))) {
    const initial = await provider.getBalance(payer, firstBlock - 1);
    const final = await provider.getBalance(payer, lastBlock);
    const fees = receipts
      .filter(receipt => receipt.payer === payer)
      .reduce((total, receipt) => total + receipt.fee, 0n);
    if (initial - final !== fees) throw new Error(`USDC_POC_NATIVE_ACCOUNTING_MISMATCH:${payer}`);
    native.push({ payer, initial, final, fees, unaccounted: 0n });
  }
  return { receipts, native };
};

/** Attribute signed Entity batches by their indexed event, including a local
 * gas sponsor, without including unrelated transactions on a public stack. */
export const collectUserReceipts = async (
  provider: JsonRpcProvider,
  signer: string,
  depository: string,
  entityId: string,
  firstBlock: number,
  lastBlock: number,
) => {
  const event = Depository__factory.createInterface().getEvent('HankoBatchProcessed');
  const logs = await provider.getLogs({
    address: depository,
    fromBlock: firstBlock,
    toBlock: lastBlock,
    topics: [event.topicHash, entityId],
  });
  const batches = new Set(logs.map(log => log.transactionHash));
  const entries: MinedReceipt[] = [];
  const observed = [];
  for (let height = firstBlock; height <= lastBlock; height++) {
    const block = await provider.getBlock(height, true);
    if (!block) throw new Error(`USDC_POC_BLOCK_MISSING:${height}`);
    for (const tx of block.prefetchedTransactions) {
      if (tx.from.toLowerCase() !== signer.toLowerCase() && !batches.has(tx.hash)) continue;
      observed.push({ hash: tx.hash, from: tx.from, to: tx.to, block: height });
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt || receipt.status !== 1 || receipt.blockHash !== block.hash)
        throw new Error(`USDC_POC_RECEIPT_INVALID:${tx.hash}`);
      entries.push({ transaction: tx, receipt });
    }
  }
  if (entries.length !== 3)
    throw new Error(`USDC_POC_RECEIPT_COUNT:${entries.length}:${safeStringify({ signer, observed })}`);
  return buildIngressEvidence(provider, entries, firstBlock, lastBlock);
};
