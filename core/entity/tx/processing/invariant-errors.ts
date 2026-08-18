import {
  FailureDispositionError,
  StorageFailureError,
  type FailureDisposition,
} from '../../../protocol/errors/failure-taxonomy.ts';

export class MalformedEntityFrameInputError extends FailureDispositionError {
  readonly txType: string;
  readonly rejection: string;
  /** Top-level frame transaction that failed; a local proposer may evict it and retry. */
  frameTx?: unknown;

  constructor(txType: string, rejection: string) {
    super('reject', rejection, `ENTITY_FRAME_TX_FAILED: type=${txType} error=${rejection}`);
    this.name = 'MalformedEntityFrameInputError';
    this.txType = txType;
    this.rejection = rejection;
  }
}

/** Authenticated frame contains a command that is invalid against committed Entity State. */
export class EntityCommandRejectionError extends MalformedEntityFrameInputError {
  constructor(rejection: string) {
    super('entityCommand', rejection);
    this.name = 'EntityCommandRejectionError';
  }
}

export type EntityInputApplyFailureKind =
  | 'unroutable-ingress'
  | 'malformed-ingress'
  | 'retryable-ingress'
  | 'signed-dispute'
  | 'state-machine-invariant'
  | 'storage'
  | 'local-bug';

export const classifyEntityInputApplyFailure = (
  error: unknown,
): EntityInputApplyFailureKind => {
  if (error instanceof MalformedEntityFrameInputError) return 'malformed-ingress';
  if (error instanceof StorageFailureError) return 'storage';
  if (error instanceof FailureDispositionError) {
    if (error.disposition === 'reject') return 'malformed-ingress';
    if (error.disposition === 'retry') return 'retryable-ingress';
    if (error.disposition === 'dispute') return 'signed-dispute';
    return 'state-machine-invariant';
  }
  return 'local-bug';
};

export const entityInputFailureDisposition = (
  kind: EntityInputApplyFailureKind,
): FailureDisposition => {
  if (kind === 'unroutable-ingress' || kind === 'malformed-ingress') return 'reject';
  if (kind === 'retryable-ingress') return 'retry';
  if (kind === 'signed-dispute') return 'dispute';
  return 'halt_runtime';
};
