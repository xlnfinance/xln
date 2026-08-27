import type { RuntimeFailureSignal } from '../../protocol/errors/failure-taxonomy';
import type { EntityProviderActionSubmitState } from '../../types/entity-provider-actions';
import type { JAdapterFailure } from '../../types/jurisdiction-runtime';
import type { EntityReplica } from '../types';
import { copyJPrefixRound } from '../state/input-clone';

const copyStringRecord = (
  record: Record<string, string>,
): Record<string, string> => Object.fromEntries(Object.entries(record));

const copyRuntimeFailureSignal = (failure: RuntimeFailureSignal): RuntimeFailureSignal => ({
  category: failure.category,
  code: failure.code,
  message: failure.message,
  retryable: failure.retryable,
  fatal: failure.fatal,
});

const copyJAdapterFailure = (failure: JAdapterFailure): JAdapterFailure => ({
  category: failure.category,
  code: failure.code,
  message: failure.message,
});

type JSubmitState = NonNullable<EntityReplica['jSubmitState']>;
type JSubmitFailure = NonNullable<JSubmitState['lastFailure']>;

const copyJSubmitFailure = (failure: JSubmitFailure): JSubmitFailure => ({
  message: failure.message,
  failedAt: failure.failedAt,
  failure: copyRuntimeFailureSignal(failure.failure),
  ...(failure.adapterFailure ? { adapterFailure: copyJAdapterFailure(failure.adapterFailure) } : {}),
});

export const copyJSubmitState = (state: JSubmitState): JSubmitState => ({
  jurisdictionName: state.jurisdictionName,
  batchHash: state.batchHash,
  entityNonce: state.entityNonce,
  batchGeneration: state.batchGeneration,
  submitAttempts: state.submitAttempts,
  lastSubmittedAt: state.lastSubmittedAt,
  ...(state.txHash !== undefined ? { txHash: state.txHash } : {}),
  ...(state.lastFailure ? { lastFailure: copyJSubmitFailure(state.lastFailure) } : {}),
  ...(state.terminalFailure ? { terminalFailure: copyJSubmitFailure(state.terminalFailure) } : {}),
  ...(state.lastResultAttemptId !== undefined ? { lastResultAttemptId: state.lastResultAttemptId } : {}),
  ...(state.lastResultAt !== undefined ? { lastResultAt: state.lastResultAt } : {}),
  ...(state.lastResultOutcome !== undefined ? { lastResultOutcome: state.lastResultOutcome } : {}),
  ...(state.lastResultFingerprint !== undefined
    ? { lastResultFingerprint: state.lastResultFingerprint }
    : {}),
  ...(state.resultFingerprints ? { resultFingerprints: copyStringRecord(state.resultFingerprints) } : {}),
  ...(state.resultFingerprintOrder ? { resultFingerprintOrder: [...state.resultFingerprintOrder] } : {}),
});

type ProviderSubmitFailure = NonNullable<EntityProviderActionSubmitState['lastFailure']>;

const copyProviderSubmitFailure = (failure: ProviderSubmitFailure): ProviderSubmitFailure => ({
  message: failure.message,
  failedAt: failure.failedAt,
  ...(failure.adapterFailure ? { adapterFailure: copyJAdapterFailure(failure.adapterFailure) } : {}),
});

export const copyEntityProviderActionSubmitState = (
  state: EntityProviderActionSubmitState,
): EntityProviderActionSubmitState => ({
  jurisdictionName: state.jurisdictionName,
  actionHash: state.actionHash,
  actionNonce: state.actionNonce,
  generation: state.generation,
  submitAttempts: state.submitAttempts,
  lastSubmittedAt: state.lastSubmittedAt,
  ...(state.txHash !== undefined ? { txHash: state.txHash } : {}),
  ...(state.lastFailure ? { lastFailure: copyProviderSubmitFailure(state.lastFailure) } : {}),
  ...(state.terminalFailure ? { terminalFailure: copyProviderSubmitFailure(state.terminalFailure) } : {}),
  ...(state.lastResultAttemptId !== undefined ? { lastResultAttemptId: state.lastResultAttemptId } : {}),
  ...(state.lastResultAt !== undefined ? { lastResultAt: state.lastResultAt } : {}),
  ...(state.lastResultOutcome !== undefined ? { lastResultOutcome: state.lastResultOutcome } : {}),
  ...(state.lastResultFingerprint !== undefined
    ? { lastResultFingerprint: state.lastResultFingerprint }
    : {}),
  ...(state.resultFingerprints ? { resultFingerprints: copyStringRecord(state.resultFingerprints) } : {}),
  ...(state.resultFingerprintOrder ? { resultFingerprintOrder: [...state.resultFingerprintOrder] } : {}),
});

export { copyJPrefixRound };
