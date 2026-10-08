import { createNativeTronClient } from '../../../operations/tron-authority';
import { ethers } from 'ethers';
import type { JAdapterConfig } from '../../../types';
import { broadcastSignedTronWire } from '../../../operations/tron-broadcast';

/** Broadcast one already-authorized signed wire; duplicate acceptance is not failure.
 * A duplicate response permits receipt polling only, never economic reconciliation. */
export const broadcastPreparedRpcTransaction = async (
  config: JAdapterConfig, provider: ethers.JsonRpcProvider, raw: string,
): Promise<string> => {
  if (config.mode === 'tron') return broadcastSignedTronWire(await createNativeTronClient(config), raw);
  const transaction = ethers.Transaction.from(raw);
  if (!transaction.hash || !transaction.from) throw new Error('J_PREPARED_SIGNED_TRANSACTION_REQUIRED');
  try {
    const response = await provider.broadcastTransaction(raw);
    if (response.hash.toLowerCase() !== transaction.hash.toLowerCase()) throw new Error('J_PREPARED_BROADCAST_HASH_MISMATCH');
    return response.hash;
  } catch (error) {
    // Scope this classification to the RPC request containing these exact bytes.
    // Do not swallow nonce, revert, signature or general transport failures.
    if (!/already known|transaction already imported|known transaction/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return transaction.hash;
  }
};
