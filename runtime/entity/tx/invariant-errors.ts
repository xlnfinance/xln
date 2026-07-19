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

export const shouldRethrowEntityTxError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return ENTITY_TX_INVARIANT_ERROR_PREFIXES.some(prefix => message.startsWith(prefix));
};
