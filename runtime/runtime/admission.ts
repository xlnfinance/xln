import type { EntityTx, RoutedEntityInput } from '../types';

const OUTBOX_BACKPRESSURE_EXEMPT_TXS = new Set<EntityTx['type']>([
  'scheduledWake',
  'accountInput',
  'j_event',
  'j_event_account_claim',
  'processHtlcTimeouts',
  'rollbackTimedOutFrames',
  'prepareDispute',
  'disputeStart',
  'disputeFinalize',
  'j_broadcast',
  'j_rebroadcast',
  'j_abort_sent_batch',
  'j_clear_batch',
]);

export const runtimeInputRequiresOutboxCapacity = (
  entityInputs: readonly RoutedEntityInput[],
): boolean => entityInputs.some(input =>
  !input.from &&
  (input.entityTxs ?? []).some(tx => !OUTBOX_BACKPRESSURE_EXEMPT_TXS.has(tx.type)));
