import type { EntityTx } from '../../types/entity-tx.ts';
import type { RoutedEntityInput, RuntimeReplica } from '../types.ts';
import { safeStringify } from '../../protocol/serialization.ts';
import { getPerfMs } from '../../infra/time.ts';
import { shortId } from '../../infra/logger.ts';
import {
  assertRuntimeEntityIngress,
  findEntityReplicaKey,
} from './entity-input-admission.ts';
import {
  entityInputLog,
  entityInputProfileEnabled,
  entityInputSlowMs,
  type CrossJCommand,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputBatchContext,
} from './entity-input-contract.ts';
import {
  applyEntityInputToReplica,
  type AppliedEntityReplicaInput,
} from './entity-input-replica.ts';
import { cacheCommittedConsumptionNodeChanges } from '../../entity/consumption/consumption-store';
import { cacheCommittedAccountJClaimNodeChanges } from '../../entity/account/account-j-claim-node-store';
import {
  applyStorageChanges,
  publishEntityCandidateEffects,
} from '../env-events.ts';

export const recordEntityInputProfile = (
  context: RuntimeEntityInputBatchContext,
  input: RoutedEntityInput,
  signerId: string,
  elapsedMs: number,
  result: AppliedEntityReplicaInput,
  immediate?: { localEventRound: number },
): void => {
  if (!entityInputProfileEnabled() && elapsedMs < entityInputSlowMs()) return;
  context.profiledInputs.push({
    elapsedMs,
    entity: String(input.entityId || '').slice(-8),
    signer: signerId.slice(-8),
    txs: Number(input.entityTxs?.length || 0),
    txTypes: Array.from(
      new Set((input.entityTxs || []).map(tx => tx.type)),
    ).slice(0, 8),
    proposedFrame: Boolean(input.proposedFrame),
    hashPrecommits: Number(input.hashPrecommits?.size || 0),
    ...(immediate
      ? { immediateCrossJ: true, localEventRound: immediate.localEventRound }
      : {}),
    outputs: result.outputs.length,
    jOutputs: result.jOutputs.length,
  });
};

type CrossJCommandEnvelope = RoutedEntityInput & {
  entityTxs: [Extract<EntityTx, { type: 'runtimeOutput' }>];
};

const isCrossJCommandEnvelope = (
  output: RoutedEntityInput,
): output is CrossJCommandEnvelope =>
  !output.proposedFrame &&
  !output.hashPrecommits &&
  !output.leaderTimeoutVote &&
  Array.isArray(output.entityTxs) &&
  output.entityTxs.length === 1 &&
  output.entityTxs[0]?.type === 'runtimeOutput' &&
  output.entityTxs[0].data.protocol === 'cross-j';

const normalizeRuntimeRef = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

const decodeCrossJCommand = (
  env: RuntimeReplica,
  output: RoutedEntityInput,
): CrossJCommand => {
  if (!isCrossJCommandEnvelope(output)) {
    throw new Error(
      `RUNTIME_CROSS_J_COMMAND_ENVELOPE_INVALID:entity=${output.entityId}`,
    );
  }
  const localRuntimeId = normalizeRuntimeRef(env.runtimeId);
  const outputRuntimeId = normalizeRuntimeRef(output.runtimeId);
  if (
    outputRuntimeId &&
    localRuntimeId &&
    outputRuntimeId !== localRuntimeId
  ) {
    throw new Error(
      `RUNTIME_CROSS_J_COMMAND_REMOTE_RUNTIME_FORBIDDEN:${outputRuntimeId}`,
    );
  }
  const fromRuntimeId = normalizeRuntimeRef(output.from);
  if (fromRuntimeId && localRuntimeId && fromRuntimeId !== localRuntimeId) {
    throw new Error(
      `RUNTIME_CROSS_J_COMMAND_REMOTE_SOURCE_FORBIDDEN:${fromRuntimeId}`,
    );
  }
  const wrapper = output.entityTxs[0];
  const sourceEntityId = String(wrapper.data.sourceEntityId || '')
    .trim()
    .toLowerCase();
  const targetEntityId = String(wrapper.data.targetEntityId || '')
    .trim()
    .toLowerCase();
  const targetSignerId = String(output.signerId || '').trim().toLowerCase();
  if (
    !sourceEntityId ||
    !targetEntityId ||
    !targetSignerId ||
    targetEntityId !== String(output.entityId || '').toLowerCase()
  ) {
    throw new Error(
      `RUNTIME_CROSS_J_COMMAND_ROUTE_INVALID:source=${sourceEntityId || 'missing'}:` +
        `target=${targetEntityId || 'missing'}:envelope=${output.entityId}`,
    );
  }
  if (!findEntityReplicaKey(env, targetEntityId, targetSignerId)) {
    throw new Error(
      `RUNTIME_CROSS_J_COMMAND_TARGET_NOT_LOCAL:${targetEntityId}:${targetSignerId}`,
    );
  }
  if (
    !Array.isArray(wrapper.data.entityTxs) ||
    wrapper.data.entityTxs.length === 0
  ) {
    throw new Error(`RUNTIME_CROSS_J_COMMAND_TXS_MISSING:${targetEntityId}`);
  }
  return {
    sourceEntityId,
    targetEntityId,
    targetSignerId,
    entityTxs: structuredClone(wrapper.data.entityTxs),
  };
};

