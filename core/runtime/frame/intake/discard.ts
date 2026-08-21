import { createStructuredLogger } from '../../../support/logger';
import type { RoutedEntityInput, RuntimeInput, RuntimeReplica } from '../../types';
import { RuntimeEntityInputApplyError } from '../../mempool/entity-inputs';
import { ENV_REPLAY_MODE_KEY, readRuntimeMetadata } from '../../loop/loop-environment.ts';
import { safeStringify } from '../../../protocol/serialization';

const discardLog = createStructuredLogger('runtime.input_discard');

const sameRejectedOrigin = (
  input: RoutedEntityInput,
  error: RuntimeEntityInputApplyError,
  sourceRuntimeId: string | undefined,
): boolean =>
  input.entityId.toLowerCase() === error.entityId.toLowerCase() &&
  String(input.signerId || '').trim().toLowerCase() === error.signerId.trim().toLowerCase() &&
  String(input.from || '').trim().toLowerCase() === (sourceRuntimeId ?? '').toLowerCase();

/**
 * Remove only the origin that produced a malformed EntityInput.
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
export const discardRejectedEntityInput = (
  env: RuntimeReplica,
  input: RuntimeInput,
  error: unknown,
  quietLogs: boolean,
): RuntimeInput | null => {
  if (env.scenarioMode || readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true) return null;
  if (!(error instanceof RuntimeEntityInputApplyError) || !error.isDiscardableIngress) {
    return null;
  }
  const sourceRuntimeId = error.sourceRuntimeId;
  const rejected = input.entityInputs.filter(candidate =>
    sameRejectedOrigin(candidate, error, sourceRuntimeId));
  if (rejected.length === 0) return null;
  const remaining: RuntimeInput = {
    runtimeTxs: input.runtimeTxs,
    entityInputs: input.entityInputs.filter(candidate =>
      !sameRejectedOrigin(candidate, error, sourceRuntimeId)),
    ...(input.jInputs !== undefined ? { jInputs: input.jInputs } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
  };

  const payload = {
    action: 'discarded',
    entityId: error.entityId,
    signerId: error.signerId,
    sourceRuntimeId: error.sourceRuntimeId ?? null,
    sourceRuntimeHeight: error.sourceRuntimeHeight ?? null,
    discardedInputs: rejected.length,
    txTypes: rejected.flatMap(candidate => candidate.entityTxs?.map(tx => tx.type) ?? []),
    cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
    rejectedInputsDump: safeStringify(rejected),
  };
  if (!quietLogs) discardLog.error('entity_input.discarded', payload);
  return remaining;
};

export class RuntimeInputDiscardedError extends Error {
  constructor(cause: Error) {
    super(`RUNTIME_ENTITY_INPUT_DISCARDED:${cause.message}`, { cause });
    this.name = 'RuntimeInputDiscardedError';
  }
}
