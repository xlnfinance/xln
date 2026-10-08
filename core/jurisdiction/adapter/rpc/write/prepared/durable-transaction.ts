import { decodeSignedTronTransaction } from '../../../operations/tron-transaction';
import { ethers, type Signer, type TransactionRequest } from 'ethers';

import type {
  JPreparedTransaction,
  JPreparedTransactionAcceptance,
} from '../../../types';
import type { SignerNonceSequencer } from '../rpc-transaction-sequencer';

type DurableTransactionDeps = Readonly<{
  signer: Signer;
  nativeTron: boolean;
  request: Readonly<{ to: string; data: string; value: bigint }>;
  accept: (prepared: JPreparedTransaction) => Promise<JPreparedTransactionAcceptance>;
  sequencer: SignerNonceSequencer;
  buildOverrides: () => Promise<TransactionRequest>;
}>;

/** Validate signed authority and the exact call before accepting any durable wire.
 * A signer returning a valid signature for another recipient/value is not approval. */
export const validatePreparedTransaction = (
  raw: string,
  expected: { nativeTron: boolean; from: string; to: string; data: string; value: bigint; nonce: number; chainId?: bigint },
): string => {
  const transaction = expected.nativeTron ? decodeSignedTronTransaction(raw) : ethers.Transaction.from(raw);
  if (!transaction.hash) throw new Error('DURABLE_TRANSACTION_HASH_MISSING');
  if (transaction.from?.toLowerCase() !== expected.from.toLowerCase()) {
    throw new Error('DURABLE_TRANSACTION_SIGNER_MISMATCH');
  }
  if (transaction.to?.toLowerCase() !== expected.to.toLowerCase()
    || transaction.data.toLowerCase() !== expected.data.toLowerCase() || transaction.value !== expected.value) {
    throw new Error('DURABLE_TRANSACTION_CALL_MISMATCH');
  }
  if (transaction.nonce !== expected.nonce) throw new Error('DURABLE_TRANSACTION_NONCE_MISMATCH');
  if (!expected.nativeTron && (!('chainId' in transaction) || expected.chainId === undefined
    || transaction.chainId !== expected.chainId)) throw new Error('DURABLE_TRANSACTION_CHAIN_MISMATCH');
  return transaction.hash.toLowerCase();
};

/** Hold one EOA nonce until the exact signed bytes are durably accepted. */
export const prepareDurableTransaction = async (
  deps: DurableTransactionDeps,
): Promise<JPreparedTransaction> => deps.sequencer.runFor(deps.signer, async () => {
  let prepared: JPreparedTransaction;
  try {
    const transactionNonce = await deps.sequencer.allocateFor(deps.signer);
    const populated = deps.nativeTron ? deps.request : await deps.signer.populateTransaction({
      ...deps.request,
      nonce: transactionNonce,
      ...await deps.buildOverrides(),
    });
    const rawTransaction = (await deps.signer.signTransaction(populated)).toLowerCase();
    const transactionHash = validatePreparedTransaction(rawTransaction, {
      ...deps.request, nativeTron: deps.nativeTron, from: await deps.signer.getAddress(), nonce: transactionNonce,
      ...('chainId' in populated && populated.chainId != null ? { chainId: BigInt(populated.chainId) } : {}),
    });
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
