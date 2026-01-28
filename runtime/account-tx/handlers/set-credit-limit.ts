/**
 * Set Credit Limit Handler
 * Sets credit limit for a specific token (Channel.ts SetCreditLimit pattern)
 */

import type { AccountMachine, AccountTx } from '../../types';
import { getAccountPerspective } from '../../state-helpers';
import { FINANCIAL } from '../../constants';

// Maximum credit limit (prevents overflow attacks)
const MAX_CREDIT_LIMIT = FINANCIAL.MAX_PAYMENT_AMOUNT * 1000n; // 1000x max payment

export function handleSetCreditLimit(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'set_credit_limit' }>,
  _isOurFrame: boolean = true
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount, side } = accountTx.data;
  const events: string[] = [];

  // H15 FIX: Validate credit limit bounds
  if (amount < 0n) {
    return { success: false, error: `Credit limit cannot be negative: ${amount}`, events };
  }
  if (amount > MAX_CREDIT_LIMIT) {
    return { success: false, error: `Credit limit exceeds maximum: ${amount} > ${MAX_CREDIT_LIMIT}`, events };
  }

  const { counterparty } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
  console.log(`💳 SET-CREDIT-LIMIT HANDLER: tokenId=${tokenId}, amount=${amount.toString()}, side=${side}, counterparty=${counterparty.slice(-4)}`);

  // Get or create delta - credit extension can happen before collateral deposit
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    console.log(`💳 Creating delta for token ${tokenId} (credit extension without collateral)`);
    delta = {
      tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
    };
    accountMachine.deltas.set(tokenId, delta);
    events.push(`📊 Created delta for token ${tokenId}`);
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
