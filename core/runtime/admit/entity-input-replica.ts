import { applyEntityInput } from '../../entity/consensus/index.ts';
import type { EntityInputOutcome } from '../../entity/consensus/index.ts';
import type { EntityOutput, EntityInput, EntityReplica } from '../../entity/types.ts';
import type { RoutedEntityInput, RuntimeReplica } from '../types.ts';
import type { JInput } from '../../jurisdiction/machine/input.ts';
import { resolveEntityOutputSignerId } from '../delivery/entity-output-signer.ts';
import { decodeEntityOutput } from '../delivery/topology/routing-validation.ts';
import { DEBUG } from '../../support/debug-flags.ts';
import { logError, shortId } from '../../support/logger.ts';
import { getPerfMs } from '../../support/time';
import {
  entityInputLog,
  entityInputProfileEnabled,
  entityInputSlowMs,
  isCommittedEntityInput,
  RuntimeEntityInputApplyError,
} from './entity-input-contract.ts';
import {
  authorityDriverEnabled,
  authorityRuntimeSuppressed,
  authorityCutoverStageHandle,
  type AuthorityEntityStageHandle,
} from '../../rscore/authority-driver.ts';
import {
  authorityRecordEnabled,
  runAuthorityFrameScope,
} from '../../rscore/authority-wave.ts';
import {
  runAccountAuthorityEntityStage,
  resolveAccountAuthorityEntityStageOptions,
  type AccountAuthorityEntityStageOptions,
  type AccountAuthorityEntityOccurrence,
} from '../../rscore/authority/entity-stage.ts';

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
  accountJClaimNodeChanges: Awaited<
    ReturnType<typeof applyEntityInput>
  >['accountJClaimNodeChanges'];
  entityContext: Awaited<ReturnType<typeof applyEntityInput>>['entityContext'];
  /** Open Rust savepoint; the Runtime caller owns its terminal decision. */
  authorityStage: AuthorityEntityStageHandle | null;
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

const routeEntityOutputs = async (
  env: RuntimeReplica,
  sourceReplica: EntityReplica,
  outputs: unknown[],
  replicaKey: string,
): Promise<RoutedEntityInput[]> =>
  Promise.all(outputs.map(async (output, index) => {
    try {
      const decoded: EntityOutput = decodeEntityOutput(output);
      const signerId = await resolveEntityOutputSignerId(
        env,
        sourceReplica,
        decoded,
      );
      return { ...decoded, signerId };
    } catch (error) {
      logError(
        'RUNTIME_TICK',
        `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`,
        { error: error instanceof Error ? error.message : String(error), output },
      );
      throw error;
    }
  }));

/**
 * Apply exactly one EntityInput to one resolved EntityReplica.
 *
 * Runtime provenance is restored after Entity canonicalization because WAL
 * replay must preserve the authenticated origin lanes used by live routing.
 */
const logEntityInputProfile = (
  replicaKey: string,
  rawOutputs: number,
  applyEntityInputMs: number,
  routeOutputsMs: number,
): void => {
  const totalMs = applyEntityInputMs + routeOutputsMs;
  if (!entityInputProfileEnabled() && totalMs < entityInputSlowMs()) return;
  entityInputLog.info('replica.apply_input.profile', {
    replica: shortId(replicaKey, 8),
    rawOutputs,
    applyEntityInputMs,
    routeOutputsMs,
    totalMs,
  });
};

const resolveReplicaAuthorityStage = (
  env: RuntimeReplica,
  ownerEntityId: string,
  occurrence: AccountAuthorityEntityOccurrence | undefined,
  trustedLocalRuntimeProtocol: 'cross-j' | 'account-work' | undefined,
  deferProposal: boolean,
  requiredEntityTxIndex: number | undefined,
): Readonly<{
  driverEnabled: boolean;
  migrationRecordingEnabled: boolean;
  options: AccountAuthorityEntityStageOptions | null;
}> => {
  const driverEnabled = authorityDriverEnabled(env);
  const migrationRecordingEnabled = authorityRecordEnabled(driverEnabled)
    && !authorityRuntimeSuppressed(env);
  return {
    driverEnabled,
    migrationRecordingEnabled,
    options: resolveAccountAuthorityEntityStageOptions(
      env,
      {
        ownerEntityId,
        ...(occurrence === undefined ? {} : { occurrence }),
        ...(trustedLocalRuntimeProtocol === undefined ? {} : { trustedLocalRuntimeProtocol }),
        deferProposal,
        ...(requiredEntityTxIndex === undefined ? {} : { requiredEntityTxIndex }),
      },
      migrationRecordingEnabled,
    ),
  };
};

