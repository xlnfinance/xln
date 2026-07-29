import { createStructuredLogger } from '../../infra/logger';
import type { RoutedEntityInput, RuntimeInput, RuntimeState } from '../../types';
import { RuntimeEntityInputApplyError } from '../entity-inputs';
import { ENV_REPLAY_MODE_KEY, envRecord } from '../loop-environment';
import { cloneRuntimeFrameMempool } from './clone';

const discardLog = createStructuredLogger('runtime.input_discard');

const sameRejectedOrigin = (
  input: RoutedEntityInput,
  error: RuntimeEntityInputApplyError,
): boolean =>
  input.entityId.toLowerCase() === error.entityId.toLowerCase() &&
  String(input.signerId || '').trim().toLowerCase() === error.signerId.trim().toLowerCase() &&
  String(input.from || '').trim().toLowerCase() === error.sourceRuntimeId.toLowerCase();

/**
 * Remove only the remote origin that produced a malformed EntityInput.
 *
 * Runtime may reduce a remote envelope beside a locally generated scheduler
 * wake for the same Entity replica. Transport provenance remains attached to
 * the original Runtime inputs, so rollback can remove only the hostile origin
 * and retain the local wake. Every unrelated RuntimeTx, JInput,
 * ReliableReceipt, and EntityInput is returned to the single Runtime mempool.
 *
 * We intentionally keep no rejected-input state or payload archive. Untrusted
 * bytes are neither consensus data nor history; retaining them would let an
 * attacker grow durable Runtime state without ever producing a valid frame.
 */
export const discardMalformedRemoteEntityInput = (
  env: RuntimeState,
  input: RuntimeInput,
  error: unknown,
  quietLogs: boolean,
): RuntimeInput | null => {
  if (env.scenarioMode || envRecord(env)[ENV_REPLAY_MODE_KEY] === true) return null;
  if (!(error instanceof RuntimeEntityInputApplyError) || !error.isDiscardableRemoteIngress) {
    return null;
  }
  const remaining = cloneRuntimeFrameMempool(input);
  const rejected = remaining.entityInputs.filter(candidate => sameRejectedOrigin(candidate, error));
  if (rejected.length === 0) return null;
  remaining.entityInputs = remaining.entityInputs.filter(candidate => !sameRejectedOrigin(candidate, error));

  const payload = {
    action: 'discarded',
    entityId: error.entityId,
    signerId: error.signerId,
    sourceRuntimeId: error.sourceRuntimeId,
    sourceRuntimeHeight: error.sourceRuntimeHeight ?? null,
    discardedInputs: rejected.length,
    txTypes: rejected.flatMap(candidate => candidate.entityTxs?.map(tx => tx.type) ?? []),
    cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
  };
  if (!quietLogs) discardLog.warn('remote_entity_input.discarded', payload);
  return remaining;
};

export class RuntimeInputDiscardedError extends Error {
  constructor(cause: Error) {
    super(`RUNTIME_ENTITY_INPUT_DISCARDED:${cause.message}`, { cause });
    this.name = 'RuntimeInputDiscardedError';
  }
}
