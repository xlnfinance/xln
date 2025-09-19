/**
 * Simple Account Transaction System
 * Minimal exports to avoid circular imports
 */

// Core DirectPayment functionality
export {
  applyDirectPayment,
  createDirectPaymentTx
} from './direct-payment';

export type { DirectPaymentData } from './direct-payment';

// Transaction processing
export {
  processAccountTransaction,
  processAccountMempool
} from './processor';

// Re-export types (no circular dependency since types.ts doesn't import from here)
export type { AccountMachine, AccountTx, Delta } from '../types';