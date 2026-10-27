/**
 * Exhaustive event policy for protocol-owned contracts.
 *
 * `consensus` events enter the deterministic J → Entity cascade. `telemetry`
 * events are deliberately decoded and ignored. The ABI parity gate rejects a
 * Solidity event that has not received an explicit policy here.
 */
// Dispute bodies come exclusively from authenticated event logs on EVM and TRON.
// Start and new counter bodies emit abi.encode(ProofBody) plus their keccak256 hash.
// Finalization also emits the fields committed by finalizationEvidenceHash.
// Finalization reuses earlier log bodies and starter arguments by hash; only new bodies are emitted.
// Decoders verify both commitments and fail closed; no transaction calldata recovery.
export const DEPOSITORY_J_EVENTS = {
  consensus: [
    'ReserveUpdated', 'SecretRevealed', 'AccountSettled',
    'DisputeStarted', 'CounterDisputeRegistered', 'DisputeFinalized', 'HashLadderRevealRegistered',
    'DebtCreated', 'DebtEnforced', 'DebtForgiven',
    'HankoBatchProcessed',
  ],
  telemetry: [
    'CooperativeClose', 'TokenRegistered', 'TransformerDeltaClamped',
    'WatchtowerCounterDisputeExecuted',
  ],
} as const;

export const ENTITY_PROVIDER_J_EVENTS = {
  consensus: [
    'FoundationBootstrapped', 'EntityRegistered', 'BoardActivated',
    'EntityProviderActionExecuted', 'EntityProviderActionCancelled',
  ],
  telemetry: [
    'ApprovalForAll', 'BoardCommitted', 'BoardProposed', 'ControlSharesReleased',
    'ExternalTokenListed',
    'FoundationActionExecuted', 'GovernanceEnabled',
    'ProposalCancelled', 'ShareDepositoryBound', 'TransferBatch',
    'TransferSingle', 'URI',
  ],
} as const;

// These events are authenticated from tracked ERC20 receipts rather than
// emitted by Depository or EntityProvider.
const SYNTHETIC_J_EVENTS = [
  'ExternalWalletSnapshot',
  'ExternalWalletDelta',
] as const;

export const CANONICAL_J_EVENTS = [
  ...ENTITY_PROVIDER_J_EVENTS.consensus,
  ...DEPOSITORY_J_EVENTS.consensus,
  ...SYNTHETIC_J_EVENTS,
] as const;

export type CanonicalJEvent = (typeof CANONICAL_J_EVENTS)[number];
