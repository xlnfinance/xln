/**
 * Simple Account Transaction Processor
 * Minimal implementation for DirectPayment processing
 */

import { AccountMachine, AccountTx } from '../types';
import { applyDirectPayment, DirectPaymentData } from './direct-payment';

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
      console.log(`👋 Processing initial acknowledgment: ${transaction.data.message}`);
      return { success: true };

    case 'account_settle':
      console.log(`💰 Account settlement already processed in account handler`);
      return { success: true };

    case 'direct_payment':
      return applyDirectPayment(
        accountMachine,
        transaction.data as DirectPaymentData,
        true // Simplified: assume outgoing for now
      );

    default:
      return { success: false, error: `Unknown transaction type: ${(transaction as any).type}` };
  }
}

/**
 * Process all pending transactions in mempool
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
        accountMachine.mempool.unshift(transaction);
        break;
      }
    } catch (error) {
      console.error(`💥 Error processing ${transaction.type}:`, error);
    }
  }
}