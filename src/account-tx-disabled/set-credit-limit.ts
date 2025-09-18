/**
 * Set Credit Limit Account Transaction
 * Based on old_src/app/Transition.ts SetCreditLimit
 */

import { AccountMachine } from '../types';

export interface SetCreditLimitData {
  tokenId: number;
  amount: bigint;
  isForSelf: boolean; // true = setting our credit limit, false = setting their credit limit
}

/**
 * Apply a credit limit change to an account machine
 * Updates the credit limits for the specified token
 */
export function applySetCreditLimit(
  accountMachine: AccountMachine, 
  creditLimit: SetCreditLimitData
): { success: boolean; error?: string } {
  
  console.log(`💳 Setting credit limit: ${creditLimit.amount.toString()} for token ${creditLimit.tokenId}, forSelf: ${creditLimit.isForSelf}`);

  // Get or create delta for this token
  let delta = accountMachine.deltas.get(creditLimit.tokenId);
  if (!delta) {
    // Create new delta with default values
    delta = {
      tokenId: creditLimit.tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowence: 0n,
      rightAllowence: 0n,
    };
    accountMachine.deltas.set(creditLimit.tokenId, delta);
  }

  // Update the appropriate credit limit
  // For now, assuming we are always "left" side - TODO: Pass correct isLeft parameter
  if (creditLimit.isForSelf) {
    delta.leftCreditLimit = creditLimit.amount;
    console.log(`💳 Set our (left) credit limit for token ${creditLimit.tokenId}: ${creditLimit.amount.toString()}`);
  } else {
    delta.rightCreditLimit = creditLimit.amount;
    console.log(`💳 Set their (right) credit limit for token ${creditLimit.tokenId}: ${creditLimit.amount.toString()}`);
  }

  // Update account frame timestamp to indicate state change
  accountMachine.currentFrame = {
    ...accountMachine.currentFrame,
    frameId: accountMachine.currentFrame.frameId + 1,
    timestamp: Date.now(),
  };

  return { success: true };
}

/**
 * Create a SetCreditLimit transaction for the mempool
 */
export function createSetCreditLimitTx(tokenId: number, amount: bigint, isForSelf: boolean) {
  return {
    type: 'set_credit_limit' as const,
    data: {
      tokenId,
      amount,
      isForSelf,
    }
  };
}