const commandToEntityInput = (
  command: CrossJCommand,
): RoutedEntityInput => ({
  entityId: command.targetEntityId,
  signerId: command.targetSignerId,
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

const routeCommittedEntityOutputs = (
  env: RuntimeReplica,
  outputs: RoutedEntityInput[],
  context: RuntimeEntityInputBatchContext,
): void => {
  // Coalesce only inside one Entity frame; crossing it breaks causality.
  const commands: CrossJCommand[] = [];
  const indexes = new Map<string, number>();
  for (const output of outputs) {
    if (isCrossJCommandEnvelope(output)) {
      const command = decodeCrossJCommand(env, output);
      const key = `${command.sourceEntityId}\0${command.targetEntityId}\0${command.targetSignerId}`;
      const index = indexes.get(key);
      if (index === undefined) {
        indexes.set(key, commands.length);
        commands.push(command);
      } else {
        commands[index]!.entityTxs.push(...command.entityTxs);
      }
    } else if (output.localRuntimeProtocol === 'cross-j') {
      throw new Error(
        `RUNTIME_CROSS_J_UNCOMMITTED_OUTPUT_FORBIDDEN:entity=${output.entityId}`,
      );
    } else {
      context.entityOutbox.push(output);
    }
  }
  context.crossJCommandQueue.push(...commands);
};

export const collectCommittedEntityResult = (
  env: RuntimeReplica,
  replicaKey: string,
  result: Awaited<ReturnType<typeof applyEntityInputToReplica>>,
  context: RuntimeEntityInputBatchContext,
): void => {
  env.state.eReplicas.set(replicaKey, result.nextReplica);
  applyStorageChanges(env, result.nextReplica.state, result.storageChanges);
  publishEntityCandidateEffects(env, result.nextReplica, result.candidateEffects);
  routeCommittedEntityOutputs(env, result.outputs, context);
  if (result.jOutputs.length === 0) return;
  entityInputLog.debug('j_outputs.collected', {
    count: result.jOutputs.length,
    replica: shortId(replicaKey, 10),
  });
  context.jOutbox.push(...result.jOutputs);
};

export const drainImmediateCrossJurisdictionOutputs = async (
  env: RuntimeReplica,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  const fingerprints = new Set<string>();
  let round = 0;
  while (context.crossJCommandQueue.length > 0) {
    const command = context.crossJCommandQueue.shift()!;
    round += 1;
    context.localEventCount += 1;
    if (round > 64 || context.localEventCount > 1_000) {
      throw new Error(
        `RUNTIME_CROSS_J_EVENT_CASCADE_LIMIT:rounds=${round}:events=${context.localEventCount}`,
      );
    }
    const signerId = command.targetSignerId;
    const input = commandToEntityInput(command);
    const fingerprint = safeStringify(command);
    if (fingerprints.has(fingerprint)) {
      throw new Error(
        `RUNTIME_CROSS_J_EVENT_CYCLE:round=${round}:entity=${input.entityId}`,
      );
    }
    fingerprints.add(fingerprint);
    const replicaKey = findEntityReplicaKey(env, input.entityId, signerId);
    assertRuntimeEntityIngress(
      replicaKey,
      'RUNTIME_CROSS_J_LOCAL_REPLICA_NOT_FOUND',
      'Immediate cross-j target replica disappeared',
      { entityId: input.entityId, signerId },
    );
    const replica = env.state.eReplicas.get(replicaKey);
    assertRuntimeEntityIngress(
      replica,
      'RUNTIME_CROSS_J_LOCAL_REPLICA_EMPTY',
      'Immediate cross-j target replica has no state',
      { replicaKey },
    );
    options.beforeEntityApply?.(input.entityId);
    const startedAt = getPerfMs();
    const result = await applyEntityInputToReplica(
      env,
      replica,
      replicaKey,
      input,
      signerId,
      options.isReplay,
      true,
      true,
    );
    context.localCrossJurisdictionEventTrace.push(result.appliedInput);
    if (result.outcome.kind !== 'committed') {
      const detail = result.outcome.kind === 'rejected'
        ? result.outcome.code
        : result.outcome.reason;
      throw new Error(
        `RUNTIME_CROSS_J_LOCAL_EVENT_NOT_COMMITTED:entity=${input.entityId}:` +
          `round=${round}:outcome=${result.outcome.kind}:detail=${detail}`,
      );
    }
    context.entityFrameCommitted ||= result.entityFrameCommitted;
    const elapsedMs = Math.round(getPerfMs() - startedAt);
    context.immediateCrossJApplyMs += elapsedMs;
    recordEntityInputProfile(
      context,
      input,
      signerId,
      elapsedMs,
      result,
      { localEventRound: round },
    );
    collectCommittedEntityResult(env, replicaKey, result, context);
    cacheCommittedConsumptionNodeChanges(env, result.consumptionNodeChanges);
    cacheCommittedAccountJClaimNodeChanges(env, result.accountJClaimNodeChanges);
  }
};
