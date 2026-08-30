import type { EntityTx } from '../../../types/entity-tx';
import { haltRuntimeFailure } from '../../../protocol/errors/failure-taxonomy';
import type { EntityOutput } from '../../types';
import { cloneIsolatedEntityTxs } from '../../state/input-clone';
import { getAccountOnlyEntityTx } from './envelope';

const isNonMutatingWake = (output: EntityOutput): boolean =>
  Array.isArray(output.entityTxs) &&
  output.entityTxs.length === 0 &&
  output.proposedFrame === undefined &&
  output.hashPrecommits === undefined &&
  output.hashPrecommitFrame === undefined &&
  output.leaderTimeoutVote === undefined;

const requireRawAccountOutput = (
  sourceEntityId: string,
  output: EntityOutput,
  outputIndex: number,
): Extract<EntityTx, { type: 'accountInput' }> | null => {
  const tx = getAccountOnlyEntityTx(output.entityTxs);
  if (!tx) return null;
  if (
    output.proposedFrame ||
    output.hashPrecommits ||
    output.hashPrecommitFrame ||
    output.leaderTimeoutVote
  ) {
    throw new Error(`ACCOUNT_OUTPUT_PROTOCOL_FIELDS_FORBIDDEN:index=${outputIndex}`);
  }
  const source = sourceEntityId.trim().toLowerCase();
  const target = output.entityId.trim().toLowerCase();
  const claimedSource = tx.data.fromEntityId.trim().toLowerCase();
  const claimedTarget = tx.data.toEntityId.trim().toLowerCase();
  if (claimedSource !== source) {
    throw haltRuntimeFailure(
      'ACCOUNT_OUTPUT_SOURCE_MISMATCH',
      `ACCOUNT_OUTPUT_SOURCE_MISMATCH:index=${outputIndex}:source=${source}:claimed=${claimedSource}`,
    );
  }
  if (!target || claimedTarget !== target) {
    throw haltRuntimeFailure(
      'ACCOUNT_OUTPUT_TARGET_MISMATCH',
      `ACCOUNT_OUTPUT_TARGET_MISMATCH:index=${outputIndex}:route=${target || 'missing'}:claimed=${claimedTarget}`,
    );
  }
  return tx;
};

/**
 * Publish only outputs whose authority already exists at their native layer.
 * AccountInput carries Account Hankos. Every other mutating Entity output is
 * one canonical Runtime output: local targets are applied in this Runtime
 * transition; remote targets enter the committed flat Runtime outbox.
 */
export const materializeCommittedEntityOutputs = (
  outputs: EntityOutput[],
  sourceEntityId: string,
  sourceSignerId: string,
  emitRuntimeOutputs: boolean,
): EntityOutput[] => outputs.flatMap((output, outputIndex): EntityOutput[] => {
  if (isNonMutatingWake(output)) return [structuredClone(output)];
  if (requireRawAccountOutput(sourceEntityId, output, outputIndex)) {
    const entityTxs = output.entityTxs;
    if (!entityTxs) throw new Error(`ACCOUNT_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
    return [{ ...output, entityId: output.entityId.trim().toLowerCase(), entityTxs: cloneIsolatedEntityTxs(entityTxs) }];
  }
  if (!emitRuntimeOutputs) return [];
  const targetEntityId = output.entityId.trim().toLowerCase();
  const targetSignerId = output.signerId?.trim().toLowerCase() ?? '';
  const source = sourceEntityId.trim().toLowerCase();
  const sourceSigner = sourceSignerId.trim().toLowerCase();
  if (!targetEntityId || !targetSignerId || !source || !sourceSigner) {
    throw new Error(`RUNTIME_OUTPUT_ROUTE_MISSING:index=${outputIndex}`);
  }
  if (!output.entityTxs?.length) {
    throw new Error(`RUNTIME_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
  }
  return [{
    entityId: targetEntityId,
    signerId: targetSignerId,
    entityTxs: [{
      type: 'runtimeOutput',
      data: {
        protocol: 'cross-j',
        sourceEntityId: source,
        sourceSignerId: sourceSigner,
        targetEntityId,
        entityTxs: cloneIsolatedEntityTxs(output.entityTxs),
      },
    }],
  }];
});
