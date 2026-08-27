import type { EntityTx } from '../../../types/entity-tx';
import { haltRuntimeFailure } from '../../../protocol/errors/failure-taxonomy';
import type { EntityInput, EntityOutput } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { cloneIsolatedEntityTxs } from '../../state/input-clone';
import { getAccountOnlyEntityTx } from './envelope';

const isLocalRuntimeProtocolOutput = (
  output: EntityOutput,
): output is EntityInput & { localRuntimeProtocol: 'cross-j' } =>
  output.localRuntimeProtocol === 'cross-j';

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
    output.leaderTimeoutVote ||
    output.localRuntimeProtocol
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
 * AccountInput carries Account Hankos; sibling Runtime output stays local.
 * Generic cross-Entity effects are outside the current RRS protocol and fail
 * loudly until a source-Entity-frame inclusion proof is specified.
 */
export const materializeCommittedEntityOutputs = (
  outputs: EntityOutput[],
  sourceEntityId: string,
  env: EntityRuntimeContext,
  emitLocalRuntimeOutputs: boolean,
): EntityOutput[] => outputs.flatMap((output, outputIndex): EntityOutput[] => {
  if (isNonMutatingWake(output)) return [structuredClone(output)];
  if (isLocalRuntimeProtocolOutput(output)) {
    if (!emitLocalRuntimeOutputs) return [];
    const targetEntityId = output.entityId.trim().toLowerCase();
    const localTarget = Array.from(env.state.eReplicas.values()).some(
      replica =>
        replica.entityId.toLowerCase() === targetEntityId &&
        replica.signerId.toLowerCase() === output.signerId.toLowerCase(),
    );
    if (!localTarget) {
      throw new Error(`RUNTIME_OUTPUT_TARGET_NOT_LOCAL:${targetEntityId}:${output.signerId}`);
    }
    if (!output.entityTxs?.length) throw new Error(`RUNTIME_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
    return [{
      entityId: targetEntityId,
      signerId: output.signerId.toLowerCase(),
      entityTxs: [{
        type: 'runtimeOutput',
        data: {
          protocol: 'cross-j',
          sourceEntityId: sourceEntityId.toLowerCase(),
          targetEntityId,
          entityTxs: cloneIsolatedEntityTxs(output.entityTxs),
        },
      }],
    }];
  }
  if (requireRawAccountOutput(sourceEntityId, output, outputIndex)) {
    const entityTxs = output.entityTxs;
    if (!entityTxs) throw new Error(`ACCOUNT_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
    return [{ ...output, entityId: output.entityId.trim().toLowerCase(), entityTxs: cloneIsolatedEntityTxs(entityTxs) }];
  }
  throw new Error(`GENERIC_ENTITY_OUTPUT_UNSUPPORTED:index=${outputIndex}`);
});
