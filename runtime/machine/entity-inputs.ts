import { applyEntityInput } from '../entity/consensus/index';
import type { EntityInputOutcome } from '../entity/consensus/index';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
} from '../extensions/cross-j/boundary';
import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHint,
  type RuntimeEntityRoutingDeps,
} from './entity-routing';
import { safeStringify } from '../protocol/serialization';
import type { EntityInput, EntityReplica, EntityTx, Env, JInput, RoutedEntityInput } from '../types';
import { resolveEntityProposerId } from '../state-helpers';
import { validateEntityOutput } from '../validation-utils';
import { nodeProcess } from './platform';
import { DEBUG, getPerfMs } from '../utils';
import { createStructuredLogger, logError, shortId } from '../infra/logger';

const entityInputLog = createStructuredLogger('runtime.entity_inputs');

const isCommittedEntityInput = (outcome: EntityInputOutcome): boolean =>
  outcome.kind === 'committed';

const ENTITY_INPUT_PROFILE =
  nodeProcess?.env?.['XLN_ENTITY_INPUT_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const ENTITY_INPUT_SLOW_MS = Math.max(
  0,
  Number(nodeProcess?.env?.['XLN_ENTITY_INPUT_SLOW_MS'] || '1000'),
);

export interface RuntimeEntityInputApplyResult {
  entityOutbox: RoutedEntityInput[];
  appliedEntityInputs: RoutedEntityInput[];
  localCrossJurisdictionEventTrace: RoutedEntityInput[];
  localCrossJurisdictionEventFailures: Array<{
    input: RoutedEntityInput;
    outcome: Exclude<EntityInputOutcome, { kind: 'committed' }>;
  }>;
  entityFrameCommitted: boolean;
  jOutbox: JInput[];
}

/**
 * Runtime-private map/reduce command. This is deliberately not an EntityInput:
 * it has no P2P routing fields, signer hint, or network serialization path.
 */
type CrossJCommand = {
  sourceEntityId: string;
  targetEntityId: string;
  entityTxs: EntityTx[];
};

export interface RuntimeEntityInputApplyOptions {
  isReplay: boolean;
  routingDeps: RuntimeEntityRoutingDeps;
}

const collectAppliedAccountSenderHints = (input: RoutedEntityInput): string[] => {
  const localEntityId = String(input.entityId || '').toLowerCase();
  const hints = new Set<string>();
  for (const tx of input.entityTxs ?? []) {
    if (tx.type !== 'accountInput') continue;
    const data = tx.data as { fromEntityId?: unknown; toEntityId?: unknown };
    const fromEntityId = typeof data.fromEntityId === 'string' ? data.fromEntityId.toLowerCase() : '';
    const toEntityId = typeof data.toEntityId === 'string' ? data.toEntityId.toLowerCase() : '';
    if (fromEntityId && toEntityId === localEntityId && fromEntityId !== localEntityId) hints.add(fromEntityId);
  }
  return [...hints];
};

