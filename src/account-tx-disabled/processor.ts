/**
 * Account Transaction Processor
 * Handles processing of account-level transactions in mempool
 */

import { AccountMachine, AccountTx } from '../types';
import { applyDirectPayment, DirectPaymentData } from './direct-payment';
import { applySetCreditLimit, SetCreditLimitData } from './set-credit-limit';

/**
 * Process all pending transactions in an account machine's mempool
 */
export function processAccountMempool(accountMachine: AccountMachine): void {
  console.log(`🔄 Processing ${accountMachine.mempool.length} account transactions for ${accountMachine.counterpartyEntityId}`);

  while (accountMachine.mempool.length > 0) {
    const transaction = accountMachine.mempool.shift()!;
    
    try {
      const result = processAccountTransaction(accountMachine, transaction);
      
      if (result.success) {
        console.log(`✅ Processed ${transaction.type} successfully`);
        accountMachine.sentTransitions++;
      } else {
        console.error(`❌ Failed to process ${transaction.type}: ${result.error}`);
        // Put transaction back at front of queue for retry
        accountMachine.mempool.unshift(transaction);
        break; // Stop processing to avoid infinite loop
      }
    } catch (error) {
      console.error(`💥 Error processing ${transaction.type}:`, error);
      // Skip this transaction and continue
    }
  }
}

/**
 * Process a single account transaction
 */
export function processAccountTransaction(
  accountMachine: AccountMachine, 
  transaction: AccountTx
): { success: boolean; error?: string } {
  
  console.log(`🔄 Processing account transaction: ${transaction.type}`);

  switch (transaction.type) {
    case 'initial_ack':
      // Initial acknowledgment - just mark as processed
      console.log(`👋 Processing initial acknowledgment: ${transaction.data.message}`);
      return { success: true };

    case 'account_settle':
      // Settlement transactions are handled in the main account handler
      console.log(`💰 Account settlement already processed in account handler`);
      return { success: true };

    case 'direct_payment':
      return applyDirectPayment(
        accountMachine,
        transaction.data as DirectPaymentData,
        true // TODO: Determine if payment is outgoing based on context
      );

    case 'set_credit_limit':
      return applySetCreditLimit(
        accountMachine,
        transaction.data as SetCreditLimitData
      );

    default:
      return { success: false, error: `Unknown transaction type: ${(transaction as any).type}` };
  }
}

/**
 * Get summary of account machine state for debugging
 */
export function getAccountMachineSummary(accountMachine: AccountMachine) {
  const tokenCount = accountMachine.deltas.size;
  const mempoolSize = accountMachine.mempool.length;
  const frameId = accountMachine.currentFrame.frameId;
  
  return {
    counterpartyEntityId: accountMachine.counterpartyEntityId,
    tokenCount,
    mempoolSize,
    frameId,
    sentTransitions: accountMachine.sentTransitions,
    tokens: Array.from(accountMachine.deltas.keys()),
  };
}