const executeNormalizedEntityInput = async (
  env: RuntimeReplica,
  entityReplica: EntityReplica,
  normalizedInput: EntityInput,
  routedInput: RoutedEntityInput,
  authorityOptions: AccountAuthorityEntityStageOptions | null,
  promoteCandidateState: boolean,
  trustedLocalRuntimeProtocol: 'cross-j' | 'account-work' | undefined,
  deferProposal: boolean,
  requiredEntityTxIndex: number | undefined,
): Promise<Awaited<ReturnType<typeof applyEntityInput>>> => {
  try {
    return await runAccountAuthorityEntityStage(
      env,
      authorityOptions,
      () => applyEntityInput(
        env,
        entityReplica,
        normalizedInput,
        trustedLocalRuntimeProtocol
          ? { trustedLocalRuntimeProtocol, promoteCandidateState }
          : {
              promoteCandidateState,
              deferProposal,
              ...(requiredEntityTxIndex === undefined ? {} : { requiredEntityTxIndex }),
            },
      ),
    );
  } catch (error) {
    throw new RuntimeEntityInputApplyError(
      routedInput,
      trustedLocalRuntimeProtocol !== undefined,
      error,
    );
  }
};

const normalizeRoutedEntityInput = (
  replicaKey: string,
  entityInput: RoutedEntityInput,
  actualSignerId: string,
  isReplay: boolean,
): EntityInput => {
  if (DEBUG) {
    entityInputLog.debug('input.processing', {
      replica: shortId(replicaKey, 10),
      txs: entityInput.entityTxs?.length ?? 0,
      proposedFrame: entityInput.proposedFrame?.hash ?? '',
      hashPrecommits: entityInput.hashPrecommits?.size ?? 0,
    });
  }
  const normalized = normalizeEntityInputForReplica(entityInput, actualSignerId);
  if (isReplay) {
    entityInputLog.debug('replay.apply_input', {
      replica: shortId(replicaKey, 10),
      txs: normalized.entityTxs?.length ?? 0,
    });
  }
  return normalized;
};

export const applyEntityInputToReplica = async (
  env: RuntimeReplica,
  entityReplica: EntityReplica,
  replicaKey: string,
  entityInput: RoutedEntityInput,
  actualSignerId: string,
  isReplay: boolean,
  promoteCandidateState: boolean,
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work',
  deferProposal = false,
  requiredEntityTxIndex?: number,
  authorityOccurrence?: AccountAuthorityEntityOccurrence,
): Promise<AppliedEntityReplicaInput> => {
  const normalizedInput = normalizeRoutedEntityInput(replicaKey, entityInput, actualSignerId, isReplay);

  const authority = resolveReplicaAuthorityStage(
    env,
    entityReplica.entityId,
    authorityOccurrence,
    trustedLocalRuntimeProtocol,
    deferProposal,
    requiredEntityTxIndex,
  );
  const runtimeId = String(env.runtimeId ?? '');
  return runAuthorityFrameScope(
    env,
    runtimeId,
    authority.migrationRecordingEnabled,
    async () => {
      const applyStartedAt = getPerfMs();
      const applied = await executeNormalizedEntityInput(
        env,
        entityReplica,
        normalizedInput,
        entityInput,
        authority.options,
        promoteCandidateState,
        trustedLocalRuntimeProtocol,
        deferProposal,
        requiredEntityTxIndex,
      );
      const applyEntityInputMs = Math.round(getPerfMs() - applyStartedAt);

      const committed = isCommittedEntityInput(applied.outcome);
      const nextReplica: EntityReplica = committed
        ? { ...applied.workingReplica, state: applied.newState }
        : entityReplica;
      const routeOutputsStartedAt = getPerfMs();
      const outputs = await routeEntityOutputs(
        env,
        nextReplica,
        applied.outputs,
        replicaKey,
      );
      const routeOutputsMs = Math.round(getPerfMs() - routeOutputsStartedAt);
      logEntityInputProfile(replicaKey, applied.outputs.length, applyEntityInputMs, routeOutputsMs);
      const appliedInput = preserveAppliedRoutedProvenance(
        applied.canonicalAppliedInput ?? normalizedInput,
        entityInput,
        actualSignerId,
      );
      // The engine opened its savepoint while executing this input, if the
      // input moved any account at all. Nothing is staged after the fact.
      const authorityStage = authority.driverEnabled
        ? authorityCutoverStageHandle(env, entityReplica.entityId)
        : null;
      return {
        outcome: applied.outcome,
        appliedInput,
        entityFrameCommitted: didCommitEntityFrame(
          entityReplica,
          nextReplica,
          applied.outcome,
        ),
        nextReplica,
        outputs,
        jOutputs: applied.jOutputs || [],
        candidateEffects: applied.candidateEffects,
        storageChanges: applied.storageChanges,
        accountJClaimNodeChanges: applied.accountJClaimNodeChanges,
        entityContext: applied.entityContext,
        authorityStage,
      };
    },
  );
};
