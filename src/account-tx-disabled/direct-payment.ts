/**
 * Direct Payment Account Transaction
 * Based on old_src/app/Transition.ts DirectPayment
 */

import { AccountMachine, Delta } from '../types';
import { deriveDelta } from '../account-utils';

export interface DirectPaymentData {
  tokenId: number;
  amount: bigint;
  description?: string;
}

/**
 * Apply a direct payment to an account machine
 * Updates the offdelta for the specified token
 */
export function applyDirectPayment(
  accountMachine: AccountMachine, 
  payment: DirectPaymentData, 
  isOutgoing: boolean
): { success: boolean; error?: string } {
  
  console.log(`💸 Applying DirectPayment: ${payment.amount.toString()} of token ${payment.tokenId}, outgoing: ${isOutgoing}`);

  // Get or create delta for this token
  let delta = accountMachine.deltas.get(payment.tokenId);
  if (!delta) {
    // Create new delta with default values
    delta = {
      tokenId: payment.tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 1000n, // Default credit limits
      rightCreditLimit: 1000n,
      leftAllowence: 0n,
      rightAllowence: 0n,
    };
    accountMachine.deltas.set(payment.tokenId, delta);
  }

  // Calculate current capacity (assuming we are always "left" side for simplicity)
  const derived = deriveDelta(delta, true); // TODO: Pass correct isLeft parameter
  
  console.log(`💸 Current capacity check: ${derived.outCapacity.toString()} >= ${payment.amount.toString()}`);

  // Check if we have sufficient capacity for outgoing payment
  if (isOutgoing && derived.outCapacity < payment.amount) {
    return { 
      success: false, 
      error: `Insufficient capacity: need ${payment.amount.toString()}, have ${derived.outCapacity.toString()}` 
    };
  }

  // Update the offdelta - positive means we owe them, negative means they owe us
  if (isOutgoing) {
    // We are sending money to them
    delta.offdelta += payment.amount;
  } else {
    // We are receiving money from them  
    delta.offdelta -= payment.amount;
  }

  console.log(`💸 Updated offdelta for token ${payment.tokenId}: ${delta.offdelta.toString()}`);

  // Update account frame
  const frameTokenIds = [...accountMachine.currentFrame.tokenIds];
  const frameDeltas = [...accountMachine.currentFrame.deltas];
  
  const tokenIndex = frameTokenIds.indexOf(payment.tokenId);
  const newTotalDelta = delta.ondelta + delta.offdelta;
  
  if (tokenIndex >= 0) {
    // Update existing token in frame
    frameDeltas[tokenIndex] = newTotalDelta;
  } else {
    // Add new token to frame
    frameTokenIds.push(payment.tokenId);
    frameDeltas.push(newTotalDelta);
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
 * Create a DirectPayment transaction for the mempool
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