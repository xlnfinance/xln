/**
 * Account Transaction System
 * Simple transaction types and processing only
 * Use account-consensus.ts from src root for frame consensus
 */

// Core DirectPayment functionality
export {
  applyDirectPayment,
  createDirectPaymentTx
} from './direct-payment';

export type { DirectPaymentData } from './direct-payment';

// Transaction processing (legacy - use account-consensus.ts instead)
export {
  processAccountTransaction,
  processAccountMempool
} from './processor';

// Re-export types
export type { AccountMachine, AccountTx, Delta } from '../types';