const assertRuntimeIngress: (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => asserts condition = (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => {
  if (condition) return;
  const detailText = details ? ` ${safeStringify(details)}` : '';
  throw new Error(`${code}: ${message}${detailText}`);
};

export const applyMergedEntityInputs = async (
  env: Env,
  mergedInputs: RoutedEntityInput[],
  initialJOutbox: JInput[],
  options: RuntimeEntityInputApplyOptions,
): Promise<RuntimeEntityInputApplyResult> => {
  const entityOutbox: RoutedEntityInput[] = [];
  const appliedEntityInputs: RoutedEntityInput[] = [];
  const localCrossJurisdictionEventTrace: RoutedEntityInput[] = [];
  const localCrossJurisdictionEventFailures: RuntimeEntityInputApplyResult['localCrossJurisdictionEventFailures'] = [];
  let entityFrameCommitted = false;
  const jOutbox: JInput[] = [...initialJOutbox];
  const { isReplay, routingDeps } = options;
  const profileStartedAt = getPerfMs();
  const profiledInputs: Array<Record<string, unknown>> = [];
  const crossJCommandQueue: CrossJCommand[] = [];
  let localEventCount = 0;

  const routeCommittedEntityOutputs = (outputs: RoutedEntityInput[]): void => {
    for (const output of outputs) {
      if (isCrossJCommandEnvelope(output)) {
        const command = decodeCrossJCommand(env, output);
        const tail = crossJCommandQueue.at(-1);
        if (
          tail &&
          tail.sourceEntityId === command.sourceEntityId &&
          tail.targetEntityId === command.targetEntityId
        ) {
          tail.entityTxs.push(...command.entityTxs);
        } else {
          crossJCommandQueue.push(command);
        }
        continue;
      }
      if (output.localRuntimeProtocol === 'cross-j') {
        throw new Error(`RUNTIME_CROSS_J_UNCOMMITTED_OUTPUT_FORBIDDEN:entity=${output.entityId}`);
      }
      entityOutbox.push(output);
    }
  };

  const drainImmediateCrossJurisdictionOutputs = async (): Promise<void> => {
    const localEventFingerprints = new Set<string>();
    let localEventRound = 0;
    while (crossJCommandQueue.length > 0) {
      const command = crossJCommandQueue.shift()!;
      localEventRound += 1;
      localEventCount += 1;
      if (localEventRound > 64 || localEventCount > 1_000) {
        throw new Error(
          `RUNTIME_CROSS_J_EVENT_CASCADE_LIMIT:rounds=${localEventRound}:events=${localEventCount}`,
        );
      }
      const actualSignerId = resolveEntityProposerId(
        env,
        command.targetEntityId,
        'cross-j local command',
      ).trim();
      const entityInput = crossJCommandToEntityInput(command, actualSignerId);
      const fingerprint = safeStringify({
        sourceEntityId: command.sourceEntityId,
        targetEntityId: command.targetEntityId,
        entityTxs: command.entityTxs,
      });
        if (localEventFingerprints.has(fingerprint)) {
          throw new Error(
            `RUNTIME_CROSS_J_EVENT_CYCLE:round=${localEventRound}:entity=${entityInput.entityId}`,
          );
        }
        localEventFingerprints.add(fingerprint);
        const inputProfileStartedAt = getPerfMs();
        const replicaKey = findReplicaKeyInsensitive(env, entityInput.entityId, actualSignerId);
        assertRuntimeIngress(
          replicaKey,
          'RUNTIME_CROSS_J_LOCAL_REPLICA_NOT_FOUND',
          'Immediate cross-j local output target replica disappeared',
          {
            entityId: entityInput.entityId,
            signerId: actualSignerId,
            txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
          },
        );
        const entityReplica = env.eReplicas.get(replicaKey);
        assertRuntimeIngress(
          entityReplica,
          'RUNTIME_CROSS_J_LOCAL_REPLICA_EMPTY',
          'Immediate cross-j local output target replica missing state',
          { replicaKey },
        );
        const result = await applyEntityInputToReplica(
          env,
          entityReplica,
          replicaKey,
          entityInput,
          actualSignerId,
          isReplay,
          true,
        );
        localCrossJurisdictionEventTrace.push(result.appliedInput);
        if (result.outcome.kind !== 'committed') {
          const outcomeDetail = result.outcome.kind === 'rejected'
            ? result.outcome.code
            : result.outcome.reason;
          localCrossJurisdictionEventFailures.push({
            input: result.appliedInput,
            outcome: result.outcome,
          });
          entityInputLog.error('crossj.local_event_not_applied', {
            entity: entityInput.entityId,
            signer: actualSignerId,
            outcome: result.outcome.kind,
            detail: outcomeDetail,
            localEventRound,
            txTypes: (entityInput.entityTxs ?? []).map(tx => tx.type),
          });
          continue;
        }
        entityFrameCommitted ||= result.entityFrameCommitted;
        const inputElapsedMs = Math.round(getPerfMs() - inputProfileStartedAt);
        if (ENTITY_INPUT_PROFILE || inputElapsedMs >= ENTITY_INPUT_SLOW_MS) {
          profiledInputs.push({
            elapsedMs: inputElapsedMs,
            entity: String(entityInput.entityId || '').slice(-8),
            signer: actualSignerId.slice(-8),
            txs: Number(entityInput.entityTxs?.length || 0),
            txTypes: Array.from(new Set((entityInput.entityTxs || []).map(tx => tx.type))).slice(0, 8),
            proposedFrame: Boolean(entityInput.proposedFrame),
            hashPrecommits: Number(entityInput.hashPrecommits?.size || 0),
            immediateCrossJ: true,
            localEventRound,
            outputs: result.outputs.length,
            jOutputs: result.jOutputs.length,
          });
        }
        env.eReplicas.set(replicaKey, result.nextReplica);
        routeCommittedEntityOutputs(result.outputs);
        if (result.jOutputs.length > 0) {
          entityInputLog.debug('j_outputs.collected', {
            count: result.jOutputs.length,
            replica: shortId(replicaKey, 10),
          });
          jOutbox.push(...result.jOutputs);
        }
    }
  };

  for (const entityInput of mergedInputs) {
    if (
      entityInput.localRuntimeProtocol === 'cross-j' ||
      (entityInput.entityTxs ?? []).some(tx => tx.type === 'runtimeOutput')
    ) {
      throw new Error(
        `RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN:entity=${entityInput.entityId}`,
      );
    }
    const inputProfileStartedAt = getPerfMs();
    if (isReplay) {
      entityInputLog.debug('replay.merged_input', {
        entity: shortId(entityInput.entityId, 8),
        signer: shortId(entityInput.signerId ?? '', 8),
        txs: entityInput.entityTxs?.length ?? 0,
        types: (entityInput.entityTxs ?? []).map(tx => tx.type),
      });
    }

    if (
      entityInput.from &&
      entityInputHasCrossJurisdictionIntraRuntimeTx(entityInput)
    ) {
      const dropDetails = {
        entityId: entityInput.entityId,
        from: entityInput.from,
        txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
      };
      env.error('network', 'REJECT_CROSS_J_TOPOLOGY_INVALID', dropDetails, entityInput.entityId);
      assertRuntimeIngress(
        false,
        'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN',
        'Cross-j Entity inputs are runtime-private and cannot arrive from a remote runtime',
        dropDetails,
      );
    }

    const localEntityReplicaKey = findReplicaKeyInsensitive(env, entityInput.entityId, null);
    if (!localEntityReplicaKey) {
      const dropDetails = {
        entityId: entityInput.entityId,
        signerId: entityInput.signerId,
        txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
        knownEntities: Array.from(env.eReplicas.keys()).map(k => String(k).split(':')[0]).filter(Boolean),
      };
      env.error('network', 'REJECT_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails, entityInput.entityId);
      assertRuntimeIngress(
        false,
        'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
        'Entity input target does not exist in local runtime',
        dropDetails,
      );
    }

    const actualSignerId = entityInput.signerId.trim();

    assertRuntimeIngress(
      typeof actualSignerId === 'string' && actualSignerId.length > 0,
      'RUNTIME_SIGNER_MISSING',
      'Entity input missing mandatory signerId',
      { entityId: entityInput.entityId, providedSignerId: entityInput.signerId },
    );

    let replicaKey = `${entityInput.entityId}:${actualSignerId}`;
    let entityReplica = env.eReplicas.get(replicaKey);

    if (!entityReplica) {
      const insensitiveMatch = findReplicaKeyInsensitive(env, entityInput.entityId, actualSignerId);
      if (insensitiveMatch) {
        replicaKey = insensitiveMatch;
        entityReplica = env.eReplicas.get(insensitiveMatch);
      }
    }

    if (!entityReplica) {
      const localReplicaKeys = findReplicaKeysForEntityInsensitive(env, entityInput.entityId);
      const txTypes = (entityInput.entityTxs || []).map(tx => tx.type);
      if (localReplicaKeys.length === 1 && txTypes.length === 0) {
        replicaKey = localReplicaKeys[0]!;
        entityReplica = env.eReplicas.get(replicaKey);
        env.warn('network', 'ENTITY_INPUT_SIGNER_HINT_RETARGETED', {
          entityId: entityInput.entityId,
          inputSignerId: entityInput.signerId,
          resolvedReplicaKey: replicaKey,
          txTypes,
        }, entityInput.entityId);
      }
    }

    if (!entityReplica) {
      const missingReplicaDetails = {
        entityId: entityInput.entityId,
        resolvedSignerId: actualSignerId,
        inputSignerId: entityInput.signerId,
        knownReplicas: Array.from(env.eReplicas.keys()).filter(k =>
          String(k)
            .toLowerCase()
            .startsWith(`${String(entityInput.entityId).toLowerCase()}:`),
        ),
      };
      env.error('network', 'REJECT_ENTITY_INPUT_REPLICA_NOT_FOUND', missingReplicaDetails, entityInput.entityId);
      assertRuntimeIngress(
        false,
        'RUNTIME_REPLICA_NOT_FOUND',
        'Entity input target replica missing for exact signerId',
        missingReplicaDetails,
      );
    }

    const result = await applyEntityInputToReplica(env, entityReplica, replicaKey, entityInput, actualSignerId, isReplay);
    entityFrameCommitted ||= result.entityFrameCommitted;
    if (isCommittedEntityInput(result.outcome) && entityInput.from) {
      const appliedRouteHints = new Set([
        ...collectAppliedAccountSenderHints(entityInput),
        ...collectCrossJurisdictionRemoteEntityHints(env, entityInput, entityInput.from, routingDeps),
      ]);
      for (const hintedEntityId of appliedRouteHints) {
        registerEntityRuntimeHint(env, hintedEntityId, entityInput.from, routingDeps);
      }
    }
    const inputElapsedMs = Math.round(getPerfMs() - inputProfileStartedAt);
    if (ENTITY_INPUT_PROFILE || inputElapsedMs >= ENTITY_INPUT_SLOW_MS) {
      profiledInputs.push({
        elapsedMs: inputElapsedMs,
        entity: String(entityInput.entityId || '').slice(-8),
        signer: actualSignerId.slice(-8),
        txs: Number(entityInput.entityTxs?.length || 0),
        txTypes: Array.from(new Set((entityInput.entityTxs || []).map(tx => tx.type))).slice(0, 8),
        proposedFrame: Boolean(entityInput.proposedFrame),
        hashPrecommits: Number(entityInput.hashPrecommits?.size || 0),
        outputs: result.outputs.length,
        jOutputs: result.jOutputs.length,
      });
    }
    if (isCommittedEntityInput(result.outcome)) appliedEntityInputs.push(result.appliedInput);
    env.eReplicas.set(replicaKey, result.nextReplica);
    routeCommittedEntityOutputs(result.outputs);
    if (result.jOutputs.length > 0) {
      entityInputLog.debug('j_outputs.collected', {
        count: result.jOutputs.length,
        replica: shortId(replicaKey, 10),
      });
      jOutbox.push(...result.jOutputs);
    }
    // A later top-level Account input may causally depend on a trusted sibling
    // event emitted by this commit. Consume that local event chain before
    // advancing the ordered Runtime batch; remote outputs remain deferred.
    await drainImmediateCrossJurisdictionOutputs();
  }

  const elapsedMs = Math.round(getPerfMs() - profileStartedAt);
  if (ENTITY_INPUT_PROFILE || elapsedMs >= ENTITY_INPUT_SLOW_MS) {
    entityInputLog.warn('inputs.profile', {
      height: env.height,
      elapsedMs,
      mergedInputs: mergedInputs.length,
      appliedInputs: appliedEntityInputs.length,
      outputs: entityOutbox.length,
      jOutputs: jOutbox.length,
      slowInputs: profiledInputs
        .sort((left, right) => Number(right['elapsedMs'] || 0) - Number(left['elapsedMs'] || 0))
        .slice(0, 16),
    });
  }

  return {
    entityOutbox,
    appliedEntityInputs,
    localCrossJurisdictionEventTrace,
    localCrossJurisdictionEventFailures,
    entityFrameCommitted,
    jOutbox,
  };
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
    throw new Error(`ENTITY_FRAME_HEIGHT_TRANSITION_INVALID:${priorHeight}:${nextHeight}`);
  }
  return true;
};

const applyEntityInputToReplica = async (
  env: Env,
  entityReplica: EntityReplica,
  replicaKey: string,
  entityInput: RoutedEntityInput,
  actualSignerId: string,
  isReplay: boolean,
  trustedLocalCrossJurisdiction = false,
): Promise<{
  outcome: EntityInputOutcome;
  appliedInput: RoutedEntityInput;
  entityFrameCommitted: boolean;
  nextReplica: EntityReplica;
  outputs: RoutedEntityInput[];
  jOutputs: JInput[];
}> => {
  if (DEBUG) {
    entityInputLog.debug('input.processing', {
      replica: shortId(replicaKey, 10),
      txs: entityInput.entityTxs?.length ?? 0,
      proposedFrame: entityInput.proposedFrame?.hash ?? '',
      hashPrecommits: entityInput.hashPrecommits?.size ?? 0,
    });
  }

  const normalizedInput: EntityInput = {
    entityId: entityInput.entityId,
    signerId: actualSignerId,
    ...(entityInput.entityTxs ? { entityTxs: entityInput.entityTxs } : {}),
    ...(entityInput.proposedFrame ? { proposedFrame: entityInput.proposedFrame } : {}),
    ...(entityInput.hashPrecommitFrame ? { hashPrecommitFrame: entityInput.hashPrecommitFrame } : {}),
    ...(entityInput.hashPrecommits ? { hashPrecommits: entityInput.hashPrecommits } : {}),
    ...(entityInput.jPrefixAttestations
      ? { jPrefixAttestations: entityInput.jPrefixAttestations }
      : {}),
    ...(entityInput.leaderTimeoutVote ? { leaderTimeoutVote: entityInput.leaderTimeoutVote } : {}),
  };
  if (isReplay) {
    entityInputLog.debug('replay.apply_input', {
      replica: shortId(replicaKey, 10),
      txs: normalizedInput.entityTxs?.length ?? 0,
    });
  }

  const { outcome, newState, outputs, jOutputs, workingReplica, canonicalAppliedInput } = await applyEntityInput(
    env,
    entityReplica,
    normalizedInput,
    trustedLocalCrossJurisdiction
      ? { trustedLocalRuntimeProtocol: 'cross-j' }
      : undefined,
  );
  const appliedInput: RoutedEntityInput = {
    ...(canonicalAppliedInput ?? normalizedInput),
    signerId: actualSignerId,
  };
  const committed = isCommittedEntityInput(outcome);
  const nextReplica: EntityReplica = committed ? {
    ...workingReplica,
    state: newState,
  } : entityReplica;
  const entityFrameCommitted = didCommitEntityFrame(entityReplica, nextReplica, outcome);

  const routedOutputs: RoutedEntityInput[] = [];
  outputs.forEach((output, index) => {
    try {
      routedOutputs.push(validateEntityOutput(output));
    } catch (error) {
      logError('RUNTIME_TICK', `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`, {
        error: (error as Error).message,
        output,
      });
      throw error;
    }
  });

  return {
    outcome,
    appliedInput,
    entityFrameCommitted,
    nextReplica,
    outputs: routedOutputs,
    jOutputs: jOutputs || [],
  };
};

const findReplicaKeyInsensitive = (env: Env, entityId: string, signerId?: string | null): string | null => {
  const entityNorm = String(entityId || '').toLowerCase();
  const signerNorm = signerId ? String(signerId).toLowerCase() : null;
  for (const key of env.eReplicas.keys()) {
    const [repEntityId, repSignerId] = String(key).split(':');
    if (!repEntityId || String(repEntityId).toLowerCase() !== entityNorm) continue;
    if (!signerNorm) return key;
    if (repSignerId && String(repSignerId).toLowerCase() === signerNorm) return key;
  }
  return null;
};

const findReplicaKeysForEntityInsensitive = (env: Env, entityId: string): string[] => {
  const entityNorm = String(entityId || '').toLowerCase();
  return Array.from(env.eReplicas.keys()).filter((key) => {
    const [repEntityId] = String(key).split(':');
    return Boolean(repEntityId && String(repEntityId).toLowerCase() === entityNorm);
  });
};

const normalizeRuntimeRef = (value: unknown): string => String(value || '').trim().toLowerCase();

type CrossJCommandEnvelope = RoutedEntityInput & {
  entityTxs: [Extract<EntityTx, { type: 'runtimeOutput' }>];
};

const isCrossJCommandEnvelope = (output: RoutedEntityInput): output is CrossJCommandEnvelope => (
  !output.proposedFrame &&
  !output.hashPrecommits &&
  !output.leaderTimeoutVote &&
  Array.isArray(output.entityTxs) &&
  output.entityTxs.length === 1 &&
  output.entityTxs[0]?.type === 'runtimeOutput' &&
  output.entityTxs[0].data.protocol === 'cross-j'
);

const decodeCrossJCommand = (env: Env, output: RoutedEntityInput): CrossJCommand => {
  if (!isCrossJCommandEnvelope(output)) {
    throw new Error(`RUNTIME_CROSS_J_COMMAND_ENVELOPE_INVALID:entity=${output.entityId}`);
  }
  const localRuntimeId = normalizeRuntimeRef(env.runtimeId);
  const outputRuntimeId = normalizeRuntimeRef(output.runtimeId);
  if (outputRuntimeId && localRuntimeId && outputRuntimeId !== localRuntimeId) {
    throw new Error(`RUNTIME_CROSS_J_COMMAND_REMOTE_RUNTIME_FORBIDDEN:${outputRuntimeId}`);
  }
  const fromRuntimeId = normalizeRuntimeRef(output.from);
  if (fromRuntimeId && localRuntimeId && fromRuntimeId !== localRuntimeId) {
    throw new Error(`RUNTIME_CROSS_J_COMMAND_REMOTE_SOURCE_FORBIDDEN:${fromRuntimeId}`);
  }
  const wrapper = output.entityTxs[0];
  const sourceEntityId = String(wrapper.data.sourceEntityId || '').trim().toLowerCase();
  const targetEntityId = String(wrapper.data.targetEntityId || '').trim().toLowerCase();
  if (!sourceEntityId || !targetEntityId || targetEntityId !== String(output.entityId || '').toLowerCase()) {
    throw new Error(
      `RUNTIME_CROSS_J_COMMAND_ROUTE_INVALID:source=${sourceEntityId || 'missing'}:` +
        `target=${targetEntityId || 'missing'}:envelope=${output.entityId}`,
    );
  }
  if (!findReplicaKeyInsensitive(env, targetEntityId, null)) {
    throw new Error(`RUNTIME_CROSS_J_COMMAND_TARGET_NOT_LOCAL:${targetEntityId}`);
  }
  if (!Array.isArray(wrapper.data.entityTxs) || wrapper.data.entityTxs.length === 0) {
    throw new Error(`RUNTIME_CROSS_J_COMMAND_TXS_MISSING:${targetEntityId}`);
  }
  return {
    sourceEntityId,
    targetEntityId,
    entityTxs: structuredClone(wrapper.data.entityTxs),
  };
};

const crossJCommandToEntityInput = (
  command: CrossJCommand,
  proposerSignerId: string,
): RoutedEntityInput => ({
  entityId: command.targetEntityId,
  signerId: proposerSignerId,
  entityTxs: [{
    type: 'runtimeOutput',
    data: {
      protocol: 'cross-j',
      sourceEntityId: command.sourceEntityId,
      targetEntityId: command.targetEntityId,
      entityTxs: structuredClone(command.entityTxs),
    },
  }],
});
