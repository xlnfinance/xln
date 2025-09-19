/**
 * Simple Direct Payment - moves delta immediately
 * No complex capacity checking, no circular imports
 */

import { AccountMachine, Delta } from '../types';

export type DirectPaymentData = {
  tokenId: number;
  amount: bigint;
  description?: string;
};

/**
 * Simple DirectPayment that just moves delta right away
 * As requested: no linking to old_src, just direct delta updates
 */
export function applyDirectPayment(
  accountMachine: AccountMachine,
  payment: DirectPaymentData,
  isOutgoing: boolean
): { success: boolean; error?: string } {

  console.log(`💸 Simple DirectPayment: ${payment.amount.toString()} of token ${payment.tokenId}, outgoing: ${isOutgoing}`);

  // Get or create delta for this token
  let delta = accountMachine.deltas.get(payment.tokenId);
  if (!delta) {
    delta = {
      tokenId: payment.tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 1000n,
      rightCreditLimit: 1000n,
      leftAllowence: 0n,
      rightAllowence: 0n,
    };
    accountMachine.deltas.set(payment.tokenId, delta);
  }

  // Simple delta update - just move it right away
  if (isOutgoing) {
    // We are sending money to them (positive offdelta means we owe them)
    delta.offdelta += payment.amount;
  } else {
    // We are receiving money from them (negative offdelta means they owe us)
    delta.offdelta -= payment.amount;
  }

  console.log(`💸 Updated offdelta for token ${payment.tokenId}: ${delta.offdelta.toString()}`);

  // Update frame with new delta
  const frameTokenIds = [...accountMachine.currentFrame.tokenIds];
  const frameDeltas = [...accountMachine.currentFrame.deltas];

  const tokenIndex = frameTokenIds.indexOf(payment.tokenId);
  const totalDelta = delta.ondelta + delta.offdelta;

  if (tokenIndex >= 0) {
    frameDeltas[tokenIndex] = totalDelta;
  } else {
    frameTokenIds.push(payment.tokenId);
    frameDeltas.push(totalDelta);
  }

  accountMachine.currentFrame = {
    frameId: accountMachine.currentFrame.frameId + 1,
    timestamp: Date.now(),
    tokenIds: frameTokenIds,
    deltas: frameDeltas,
  };

  return { success: true };
}

/**
 * Create DirectPayment transaction for mempool
 */
export function createDirectPaymentTx(tokenId: number, amount: bigint, description?: string) {
  return {
    type: 'direct_payment' as const,
    data: {
      tokenId,
      amount,
      description: description || `Direct payment of ${amount.toString()} token ${tokenId}`,
    }
  };
}