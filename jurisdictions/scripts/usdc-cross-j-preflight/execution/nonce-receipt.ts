import { waitForHistory, type ExecutionProviders, type ChainBinding, type NonceGrant } from './providers';
import { ObservationUnavailable } from './boundary';

/** Chain receipts, never a local report, decide whether a fixed nonce was spent.
 * Binary search uses the approved chain anchor and exact sender nonce instead
 * of scanning unrelated public transactions or keeping a second receipt store. */
export const readNonceReceipt = async (
  providers: ExecutionProviders,
  chain: Pick<ChainBinding, 'anchorNumber'>,
  payer: NonceGrant,
  nonce: number,
) => {
  if (nonce < payer.firstNonce) throw new Error('USDC_EXECUTION_NONCE_BEFORE_AUTHORITY');
  if ((await providers.current.getTransactionCount(payer.address, 'latest')) <= nonce) return null;
  const provider = providers.historical;
  await waitForHistory(
    `nonce:${payer.address}:${nonce}`,
    async () => (await provider.getTransactionCount(payer.address, 'latest')) > nonce,
  );
  const found = await findMinedNonceReceipt(providers, chain, payer, nonce, await provider.getBlockNumber());
  if (found.receipt.status !== 1) throw new Error('USDC_EXECUTION_NONCE_RECEIPT_INVALID');
  return found;
};

/** The caller has verified the nonce was mined by the fixed upper bound. */
export const findMinedNonceReceipt = async (
  providers: ExecutionProviders,
  chain: Pick<ChainBinding, 'anchorNumber'>,
  payer: NonceGrant,
  nonce: number,
  upperBlock: number,
) => {
  const provider = providers.historical;
  let low = chain.anchorNumber + 1;
  let high = upperBlock;
  if (low > high) throw new ObservationUnavailable('USDC_EXECUTION_NONCE_BLOCK_BEFORE_ANCHOR');
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await provider.getTransactionCount(payer.address, middle)) > nonce) high = middle;
    else low = middle + 1;
  }
  const block = await provider.getBlock(low, true);
  if (!block) throw new ObservationUnavailable('USDC_EXECUTION_NONCE_BLOCK_MISSING');
  if ((await providers.current.getBlock(low))?.hash !== block.hash)
    throw new ObservationUnavailable('USDC_EXECUTION_HISTORY_BLOCK_MISMATCH');
  const transaction = block.prefetchedTransactions.find(
    tx => tx.from.toLowerCase() === payer.address && tx.nonce === nonce,
  );
  if (!transaction) throw new ObservationUnavailable('USDC_EXECUTION_NONCE_TRANSACTION_MISSING');
  const receipt = await provider.getTransactionReceipt(transaction.hash);
  if (!receipt || receipt.blockHash !== block.hash || (receipt.status !== 1 && receipt.status !== 0))
    throw new ObservationUnavailable('USDC_EXECUTION_NONCE_RECEIPT_INVALID');
  return { transaction, receipt };
};
