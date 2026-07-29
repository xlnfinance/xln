// Single source of truth for contract events accepted by J consensus.
// Keep this list aligned with Depository.sol; adapters only decode transport.
export const CANONICAL_J_EVENTS = [
  'FoundationBootstrapped', 'EntityRegistered', 'BoardActivated',
  'ReserveUpdated', 'SecretRevealed', 'AccountSettled',
  'ExternalWalletSnapshot', 'ExternalWalletDelta',
  'DisputeStarted', 'DisputeFinalized', 'DebtCreated', 'DebtEnforced', 'DebtForgiven', 'HankoBatchProcessed',
  'BatchOperationSkipped',
  'EntityProviderActionExecuted', 'EntityProviderActionCancelled',
] as const;

export type CanonicalJEvent = (typeof CANONICAL_J_EVENTS)[number];
