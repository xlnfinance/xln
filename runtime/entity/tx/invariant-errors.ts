const ENTITY_TX_INVARIANT_ERROR_PREFIXES = [
  'FRAME_CONSENSUS_FAILED',
  'ORDERBOOK_',
  'STORAGE_',
  'j_event rejected',
  'DISPUTE_',
  'ENTITY_J_',
  'J_EVENT_',
  'J_BATCH_LIMIT_EXCEEDED',
  'Settlement invariant violation',
  'REPLAY_INVARIANT_FAILED',
  'ROUTE_DISCOVERY_INVARIANT',
  'DIRECT_PAYMENT_',
  'HTLC_ONION_',
  'SWAP_REQUEST_',
  'CROSS_J_',
];

export class MalformedEntityFrameInputError extends Error {
  readonly txType: string;
  readonly rejection: string;

  constructor(txType: string, rejection: string) {
    super(`ENTITY_FRAME_TX_FAILED: type=${txType} error=${rejection}`);
    this.name = 'MalformedEntityFrameInputError';
    this.txType = txType;
    this.rejection = rejection;
  }
}

export type EntityInputApplyFailureKind =
  | 'malformed-ingress'
  | 'state-machine-invariant'
  | 'storage'
  | 'local-bug';

export const shouldRethrowEntityTxError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return ENTITY_TX_INVARIANT_ERROR_PREFIXES.some(prefix => message.startsWith(prefix));
};

export const classifyEntityInputApplyFailure = (
  error: unknown,
): EntityInputApplyFailureKind => {
  if (error instanceof MalformedEntityFrameInputError) return 'malformed-ingress';
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('STORAGE_')) return 'storage';
  if (shouldRethrowEntityTxError(error)) return 'state-machine-invariant';
  return 'local-bug';
};
