/**
 * Account Transaction System
 * 
 * This module handles account-level state transitions similar to entity-tx
 * but focused on bilateral account state between two entities.
 * 
 * Based on old_src channel implementation patterns.
 */

// Transaction types and creators - TODO: Fix export issue
// export { 
//   DirectPaymentData, 
//   applyDirectPayment, 
//   createDirectPaymentTx 
// } from './direct-payment';

export { 
  SetCreditLimitData, 
  applySetCreditLimit, 
  createSetCreditLimitTx 
} from './set-credit-limit';

// Processing engine - TODO: Fix export issue  
// export { 
//   processAccountMempool, 
//   processAccountTransaction,
//   getAccountMachineSummary 
// } from './processor';

// Consensus and bilateral communication
export {
  AccountProposal,
  AccountAgreement,
  createAccountProposal,
  signAccountProposal,
  verifyAccountProposalSignature,
  applyAccountAgreement,
  areAccountMachinesInSync,
  getAccountConsensusStatus,
  hashAccountProposal
} from './consensus';

export {
  initiateDirectPayment,
  initiateSetCreditLimit,
  processBilateralConfirmation,
  isWaitingForConfirmation,
  getBilateralConsensusSummary,
  createStateSyncMessage
} from './bilateral';

// Cross-entity messaging workflow
export {
  sendAccountInputMessage,
  sendDirectPaymentToEntity,
  sendCreditLimitUpdateToEntity,
  sendAccountAcknowledgment,
  sendBatchAccountInputs,
  getCrossEntityMessagingSummary,
  validateAccountInputMessage
} from './messaging';

// Re-export account types from main types module
export type { AccountMachine, AccountTx, Delta, DerivedDelta } from '../types';