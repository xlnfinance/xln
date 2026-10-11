import type { EntityTx } from '../../../types/entity-tx';
import { rejectFailure, type FailureDispositionError } from '../../../protocol/errors/failure-taxonomy';

const DEFERRED_ENTITY_TX_KINDS: ReadonlySet<EntityTx['type']> = new Set([
  'lendingOffer',
  'lendingSetTerms',
  'lendingApprove',
  'lendingBorrow',
  'lendingRepay',
  'lendingClosePosition',
]);

/** Static launch scope; neither the process environment nor replay can enable it. */
export const entityTxAdmissionError = (tx: EntityTx): FailureDispositionError | undefined =>
  DEFERRED_ENTITY_TX_KINDS.has(tx.type)
    ? rejectFailure('ENTITY_TX_KIND_OUT_OF_PROFILE', `ENTITY_TX_KIND_OUT_OF_PROFILE:${tx.type}`)
    : undefined;
