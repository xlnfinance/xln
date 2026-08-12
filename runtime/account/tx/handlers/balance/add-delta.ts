/**
 * Add Delta Handler
 * Creates a new token delta with zero balances (Channel.ts AddDelta pattern)
 */

import type { AccountState, AccountTx } from '../../../../types/account';
import { ensureDelta } from '../../delta-utils';

export function handleAddDelta(
  account: AccountState,
  accountTx: Extract<AccountTx, { type: 'add_delta' }>
): { success: boolean; events: string[]; error?: string } {
  const { tokenId } = accountTx.data;
  const events: string[] = [];

  const existed = account.deltas.has(tokenId);
  try {
    // A zero-valued row is omitted from AccountFrame.deltas, so frame-shape
    // validation alone cannot stop a signed peer from exhausting this map.
    // Keep the bounded insertion at the mutation sink and reject it as data.
    ensureDelta(account, tokenId);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('ACCOUNT_DELTA_')) throw error;
    return { success: false, events: [error.message], error: error.message };
  }
  if (existed) return { success: true, events };

  events.push(`➕ Added token ${tokenId} to account`);
  return { success: true, events };
}
