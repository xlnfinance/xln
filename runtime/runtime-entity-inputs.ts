import { applyEntityInput } from './entity-consensus';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
  isCrossJurisdictionEntityInputRemoteHopAllowed,
} from './cross-jurisdiction-boundary';
import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHint,
  resolveRuntimeIdForCrossJurisdictionEntity,
  type RuntimeEntityRoutingDeps,
} from './runtime-entity-routing';
import { resolveEntityProposerId } from './state-helpers';
import { safeStringify } from './serialization-utils';
import type { EntityInput, EntityReplica, Env, JInput, RoutedEntityInput } from './types';
import { validateEntityOutput } from './validation-utils';
import { DEBUG } from './utils';
import { logError } from './logger';

export interface RuntimeEntityInputApplyResult {
  entityOutbox: RoutedEntityInput[];
  appliedEntityInputs: RoutedEntityInput[];
  jOutbox: JInput[];
}

export interface RuntimeEntityInputApplyOptions {
  isReplay: boolean;
  routingDeps: RuntimeEntityRoutingDeps;
}

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

  for (const entityInput of mergedInputs) {
    if (isReplay) {
      console.log(
        `[REPLAY][RUNTIME] merged input entity=${String(entityInput.entityId).slice(-8)} ` +
          `signer=${String(entityInput.signerId ?? '')} txs=${entityInput.entityTxs?.length ?? 0} ` +
          `types=${(entityInput.entityTxs ?? []).map(tx => tx.type).join(',')}`,
      );
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
      if (env.scenarioMode || isReplay) {
        assertRuntimeIngress(
          false,
          'RUNTIME_CROSS_J_TOPOLOGY_INVALID',
          'Cross-j system inputs must stay inside their two-runtime route topology',
          dropDetails,
        );
      }
      env.error('network', 'DROP_CROSS_J_TOPOLOGY_INVALID', dropDetails, entityInput.entityId);
      continue;
    }

    if (entityInput.from) {
      for (const hintedEntityId of collectCrossJurisdictionRemoteEntityHints(
        env,
        entityInput,
        entityInput.from,
        routingDeps,
      )) {
        registerEntityRuntimeHint(env, hintedEntityId, entityInput.from, routingDeps);
      }
    }

    const localEntityReplicaKey = findReplicaKeyInsensitive(env, entityInput.entityId, null);
    if (!localEntityReplicaKey) {
      const dropDetails = {
        entityId: entityInput.entityId,
        signerId: entityInput.signerId,
        txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
        knownEntities: Array.from(env.eReplicas.keys()).map(k => String(k).split(':')[0]).filter(Boolean),
      };
      if (env.scenarioMode || isReplay) {
        assertRuntimeIngress(
          false,
          'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
          'Entity input target does not exist in local runtime',
          dropDetails,
        );
      }
      env.error('network', 'DROP_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails, entityInput.entityId);
      continue;
    }

    let actualSignerId = entityInput.signerId;
    const syntheticSignerHint = String(actualSignerId || '').toLowerCase();
    if (
      !actualSignerId ||
      actualSignerId === '' ||
      syntheticSignerHint === 'j-event' ||
      syntheticSignerHint === 'system'
    ) {
      try {
        actualSignerId = resolveEntityProposerId(env, entityInput.entityId, 'applyRuntimeInput');
      } catch (error) {
        if (env.scenarioMode || isReplay) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        env.error(
          'network',
          'DROP_ENTITY_INPUT_SIGNER_RESOLUTION_FAILED',
          {
            entityId: entityInput.entityId,
            signerId: entityInput.signerId,
            txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
            message,
          },
          entityInput.entityId,
        );
        continue;
      }
    }

    assertRuntimeIngress(
      typeof actualSignerId === 'string' && actualSignerId.length > 0,
      'RUNTIME_SIGNER_RESOLUTION_FAILED',
      'Unable to resolve signerId for entity input',
      { entityId: entityInput.entityId, providedSignerId: entityInput.signerId },
    );

    let replicaKey = `${entityInput.entityId}:${actualSignerId}`;
    let entityReplica = env.eReplicas.get(replicaKey);
    if (!entityReplica) {
      try {
        const proposerSignerId = resolveEntityProposerId(env, entityInput.entityId, 'applyRuntimeInput.recovery');
        if (proposerSignerId !== actualSignerId) {
          actualSignerId = proposerSignerId;
          replicaKey = `${entityInput.entityId}:${actualSignerId}`;
          entityReplica = env.eReplicas.get(replicaKey);
          if (!entityReplica) {
            const insensitiveMatch = findReplicaKeyInsensitive(env, entityInput.entityId, actualSignerId);
            if (insensitiveMatch) {
              replicaKey = insensitiveMatch;
              entityReplica = env.eReplicas.get(insensitiveMatch);
            }
          }
        }
      } catch (error) {
        if (env.scenarioMode || isReplay) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const localReplicaStillExists = !!findReplicaKeyInsensitive(env, entityInput.entityId, null);
        if (!localReplicaStillExists) {
          const dropDetails = {
            entityId: entityInput.entityId,
            signerId: entityInput.signerId,
            txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
            message,
          };
          env.error('network', 'DROP_ENTITY_INPUT_UNKNOWN_ENTITY', dropDetails, entityInput.entityId);
          continue;
        }
        env.error(
          'network',
          'DROP_ENTITY_INPUT_SIGNER_RESOLUTION_FAILED',
          {
            entityId: entityInput.entityId,
            signerId: entityInput.signerId,
            txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
            message,
          },
          entityInput.entityId,
        );
        continue;
      }
    }

    if (!entityReplica) {
      const insensitiveMatch = findReplicaKeyInsensitive(env, entityInput.entityId, actualSignerId);
      if (insensitiveMatch) {
        replicaKey = insensitiveMatch;
        entityReplica = env.eReplicas.get(insensitiveMatch);
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
      if (env.scenarioMode || isReplay) {
        assertRuntimeIngress(
          false,
          'RUNTIME_REPLICA_NOT_FOUND',
          'Entity input target replica missing after signer resolution',
          missingReplicaDetails,
        );
      }
      env.error('network', 'DROP_ENTITY_INPUT_REPLICA_NOT_FOUND', missingReplicaDetails, entityInput.entityId);
      throw new Error(`RUNTIME_REPLICA_NOT_FOUND: entityId=${entityInput.entityId} resolvedSignerId=${actualSignerId}`);
    }

    const result = await applyEntityInputToReplica(env, entityReplica, replicaKey, entityInput, actualSignerId, isReplay);
    appliedEntityInputs.push(result.appliedInput);
    env.eReplicas.set(replicaKey, result.nextReplica);
    entityOutbox.push(...result.outputs);
    if (result.jOutputs.length > 0) {
      console.log(`📦 [2/6] Collecting ${result.jOutputs.length} jOutputs from ${replicaKey.slice(-10)}`);
      jOutbox.push(...result.jOutputs);
    }
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
  appliedInput: RoutedEntityInput;
  nextReplica: EntityReplica;
  outputs: RoutedEntityInput[];
  jOutputs: JInput[];
}> => {
  if (DEBUG) {
    console.log(`Processing input for ${replicaKey}:`);
    if (entityInput.entityTxs?.length) console.log(`  → ${entityInput.entityTxs.length} transactions`);
    if (entityInput.proposedFrame) console.log(`  → Proposed frame: ${entityInput.proposedFrame.hash}`);
    if (entityInput.hashPrecommits?.size) console.log(`  → ${entityInput.hashPrecommits.size} precommits`);
  }

  const normalizedInput: EntityInput = {
    entityId: entityInput.entityId,
    ...(entityInput.entityTxs ? { entityTxs: entityInput.entityTxs } : {}),
    ...(entityInput.proposedFrame ? { proposedFrame: entityInput.proposedFrame } : {}),
    ...(entityInput.hashPrecommits ? { hashPrecommits: entityInput.hashPrecommits } : {}),
  };
  const normalizedInputWithSigner: EntityInput = {
    ...normalizedInput,
    signerId: actualSignerId,
  };
  const appliedInput: RoutedEntityInput = {
    ...normalizedInputWithSigner,
    signerId: actualSignerId,
  };
  if (isReplay) {
    console.log(
      `[REPLAY][RUNTIME] applyEntityInput replica=${replicaKey.slice(0, 20)} ` +
        `txs=${normalizedInput.entityTxs?.length ?? 0}`,
    );
  }

  const { newState, outputs, jOutputs, workingReplica } = await applyEntityInput(
    env,
    entityReplica,
    normalizedInputWithSigner,
  );
  const {
    proposal: _oldProposal,
    lockedFrame: _oldLockedFrame,
    hankoWitness: _oldHankoWitness,
    validatorComputedState: _oldValidatorComputedState,
    ...replicaBase
  } = entityReplica;
  const nextReplica: EntityReplica = {
    ...replicaBase,
    state: newState,
    mempool: workingReplica.mempool,
  };
  if (workingReplica.proposal !== undefined) nextReplica.proposal = workingReplica.proposal;
  if (workingReplica.lockedFrame !== undefined) nextReplica.lockedFrame = workingReplica.lockedFrame;
  if (workingReplica.hankoWitness !== undefined) nextReplica.hankoWitness = workingReplica.hankoWitness;
  if (workingReplica.validatorComputedState !== undefined) {
    nextReplica.validatorComputedState = workingReplica.validatorComputedState;
  }

  outputs.forEach((output, index) => {
    try {
      validateEntityOutput(output);
    } catch (error) {
      logError('RUNTIME_TICK', `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`, {
        error: (error as Error).message,
        output,
      });
      throw error;
    }
  });

  return { appliedInput, nextReplica, outputs, jOutputs: jOutputs || [] };
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
