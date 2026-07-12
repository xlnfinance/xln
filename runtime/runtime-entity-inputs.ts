import { applyEntityInput, mergeEntityInputs } from './entity-consensus';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
  isCrossJurisdictionEntityInputRemoteHopAllowed,
} from './extensions/cross-j/boundary';
import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHint,
  resolveRuntimeIdForCrossJurisdictionEntity,
  type RuntimeEntityRoutingDeps,
} from './runtime-entity-routing';
import { safeStringify } from './serialization-utils';
import type { EntityInput, EntityReplica, Env, JInput, RoutedEntityInput } from './types';
import { validateEntityOutput } from './validation-utils';
import { nodeProcess } from './runtime-platform';
import { DEBUG, getPerfMs } from './utils';
import { createStructuredLogger, logError, shortId } from './logger';

const entityInputLog = createStructuredLogger('runtime.entity_inputs');

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
  jOutbox: JInput[];
}

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
  const jOutbox: JInput[] = [...initialJOutbox];
  const { isReplay, routingDeps } = options;
  const profileStartedAt = getPerfMs();
  const profiledInputs: Array<Record<string, unknown>> = [];

  for (const entityInput of mergedInputs) {
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
      entityInputHasCrossJurisdictionIntraRuntimeTx(entityInput) &&
      !isCrossJurisdictionEntityInputRemoteHopAllowed(
        entityInput,
        env.runtimeId,
        entityInput.from,
        entityId => resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, routingDeps),
      )
    ) {
      const dropDetails = {
        entityId: entityInput.entityId,
        from: entityInput.from,
        txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
      };
      env.error('network', 'REJECT_CROSS_J_TOPOLOGY_INVALID', dropDetails, entityInput.entityId);
      assertRuntimeIngress(
        false,
        'RUNTIME_CROSS_J_TOPOLOGY_INVALID',
        'Cross-j system inputs must stay inside their two-runtime route topology',
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
    if (result.accepted && entityInput.from) {
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
    if (result.accepted) appliedEntityInputs.push(result.appliedInput);
    env.eReplicas.set(replicaKey, result.nextReplica);
    entityOutbox.push(...result.outputs);
    if (result.jOutputs.length > 0) {
      entityInputLog.debug('j_outputs.collected', {
        count: result.jOutputs.length,
        replica: shortId(replicaKey, 10),
      });
      jOutbox.push(...result.jOutputs);
    }
  }

  const immediateCrossJOutputs = entityOutbox.filter(output => isImmediateLocalCrossJurisdictionOutput(env, output));
  if (immediateCrossJOutputs.length > 0) {
    const deferredOutputs = entityOutbox.filter(output => !isImmediateLocalCrossJurisdictionOutput(env, output));
    entityOutbox.length = 0;
    entityOutbox.push(...deferredOutputs);

    for (const entityInput of mergeEntityInputs(immediateCrossJOutputs)) {
      const inputProfileStartedAt = getPerfMs();
      const actualSignerId = entityInput.signerId.trim();
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
      );
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
          outputs: result.outputs.length,
          jOutputs: result.jOutputs.length,
        });
      }
      if (result.accepted) appliedEntityInputs.push(result.appliedInput);
      env.eReplicas.set(replicaKey, result.nextReplica);
      entityOutbox.push(...result.outputs);
      if (result.jOutputs.length > 0) {
        entityInputLog.debug('j_outputs.collected', {
          count: result.jOutputs.length,
          replica: shortId(replicaKey, 10),
        });
        jOutbox.push(...result.jOutputs);
      }
    }
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

  return { entityOutbox, appliedEntityInputs, jOutbox };
};

const applyEntityInputToReplica = async (
  env: Env,
  entityReplica: EntityReplica,
  replicaKey: string,
  entityInput: RoutedEntityInput,
  actualSignerId: string,
  isReplay: boolean,
): Promise<{
  accepted: boolean;
  appliedInput: RoutedEntityInput;
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
    ...(entityInput.hashPrecommits ? { hashPrecommits: entityInput.hashPrecommits } : {}),
  };
  const appliedInput: RoutedEntityInput = {
    ...normalizedInput,
    signerId: actualSignerId,
  };
  if (isReplay) {
    entityInputLog.debug('replay.apply_input', {
      replica: shortId(replicaKey, 10),
      txs: normalizedInput.entityTxs?.length ?? 0,
    });
  }

  const { accepted, newState, outputs, jOutputs, workingReplica } = await applyEntityInput(
    env,
    entityReplica,
    normalizedInput,
  );
  const {
    proposal: _oldProposal,
    lockedFrame: _oldLockedFrame,
    hankoWitness: _oldHankoWitness,
    validatorComputedState: _oldValidatorComputedState,
    ...replicaBase
  } = entityReplica;
  const nextReplica: EntityReplica = accepted ? {
    ...replicaBase,
    state: newState,
    mempool: workingReplica.mempool,
  } : entityReplica;
  if (accepted && workingReplica.proposal !== undefined) nextReplica.proposal = workingReplica.proposal;
  if (accepted && workingReplica.lockedFrame !== undefined) nextReplica.lockedFrame = workingReplica.lockedFrame;
  if (accepted && workingReplica.hankoWitness !== undefined) nextReplica.hankoWitness = workingReplica.hankoWitness;
  if (accepted && workingReplica.validatorComputedState !== undefined) {
    nextReplica.validatorComputedState = workingReplica.validatorComputedState;
  }

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

  return { accepted, appliedInput, nextReplica, outputs: routedOutputs, jOutputs: jOutputs || [] };
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

const isImmediateLocalCrossJurisdictionOutput = (env: Env, output: RoutedEntityInput): boolean => {
  if (!entityInputHasCrossJurisdictionIntraRuntimeTx(output)) return false;
  const localRuntimeId = normalizeRuntimeRef(env.runtimeId);
  const outputRuntimeId = normalizeRuntimeRef(output.runtimeId);
  if (outputRuntimeId && localRuntimeId && outputRuntimeId !== localRuntimeId) return false;
  const fromRuntimeId = normalizeRuntimeRef(output.from);
  if (fromRuntimeId && localRuntimeId && fromRuntimeId !== localRuntimeId) return false;
  const signerId = String(output.signerId || '').trim();
  if (!signerId) return false;
  return Boolean(findReplicaKeyInsensitive(env, output.entityId, signerId));
};
