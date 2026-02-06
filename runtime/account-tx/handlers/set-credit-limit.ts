/**
 * Set Credit Limit Handler
 * Channel.ts pattern: proposer extends credit to counterparty.
 * Uses byLeft (frame property, same on both sides) — NOT perspective-dependent.
 */

import type { AccountMachine, AccountTx } from '../../types';
import { FINANCIAL } from '../../constants';

// Maximum credit limit (prevents overflow attacks)
const MAX_CREDIT_LIMIT = FINANCIAL.MAX_PAYMENT_AMOUNT * 1000n; // 1000x max payment

export function handleSetCreditLimit(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'set_credit_limit' }>,
  byLeft: boolean
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, amount } = accountTx.data;
  const events: string[] = [];

  if (amount < 0n) {
    return { success: false, error: `Credit limit cannot be negative: ${amount}`, events };
  }
  if (amount > MAX_CREDIT_LIMIT) {
    return { success: false, error: `Credit limit exceeds maximum: ${amount} > ${MAX_CREDIT_LIMIT}`, events };
  }

  // Channel.ts pattern (Transition.ts:358-362):
  //   if (!block.isLeft) { delta.leftCreditLimit = amount; }  // RIGHT proposer → sets LEFT limit
  //   else { delta.rightCreditLimit = amount; }                // LEFT proposer → sets RIGHT limit
  // Proposer extends credit → set counterparty's credit limit field
  const side = byLeft ? 'right' : 'left';

  console.log(`💳 SET-CREDIT-LIMIT: tokenId=${tokenId}, amount=${amount.toString()}, side=${side} (byLeft=${byLeft})`);

  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
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

  if (side === 'left') {
    delta.leftCreditLimit = amount;
    events.push(`💳 Left credit limit = ${amount.toString()} for token ${tokenId}`);
  } else {
    delta.rightCreditLimit = amount;
    events.push(`💳 Right credit limit = ${amount.toString()} for token ${tokenId}`);
  }

  console.log(`✅ Set credit limit for token ${tokenId}: left=${delta.leftCreditLimit}, right=${delta.rightCreditLimit}`);
  return { success: true, events };
}
