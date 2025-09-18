/**
 * Bilateral Account Communication
 * Handles cross-entity messaging for account consensus
 */

import { AccountInput, AccountMachine, EntityState, Env } from '../types';
import { 
  AccountProposal, 
  AccountAgreement, 
  createAccountProposal, 
  signAccountProposal,
  verifyAccountProposalSignature,
  applyAccountAgreement
} from './consensus';
import { createDirectPaymentTx } from './direct-payment';
import { createSetCreditLimitTx } from './set-credit-limit';

/**
 * Initiate a direct payment with bilateral consensus
 */
export function initiateDirectPayment(
  fromEntityState: EntityState,
  toEntityId: string,
  tokenId: number,
  amount: bigint,
  env: Env
): AccountInput | null {
  
  console.log(`💸 Initiating direct payment: ${amount.toString()} token ${tokenId} from ${fromEntityState.entityId.slice(-4)} to ${toEntityId.slice(-4)}`);
  
  // Get account machine
  const accountMachine = fromEntityState.accounts.get(toEntityId);
  if (!accountMachine) {
    console.error(`❌ No account machine found for ${toEntityId}`);
    return null;
  }
  
  // Create direct payment transaction
  const paymentTx = createDirectPaymentTx(tokenId, amount, `Payment of ${amount.toString()} token ${tokenId}`);
  
  // Create account input for the payment
  const accountInput: AccountInput = {
    fromEntityId: fromEntityState.entityId,
    toEntityId,
    accountTx: paymentTx
  };
  
  console.log(`✅ Created direct payment AccountInput`);
  return accountInput;
}

/**
 * Initiate credit limit change with bilateral consensus  
 */
export function initiateSetCreditLimit(
  fromEntityState: EntityState,
  toEntityId: string,
  tokenId: number,
  amount: bigint,
  isForSelf: boolean,
  env: Env
): AccountInput | null {
  
  console.log(`💳 Initiating credit limit change: ${amount.toString()} token ${tokenId} for ${isForSelf ? 'self' : 'peer'}`);
  
  // Get account machine
  const accountMachine = fromEntityState.accounts.get(toEntityId);
  if (!accountMachine) {
    console.error(`❌ No account machine found for ${toEntityId}`);
    return null;
  }
  
  // Create credit limit transaction
  const creditTx = createSetCreditLimitTx(tokenId, amount, isForSelf);
  
  // Create account input for the credit limit change
  const accountInput: AccountInput = {
    fromEntityId: fromEntityState.entityId,
    toEntityId,
    accountTx: creditTx
  };
  
  console.log(`✅ Created credit limit AccountInput`);
  return accountInput;
}

/**
 * Process bilateral account confirmation
 * This would be called when the counterparty confirms our proposal
 */
export function processBilateralConfirmation(
  entityState: EntityState,
  fromEntityId: string,
  cooperativeNonce: number,
  signature: string
): { success: boolean; error?: string } {
  
  console.log(`🤝 Processing bilateral confirmation from ${fromEntityId.slice(-4)}, nonce ${cooperativeNonce}`);
  
  // Get account machine
  const accountMachine = entityState.accounts.get(fromEntityId);
  if (!accountMachine) {
    return { success: false, error: `No account machine found for ${fromEntityId}` };
  }
  
  // For now, just update the cooperative nonce to indicate confirmation
  // In a full implementation, this would verify signatures and apply agreed state
  if (cooperativeNonce === accountMachine.proofHeader.cooperativeNonce + 1) {
    accountMachine.proofHeader.cooperativeNonce = cooperativeNonce;
    console.log(`✅ Bilateral confirmation processed, new nonce: ${cooperativeNonce}`);
    return { success: true };
  } else {
    return { success: false, error: `Nonce mismatch: expected ${accountMachine.proofHeader.cooperativeNonce + 1}, got ${cooperativeNonce}` };
  }
}

/**
 * Check if account is waiting for bilateral confirmation
 */
export function isWaitingForConfirmation(accountMachine: AccountMachine): boolean {
  // Account is waiting if there are pending transactions in mempool
  // or if sent transitions > confirmed transitions
  return accountMachine.mempool.length > 0 || accountMachine.sentTransitions > accountMachine.proofHeader.cooperativeNonce;
}

/**
 * Get bilateral consensus summary for debugging
 */
export function getBilateralConsensusSummary(accountMachine: AccountMachine) {
  return {
    counterparty: accountMachine.counterpartyEntityId,
    cooperativeNonce: accountMachine.proofHeader.cooperativeNonce,
    disputeNonce: accountMachine.proofHeader.disputeNonce,
    frameId: accountMachine.currentFrame.frameId,
    sentTransitions: accountMachine.sentTransitions,
    mempoolSize: accountMachine.mempool.length,
    waitingForConfirmation: isWaitingForConfirmation(accountMachine),
    lastUpdate: new Date(accountMachine.currentFrame.timestamp).toISOString(),
  };
}

/**
 * Create bilateral state sync message
 * Used to synchronize account state between entities
 */
export function createStateSyncMessage(
  fromEntityId: string,
  toEntityId: string,
  accountMachine: AccountMachine
): AccountInput {
  
  // Create a sync message with current account state
  const syncMessage = {
    type: 'state_sync' as const,
    data: {
      cooperativeNonce: accountMachine.proofHeader.cooperativeNonce,
      frameId: accountMachine.currentFrame.frameId,
      timestamp: Date.now(),
      tokenStates: Array.from(accountMachine.deltas.entries()).map(([tokenId, delta]) => ({
        tokenId,
        ondelta: delta.ondelta.toString(),
        offdelta: delta.offdelta.toString(),
        collateral: delta.collateral.toString(),
      }))
    }
  };
  
  return {
    fromEntityId,
    toEntityId,
    accountTx: syncMessage as any // TODO: Add state_sync to AccountTx union type
  };
}