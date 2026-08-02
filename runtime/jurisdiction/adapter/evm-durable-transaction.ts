import { ethers, type Signer, type TransactionRequest } from 'ethers';

import type {
  JPreparedTransaction,
  JPreparedTransactionAcceptance,
} from './types';
import type { SignerNonceSequencer } from './rpc-transaction-sequencer';

type DurableEvmTransactionDeps = Readonly<{
  signer: Signer;
  request: Readonly<{ to: string; data: string; value: bigint }>;
  accept: (prepared: JPreparedTransaction) => Promise<JPreparedTransactionAcceptance>;
  sequencer: SignerNonceSequencer;
  buildOverrides: () => Promise<TransactionRequest>;
}>;

/** Hold one EOA nonce until the exact signed bytes are durably accepted. */
export const prepareDurableEvmTransaction = async (
  deps: DurableEvmTransactionDeps,
): Promise<JPreparedTransaction> => deps.sequencer.runFor(deps.signer, async () => {
  let prepared: JPreparedTransaction;
  try {
    const transactionNonce = await deps.sequencer.allocateFor(deps.signer);
    const populated = await deps.signer.populateTransaction({
      ...deps.request,
      nonce: transactionNonce,
      ...await deps.buildOverrides(),
    });
    const rawTransaction = (await deps.signer.signTransaction(populated)).toLowerCase();
    const transactionHash = ethers.Transaction.from(rawTransaction).hash?.toLowerCase();
    if (!transactionHash) throw new Error('DURABLE_TRANSACTION_HASH_MISSING');
    prepared = { rawTransaction, transactionHash, transactionNonce };
  } catch (error) {
    await deps.sequencer.resetFor(deps.signer);
    throw error;
  }

  let acceptance: JPreparedTransactionAcceptance;
  try {
    acceptance = await deps.accept(prepared);
  } catch (error) {
    await deps.sequencer.poisonFor(deps.signer, error);
    throw error;
  }
  if (acceptance === 'accepted') return prepared;
  if (acceptance === 'rejected') {
    await deps.sequencer.resetFor(deps.signer);
    throw new Error('DURABLE_TRANSACTION_ACCEPTANCE_REJECTED');
  }
  const error = new Error(`DURABLE_TRANSACTION_ACCEPTANCE_INVALID:${String(acceptance)}`);
  await deps.sequencer.poisonFor(deps.signer, error);
  throw error;
});
