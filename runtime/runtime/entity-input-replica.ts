import { applyEntityInput } from '../entity/consensus/index';
import type { EntityInputOutcome } from '../entity/consensus/index';
import type {
  EntityInput,
  EntityReplica,
  JInput,
  RoutedEntityInput,
  RuntimeState,
} from '../types';
import { decodeRoutedEntityOutput } from './routing-validation';
import { DEBUG } from '../utils';
import { logError, shortId } from '../infra/logger';
import {
  entityInputLog,
  isCommittedEntityInput,
  RuntimeEntityInputApplyError,
} from './entity-input-contract';

export type AppliedEntityReplicaInput = {
  outcome: EntityInputOutcome;
  appliedInput: RoutedEntityInput;
  entityFrameCommitted: boolean;
  nextReplica: EntityReplica;
  outputs: RoutedEntityInput[];
  jOutputs: JInput[];
  candidateEffects: Awaited<
    ReturnType<typeof applyEntityInput>
  >['candidateEffects'];
  storageChanges: Awaited<
    ReturnType<typeof applyEntityInput>
  >['storageChanges'];
};

const didCommitEntityFrame = (
  priorReplica: EntityReplica,
  nextReplica: EntityReplica,
  outcome: EntityInputOutcome,
): boolean => {
  if (!isCommittedEntityInput(outcome)) return false;
  const priorHeight = Number(priorReplica.state.height);
  const nextHeight = Number(nextReplica.state.height);
  if (nextHeight === priorHeight) return false;
  if (
    !Number.isSafeInteger(priorHeight) ||
    !Number.isSafeInteger(nextHeight) ||
    nextHeight !== priorHeight + 1
  ) {
    throw new Error(
      `ENTITY_FRAME_HEIGHT_TRANSITION_INVALID:${priorHeight}:${nextHeight}`,
    );
  }
  return true;
};

const preserveAppliedRoutedProvenance = (
  appliedInput: EntityInput,
  routedInput: RoutedEntityInput,
  signerId: string,
): RoutedEntityInput => ({
  ...appliedInput,
  signerId,
  ...(routedInput.runtimeId !== undefined
    ? { runtimeId: routedInput.runtimeId }
    : {}),
  ...(routedInput.from !== undefined ? { from: routedInput.from } : {}),
  ...(routedInput.sourceRuntimeFrame
    ? { sourceRuntimeFrame: { ...routedInput.sourceRuntimeFrame } }
    : {}),
  ...(routedInput.atomicCrossJurisdictionPair
    ? {
        atomicCrossJurisdictionPair: {
          ...routedInput.atomicCrossJurisdictionPair,
        },
      }
    : {}),
});

const normalizeEntityInputForReplica = (
  entityInput: RoutedEntityInput,
  signerId: string,
): EntityInput => ({
  entityId: entityInput.entityId,
  signerId,
  ...(entityInput.entityTxs ? { entityTxs: entityInput.entityTxs } : {}),
  ...(entityInput.proposedFrame
    ? { proposedFrame: entityInput.proposedFrame }
    : {}),
  ...(entityInput.hashPrecommitFrame
    ? { hashPrecommitFrame: entityInput.hashPrecommitFrame }
    : {}),
  ...(entityInput.hashPrecommits
    ? { hashPrecommits: entityInput.hashPrecommits }
    : {}),
  ...(entityInput.jPrefixAttestations
    ? { jPrefixAttestations: entityInput.jPrefixAttestations }
    : {}),
  ...(entityInput.leaderTimeoutVote
    ? { leaderTimeoutVote: entityInput.leaderTimeoutVote }
    : {}),
});

const decodeEntityOutputs = (
  outputs: unknown[],
  replicaKey: string,
): RoutedEntityInput[] =>
  outputs.map((output, index) => {
    try {
      return decodeRoutedEntityOutput(output);
    } catch (error) {
      logError(
        'RUNTIME_TICK',
        `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`,
        { error: error instanceof Error ? error.message : String(error), output },
      );
      throw error;
    }
  });

/**
 * Apply exactly one EntityInput to one resolved EntityReplica.
 *
 * Runtime provenance is restored after Entity canonicalization because WAL
 * replay must preserve the authenticated origin lanes used by live routing.
 */
export const applyEntityInputToReplica = async (
  env: RuntimeState,
  entityReplica: EntityReplica,
  replicaKey: string,
  entityInput: RoutedEntityInput,
  actualSignerId: string,
  isReplay: boolean,
  promoteCandidateState: boolean,
  trustedLocalCrossJurisdiction = false,
): Promise<AppliedEntityReplicaInput> => {
  if (DEBUG) {
    entityInputLog.debug('input.processing', {
      replica: shortId(replicaKey, 10),
      txs: entityInput.entityTxs?.length ?? 0,
      proposedFrame: entityInput.proposedFrame?.hash ?? '',
      hashPrecommits: entityInput.hashPrecommits?.size ?? 0,
    });
  }

  const normalizedInput = normalizeEntityInputForReplica(
    entityInput,
    actualSignerId,
  );
  if (isReplay) {
    entityInputLog.debug('replay.apply_input', {
      replica: shortId(replicaKey, 10),
      txs: normalizedInput.entityTxs?.length ?? 0,
    });
  }

  let applied: Awaited<ReturnType<typeof applyEntityInput>>;
  try {
    applied = await applyEntityInput(
      env,
      entityReplica,
      normalizedInput,
      trustedLocalCrossJurisdiction
        ? { trustedLocalRuntimeProtocol: 'cross-j', promoteCandidateState }
        : { promoteCandidateState },
    );
  } catch (error) {
    throw new RuntimeEntityInputApplyError(
      entityInput,
      trustedLocalCrossJurisdiction,
      error,
    );
  }

  const committed = isCommittedEntityInput(applied.outcome);
  const nextReplica: EntityReplica = committed
    ? { ...applied.workingReplica, state: applied.newState }
    : entityReplica;
  return {
    outcome: applied.outcome,
    appliedInput: preserveAppliedRoutedProvenance(
      applied.canonicalAppliedInput ?? normalizedInput,
      entityInput,
      actualSignerId,
    ),
    entityFrameCommitted: didCommitEntityFrame(
      entityReplica,
      nextReplica,
      applied.outcome,
    ),
    nextReplica,
    outputs: decodeEntityOutputs(applied.outputs, replicaKey),
    jOutputs: applied.jOutputs || [],
    candidateEffects: applied.candidateEffects,
    storageChanges: applied.storageChanges,
  };
};
