import type { EntityTx } from '../types/entity-tx';
import type { RoutedEntityInput } from '../types';

const OUTBOX_BACKPRESSURE_EXEMPT_TXS = new Set<EntityTx['type']>([
  'scheduledWake',
  'accountInput',
  'j_event',
  'processHtlcTimeouts',
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
