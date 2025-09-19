/**
 * Direct Payment with proper capacity checking using deriveDelta
 * Includes event bubbling back to E-Machine
 */

import { AccountMachine, Delta } from '../types';
import { deriveDelta } from '../account-utils';

export type DirectPaymentData = {
  tokenId: number;
  amount: bigint;
  description?: string;
};

/**
 * DirectPayment with global credit limit checking (similar to old_src deriveDelta)
 * Checks capacity constraints before applying payment
 */
export function applyDirectPayment(
  accountMachine: AccountMachine,
  payment: DirectPaymentData,
  isOutgoing: boolean
): { success: boolean; error?: string; events?: string[] } {

  console.log(`💸 DirectPayment: ${payment.amount.toString()} of token ${payment.tokenId}, outgoing: ${isOutgoing}`);

  // Get or create delta for this token
  let delta = accountMachine.deltas.get(payment.tokenId);
  if (!delta) {
    delta = {
      tokenId: payment.tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 1000000n, // Per-token credit limit: 1M USD equivalent
      rightCreditLimit: 1000000n, // Per-token credit limit: 1M USD equivalent
      leftAllowence: 0n,
      rightAllowence: 0n,
    };
    accountMachine.deltas.set(payment.tokenId, delta);
    console.log(`💳 Created new delta for token ${payment.tokenId}`);
  }

  // Calculate current total delta and new delta after payment
  const currentTotalDelta = delta.ondelta + delta.offdelta;
  const newTotalDelta = isOutgoing ?
    currentTotalDelta + payment.amount : // We owe them more (positive)
    currentTotalDelta - payment.amount;  // They owe us more (negative)

  console.log(`💸 Delta calculation: current=${currentTotalDelta.toString()}, new=${newTotalDelta.toString()}`);

  // Check capacity constraints using deriveDelta (like old_src)
  const derived = deriveDelta(delta, accountMachine.isProposer); // isProposer = isLeft in old_src

  if (isOutgoing) {
    // Check if we have enough outbound capacity
    if (payment.amount > derived.outCapacity) {
      return {
        success: false,
        error: `Insufficient capacity: need ${payment.amount.toString()}, available ${derived.outCapacity.toString()}`
      };
    }
    console.log(`💳 Capacity check passed: using ${payment.amount.toString()}/${derived.outCapacity.toString()} capacity`);

    // Also check global credit limits for USD-denominated credit
    if (payment.tokenId === 3 && newTotalDelta > 0n) { // Token 3 = USDC
      const creditUsed = newTotalDelta;
      const availableCredit = accountMachine.globalCreditLimits.peerLimit;

      if (creditUsed > availableCredit) {
        return {
          success: false,
          error: `Insufficient global credit: need ${creditUsed.toString()} USD, available ${availableCredit.toString()} USD`
        };
      }
      console.log(`💳 Global credit check passed: using ${creditUsed.toString()}/${availableCredit.toString()} USD credit`);
    }
  }

  // Apply the payment
  if (isOutgoing) {
    delta.offdelta += payment.amount;
    console.log(`💸 Sent ${payment.amount.toString()} token ${payment.tokenId} (we owe them more)`);
  } else {
    delta.offdelta -= payment.amount;
    console.log(`💰 Received ${payment.amount.toString()} token ${payment.tokenId} (they owe us more)`);
  }

  console.log(`💸 Updated offdelta for token ${payment.tokenId}: ${delta.offdelta.toString()}`);

  // Update frame with new delta
  const frameTokenIds = [...accountMachine.currentFrame.tokenIds];
  const frameDeltas = [...accountMachine.currentFrame.deltas];

  const tokenIndex = frameTokenIds.indexOf(payment.tokenId);
  const finalTotalDelta = delta.ondelta + delta.offdelta;

  if (tokenIndex >= 0) {
    frameDeltas[tokenIndex] = finalTotalDelta;
  } else {
    frameTokenIds.push(payment.tokenId);
    frameDeltas.push(finalTotalDelta);
  }

  accountMachine.currentFrame = {
    frameId: accountMachine.currentFrame.frameId + 1,
    timestamp: Date.now(),
    tokenIds: frameTokenIds,
    deltas: frameDeltas,
  };

  console.log(`✅ Payment applied. New frame ${accountMachine.currentFrame.frameId}, delta: ${finalTotalDelta.toString()}`);

  // Generate events to bubble up to E-Machine
  const events = [];
  if (isOutgoing) {
    events.push(`💸 Sent ${payment.amount.toString()} token ${payment.tokenId} to Entity ${accountMachine.counterpartyEntityId.slice(-4)}`);
  } else {
    events.push(`💰 Received ${payment.amount.toString()} token ${payment.tokenId} from Entity ${accountMachine.counterpartyEntityId.slice(-4)}`);
  }

  return { success: true, events };
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