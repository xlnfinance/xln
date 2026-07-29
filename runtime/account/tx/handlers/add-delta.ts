/**
 * Add Delta Handler
 * Creates a new token delta with zero balances (Channel.ts AddDelta pattern)
 */

import type { AccountState, AccountTx } from '../../../types/account';
import { createDefaultDelta } from '../../delta';

export function handleAddDelta(
  account: AccountState,
  accountTx: Extract<AccountTx, { type: 'add_delta' }>
): { success: boolean; events: string[]; error?: string } {
  const { tokenId } = accountTx.data;
  const events: string[] = [];

  // Check if delta already exists
  if (account.deltas.has(tokenId)) {
    return { success: true, events }; // Idempotent - not an error
  }

  account.deltas.set(tokenId, createDefaultDelta(tokenId));

  events.push(`➕ Added token ${tokenId} to account`);
  return { success: true, events };
}
