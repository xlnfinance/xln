/**
 * Set Credit Limit Handler
 * Sets credit limit for a specific token (Channel.ts SetCreditLimit pattern)
 */

import { AccountMachine, AccountTx } from '../../types';

export function handleSetCreditLimit(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'set_credit_limit' }>,
  _isOurFrame: boolean = true
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, side } = accountTx.data;
  const events: string[] = [];

  // Get delta - must exist before setting credit limit
  const delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    console.error(`❌ Delta for token ${tokenId} not found - cannot set credit limit`);
    return {
      success: false,
      error: `Delta for token ${tokenId} not found. Use add_delta first.`,
      events,
    };
  }

  // DETERMINISTIC: side is canonical ('left' or 'right'), not perspective-dependent
  // This ensures both sides set the same field when processing the same transaction
  if (side === 'left') {
    delta.leftCreditLimit = amount;
    events.push(`💳 Left entity credit limit set to ${amount.toString()} for token ${tokenId}`);
  } else {
    delta.rightCreditLimit = amount;
    events.push(`💳 Right entity credit limit set to ${amount.toString()} for token ${tokenId}`);
  }

  console.log(`✅ Set credit limit for token ${tokenId}: left=${delta.leftCreditLimit}, right=${delta.rightCreditLimit}`);
  return { success: true, events };
}
