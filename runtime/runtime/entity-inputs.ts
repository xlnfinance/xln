import { applyEntityInput } from '../entity/consensus/index';
import type { EntityInputOutcome } from '../entity/consensus/index';
import { entityInputHasCrossJurisdictionIntraRuntimeTx } from '../extensions/cross-j/boundary';
import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHintWithDeps,
  type RuntimeEntityRoutingDeps,
} from './entity-routing';
import { safeStringify } from '../protocol/serialization';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import { accountInputAck, accountInputProposal } from '../account/consensus/flush';
import type { EntityInput, EntityReplica, EntityTx, RuntimeState, JInput, RoutedEntityInput } from '../types';
import { resolveEntityProposerId } from '../state-helpers';
import { decodeRoutedEntityOutput } from '../validation-utils';
import { nodeProcess } from './platform';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../infra/perf-runtime-flags';
import { DEBUG, getPerfMs } from '../utils';
import { createStructuredLogger, logError, shortId } from '../infra/logger';
import { classifyEntityInputApplyFailure, type EntityInputApplyFailureKind } from '../entity/tx/invariant-errors';

const entityInputLog = createStructuredLogger('runtime.entity_inputs');

const isCommittedEntityInput = (outcome: EntityInputOutcome): boolean => outcome.kind === 'committed';

const ENTITY_INPUT_PROFILE =
  nodeProcess?.env?.['XLN_ENTITY_INPUT_PROFILE'] === '1' || nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const ENTITY_INPUT_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_ENTITY_INPUT_SLOW_MS'] || '1000'));
const entityInputProfileEnabled = (): boolean =>
  ENTITY_INPUT_PROFILE || isRuntimePerfProfileEnabled('XLN_ENTITY_INPUT_PROFILE');
const entityInputSlowMs = (): number => readRuntimePerfSlowMs('XLN_ENTITY_INPUT_SLOW_MS', ENTITY_INPUT_SLOW_MS);

export interface RuntimeEntityInputApplyResult {
  entityOutbox: RoutedEntityInput[];
  appliedEntityInputs: RoutedEntityInput[];
  inputOutcomes: Array<{
    inputIndex: number;
    outcome: EntityInputOutcome;
    entityFrameCommitted: boolean;
    committedAccountFrames: Array<{
      counterpartyEntityId: string;
      height: number;
      stateHash: string;
    }>;
  }>;
  localCrossJurisdictionEventTrace: RoutedEntityInput[];
  entityFrameCommitted: boolean;
  jOutbox: JInput[];
}

/**
 * Preserves authenticated transport provenance across the consensus boundary.
 * Runtime uses this typed error instead of message substring matching: an
 * malformed untrusted remote input may be discarded, while the same failure in a
 * locally generated command is a deterministic runtime bug and must halt.
 */
export class RuntimeEntityInputApplyError extends Error {
  readonly entityId: string;
  readonly signerId: string;
  readonly sourceRuntimeId: string;
  readonly sourceRuntimeHeight: number | undefined;
  readonly sourceRuntimeTimestamp: number | undefined;
  readonly trustedLocalCrossJurisdiction: boolean;
  readonly failureKind: EntityInputApplyFailureKind;

  constructor(
    input: RoutedEntityInput,
    trustedLocalCrossJurisdiction: boolean,
    cause: unknown,
    failureKind: EntityInputApplyFailureKind = classifyEntityInputApplyFailure(cause),
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `RUNTIME_ENTITY_INPUT_APPLY_FAILED:entity=${input.entityId}:` +
        `signer=${input.signerId}:txs=${(input.entityTxs ?? []).map(tx => tx.type).join(',') || 'none'}:` +
        `proposal=${input.proposedFrame ? 'yes' : 'no'}:cause=${message}`,
      { cause },
    );
    this.name = 'RuntimeEntityInputApplyError';
    this.entityId = input.entityId;
    this.signerId = input.signerId;
    this.sourceRuntimeId = String(input.from ?? '').trim();
    this.sourceRuntimeHeight = input.sourceRuntimeFrame?.height;
    this.sourceRuntimeTimestamp = input.sourceRuntimeFrame?.timestamp;
    this.trustedLocalCrossJurisdiction = trustedLocalCrossJurisdiction;
    this.failureKind = failureKind;
  }

  get isRemoteIngress(): boolean {
    return this.sourceRuntimeId.length > 0 && !this.trustedLocalCrossJurisdiction;
  }

  get isDiscardableRemoteIngress(): boolean {
    return this.isRemoteIngress && this.failureKind === 'malformed-ingress';
  }
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
  beforeEntityApply?: (entityId: string) => void;
}

export const collectAppliedAccountSenderHints = (input: RoutedEntityInput): string[] => {
  const localEntityId = String(input.entityId || '').toLowerCase();
  const hints = new Set<string>();
  for (const tx of getEffectiveEntityInputTxs(input)) {
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
) => asserts condition = (condition: unknown, code: string, message: string, details?: Record<string, unknown>) => {
  if (condition) return;
  const detailText = details ? ` ${safeStringify(details)}` : '';
  throw new Error(`${code}: ${message}${detailText}`);
};

type RuntimeEntityInputBatchContext = {
  entityOutbox: RoutedEntityInput[];
  appliedEntityInputs: RoutedEntityInput[];
  inputOutcomes: RuntimeEntityInputApplyResult['inputOutcomes'];
  localCrossJurisdictionEventTrace: RoutedEntityInput[];
  entityFrameCommitted: boolean;
  jOutbox: JInput[];
  profiledInputs: Array<Record<string, unknown>>;
  crossJCommandQueue: CrossJCommand[];
  localEventCount: number;
  externalApplyMs: number;
  immediateCrossJApplyMs: number;
};

const createRuntimeEntityInputBatchContext = (initialJOutbox: JInput[]): RuntimeEntityInputBatchContext => ({
  entityOutbox: [],
  appliedEntityInputs: [],
  inputOutcomes: [],
  localCrossJurisdictionEventTrace: [],
  entityFrameCommitted: false,
  jOutbox: [...initialJOutbox],
  profiledInputs: [],
  crossJCommandQueue: [],
  localEventCount: 0,
  externalApplyMs: 0,
  immediateCrossJApplyMs: 0,
});

const collectCommittedAccountFrames = (
  input: RoutedEntityInput,
  replica: EntityReplica,
): RuntimeEntityInputApplyResult['inputOutcomes'][number]['committedAccountFrames'] => {
  const accountInputs = getEffectiveEntityInputTxs(input).flatMap(tx =>
    tx.type === 'accountInput' && (accountInputProposal(tx.data) || accountInputAck(tx.data)) ? [tx.data] : [],
  );
  return accountInputs.flatMap(accountInput => {
    const counterpartyEntityId = accountInput.fromEntityId.toLowerCase();
    const account = [...replica.state.accounts.entries()].find(
      ([entityId]) => entityId.toLowerCase() === counterpartyEntityId,
    )?.[1];
    // A rejected genesis frame commits no Account while the surrounding
    // Entity input may still commit its warning. Absence is negative evidence
    // for atomic cross-J admission, not a Runtime invariant failure.
    if (!account) return [];
    const finalHeight = account.currentFrame.height;
    const finalStateHash = String(account.currentFrame.stateHash || '').toLowerCase();
    const proposal = accountInputProposal(accountInput);
    const ack = accountInputAck(accountInput);
    const proposalCommitted =
      proposal?.frame.height === finalHeight && String(proposal.frame.stateHash || '').toLowerCase() === finalStateHash;
    const ackCommitted =
      ack &&
      ((ack.height === finalHeight && String(ack.frameHash || '').toLowerCase() === finalStateHash) ||
        (proposalCommitted &&
          proposal.frame.height === ack.height + 1 &&
          String(proposal.frame.prevFrameHash || '').toLowerCase() === String(ack.frameHash || '').toLowerCase()));
    return [
      ...(ackCommitted
        ? [
            {
              counterpartyEntityId,
              height: ack.height,
              stateHash: String(ack.frameHash || '').toLowerCase(),
            },
          ]
        : []),
      ...(proposalCommitted
        ? [
            {
              counterpartyEntityId,
              height: proposal.frame.height,
              stateHash: String(proposal.frame.stateHash || '').toLowerCase(),
            },
          ]
        : []),
    ];
  });
};

const routeCommittedEntityOutputs = (
  env: RuntimeState,
  outputs: RoutedEntityInput[],
  context: RuntimeEntityInputBatchContext,
): void => {
  // One committed Entity frame is one causal wave. Coalesce only inside that
  // wave; merging with queued commands could cross an Entity-frame barrier.
  const localCommands: CrossJCommand[] = [];
  const localCommandIndexes = new Map<string, number>();
  for (const output of outputs) {
    if (isCrossJCommandEnvelope(output)) {
      const command = decodeCrossJCommand(env, output);
      const key = `${command.sourceEntityId}\0${command.targetEntityId}`;
      const existingIndex = localCommandIndexes.get(key);
      if (existingIndex !== undefined) {
        localCommands[existingIndex]!.entityTxs.push(...command.entityTxs);
      } else {
        localCommandIndexes.set(key, localCommands.length);
        localCommands.push(command);
      }
      continue;
    }
    if (output.localRuntimeProtocol === 'cross-j') {
      throw new Error(`RUNTIME_CROSS_J_UNCOMMITTED_OUTPUT_FORBIDDEN:entity=${output.entityId}`);
    }
    context.entityOutbox.push(output);
  }
  context.crossJCommandQueue.push(...localCommands);
};

const recordEntityInputProfile = (
  context: RuntimeEntityInputBatchContext,
  entityInput: RoutedEntityInput,
  signerId: string,
  elapsedMs: number,
  result: Awaited<ReturnType<typeof applyEntityInputToReplica>>,
  immediate?: { localEventRound: number },
): void => {
  if (!entityInputProfileEnabled() && elapsedMs < entityInputSlowMs()) return;
  context.profiledInputs.push({
    elapsedMs,
    entity: String(entityInput.entityId || '').slice(-8),
    signer: signerId.slice(-8),
    txs: Number(entityInput.entityTxs?.length || 0),
    txTypes: Array.from(new Set((entityInput.entityTxs || []).map(tx => tx.type))).slice(0, 8),
    proposedFrame: Boolean(entityInput.proposedFrame),
    hashPrecommits: Number(entityInput.hashPrecommits?.size || 0),
    ...(immediate ? { immediateCrossJ: true, localEventRound: immediate.localEventRound } : {}),
    outputs: result.outputs.length,
    jOutputs: result.jOutputs.length,
  });
};

const collectCommittedEntityResult = (
  env: RuntimeState,
  replicaKey: string,
  result: Awaited<ReturnType<typeof applyEntityInputToReplica>>,
  context: RuntimeEntityInputBatchContext,
): void => {
  env.eReplicas.set(replicaKey, result.nextReplica);
  routeCommittedEntityOutputs(env, result.outputs, context);
  if (result.jOutputs.length === 0) return;
  entityInputLog.debug('j_outputs.collected', {
    count: result.jOutputs.length,
    replica: shortId(replicaKey, 10),
  });
  context.jOutbox.push(...result.jOutputs);
};

const drainImmediateCrossJurisdictionOutputs = async (
  env: RuntimeState,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  const localEventFingerprints = new Set<string>();
  let localEventRound = 0;
  while (context.crossJCommandQueue.length > 0) {
    const command = context.crossJCommandQueue.shift()!;
    localEventRound += 1;
    context.localEventCount += 1;
    if (localEventRound > 64 || context.localEventCount > 1_000) {
      throw new Error(
        `RUNTIME_CROSS_J_EVENT_CASCADE_LIMIT:rounds=${localEventRound}:events=${context.localEventCount}`,
      );
    }
    const actualSignerId = resolveEntityProposerId(env, command.targetEntityId, 'cross-j local command').trim();
    const entityInput = crossJCommandToEntityInput(command, actualSignerId);
    const fingerprint = safeStringify(command);
    if (localEventFingerprints.has(fingerprint)) {
      throw new Error(`RUNTIME_CROSS_J_EVENT_CYCLE:round=${localEventRound}:entity=${entityInput.entityId}`);
    }
    localEventFingerprints.add(fingerprint);
    const startedAt = getPerfMs();
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
    options.beforeEntityApply?.(entityInput.entityId);
    const result = await applyEntityInputToReplica(
      env,
      entityReplica,
      replicaKey,
      entityInput,
      actualSignerId,
      options.isReplay,
      true,
    );
    context.localCrossJurisdictionEventTrace.push(result.appliedInput);
    if (result.outcome.kind !== 'committed') {
      const detail = result.outcome.kind === 'rejected' ? result.outcome.code : result.outcome.reason;
      entityInputLog.error('crossj.local_event_not_applied', {
        entity: entityInput.entityId,
        signer: actualSignerId,
        outcome: result.outcome.kind,
        detail,
        localEventRound,
        txTypes: (entityInput.entityTxs ?? []).map(tx => tx.type),
      });
      throw new Error(
        `RUNTIME_CROSS_J_LOCAL_EVENT_NOT_COMMITTED:entity=${entityInput.entityId}:` +
          `round=${localEventRound}:outcome=${result.outcome.kind}:detail=${detail}`,
      );
    }
    context.entityFrameCommitted ||= result.entityFrameCommitted;
    const elapsedMs = Math.round(getPerfMs() - startedAt);
    context.immediateCrossJApplyMs += elapsedMs;
    recordEntityInputProfile(context, entityInput, actualSignerId, elapsedMs, result, { localEventRound });
    collectCommittedEntityResult(env, replicaKey, result, context);
  }
};

const assertExternalEntityInputAllowed = (env: RuntimeState, entityInput: RoutedEntityInput): void => {
  if (
    entityInput.localRuntimeProtocol === 'cross-j' ||
    (entityInput.entityTxs ?? []).some(tx => tx.type === 'runtimeOutput')
  ) {
    throw new Error(`RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN:entity=${entityInput.entityId}`);
  }
  if (!entityInput.from || !entityInputHasCrossJurisdictionIntraRuntimeTx(entityInput)) return;
  const details = {
    entityId: entityInput.entityId,
    from: entityInput.from,
    txTypes: (entityInput.entityTxs || []).map(tx => tx.type),
  };
  env.error('network', 'REJECT_CROSS_J_TOPOLOGY_INVALID', details, entityInput.entityId);
  assertRuntimeIngress(
    false,
    'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN',
    'Cross-j Entity inputs are runtime-private and cannot arrive from a remote runtime',
    details,
  );
};

const resolveEntityInputReplica = (
  env: RuntimeState,
  entityInput: RoutedEntityInput,
): { signerId: string; replicaKey: string; replica: EntityReplica } => {
  const signerId = entityInput.signerId.trim();
  assertRuntimeIngress(signerId.length > 0, 'RUNTIME_SIGNER_MISSING', 'Entity input missing mandatory signerId', {
    entityId: entityInput.entityId,
    providedSignerId: entityInput.signerId,
  });

  let replicaKey = `${entityInput.entityId}:${signerId}`;
  let replica = env.eReplicas.get(replicaKey);
  const localReplicaKeys = replica ? [] : findReplicaKeysForEntityInsensitive(env, entityInput.entityId);
  if (!replica) {
    const signerNorm = signerId.toLowerCase();
    const match = localReplicaKeys.find(key => {
      const [, candidateSignerId] = String(key).split(':');
      return String(candidateSignerId || '').toLowerCase() === signerNorm;
    });
    if (match) {
      replicaKey = match;
      replica = env.eReplicas.get(match);
    }
  }

  const txTypes = (entityInput.entityTxs || []).map(tx => tx.type);
  if (!replica && localReplicaKeys.length === 0) {
    const details = {
      entityId: entityInput.entityId,
      signerId: entityInput.signerId,
      txTypes,
      knownEntities: Array.from(env.eReplicas.keys())
        .map(key => String(key).split(':')[0])
        .filter(Boolean),
    };
    env.error('network', 'REJECT_ENTITY_INPUT_UNKNOWN_ENTITY', details, entityInput.entityId);
    assertRuntimeIngress(
      false,
      'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
      'Entity input target does not exist in local runtime',
      details,
    );
  }
  if (!replica && localReplicaKeys.length === 1 && txTypes.length === 0) {
    replicaKey = localReplicaKeys[0]!;
    replica = env.eReplicas.get(replicaKey);
    env.warn(
      'network',
      'ENTITY_INPUT_SIGNER_HINT_RETARGETED',
      {
        entityId: entityInput.entityId,
        inputSignerId: entityInput.signerId,
        resolvedReplicaKey: replicaKey,
        txTypes,
      },
      entityInput.entityId,
    );
  }
  if (!replica) {
    const details = {
      entityId: entityInput.entityId,
      resolvedSignerId: signerId,
      inputSignerId: entityInput.signerId,
      knownReplicas: localReplicaKeys,
    };
    env.error('network', 'REJECT_ENTITY_INPUT_REPLICA_NOT_FOUND', details, entityInput.entityId);
    assertRuntimeIngress(
      false,
      'RUNTIME_REPLICA_NOT_FOUND',
      'Entity input target replica missing for exact signerId',
      details,
    );
  }
  return { signerId, replicaKey, replica };
};

const applyExternalEntityInput = async (
  env: RuntimeState,
  entityInput: RoutedEntityInput,
  inputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  const startedAt = getPerfMs();
  if (options.isReplay) {
    entityInputLog.debug('replay.merged_input', {
      entity: shortId(entityInput.entityId, 8),
      signer: shortId(entityInput.signerId ?? '', 8),
      txs: entityInput.entityTxs?.length ?? 0,
      types: (entityInput.entityTxs ?? []).map(tx => tx.type),
    });
  }
  let resolved: ReturnType<typeof resolveEntityInputReplica>;
  try {
    assertExternalEntityInputAllowed(env, entityInput);
    resolved = resolveEntityInputReplica(env, entityInput);
  } catch (error) {
    // Admission and replica resolution are part of the authenticated Entity
    // input boundary. Preserve the input's transport provenance here: a
    // malformed remote envelope may be discarded, while the identical error
    // from locally generated work is an invariant failure and must halt.
    throw new RuntimeEntityInputApplyError(
      entityInput,
      false,
      error,
      entityInput.from ? 'malformed-ingress' : 'local-bug',
    );
  }
  const { signerId, replicaKey, replica } = resolved;
  options.beforeEntityApply?.(entityInput.entityId);
  const result = await applyEntityInputToReplica(env, replica, replicaKey, entityInput, signerId, options.isReplay);
  context.inputOutcomes.push({
    inputIndex,
    outcome: result.outcome,
    entityFrameCommitted: result.entityFrameCommitted,
    committedAccountFrames: isCommittedEntityInput(result.outcome)
      ? collectCommittedAccountFrames(entityInput, result.nextReplica)
      : [],
  });
  context.entityFrameCommitted ||= result.entityFrameCommitted;
  if (isCommittedEntityInput(result.outcome) && entityInput.from) {
    const routeHints = new Set([
      ...collectAppliedAccountSenderHints(entityInput),
      ...collectCrossJurisdictionRemoteEntityHints(env, entityInput, entityInput.from, options.routingDeps),
    ]);
    for (const hintedEntityId of routeHints) {
      registerEntityRuntimeHintWithDeps(env, hintedEntityId, entityInput.from, options.routingDeps);
    }
  }
  const elapsedMs = Math.round(getPerfMs() - startedAt);
  context.externalApplyMs += elapsedMs;
  recordEntityInputProfile(context, entityInput, signerId, elapsedMs, result);
  if (isCommittedEntityInput(result.outcome)) {
    context.appliedEntityInputs.push(result.appliedInput);
  }
  collectCommittedEntityResult(env, replicaKey, result, context);
};

export const applyMergedEntityInputs = async (
  env: RuntimeState,
  mergedInputs: RoutedEntityInput[],
  initialJOutbox: JInput[],
  options: RuntimeEntityInputApplyOptions,
): Promise<RuntimeEntityInputApplyResult> => {
  const context = createRuntimeEntityInputBatchContext(initialJOutbox);
  const profileStartedAt = getPerfMs();

  for (const [inputIndex, entityInput] of mergedInputs.entries()) {
    await applyExternalEntityInput(env, entityInput, inputIndex, options, context);
    const currentPair = entityInput.atomicCrossJurisdictionPair;
    const nextPair = mergedInputs[inputIndex + 1]?.atomicCrossJurisdictionPair;
    const nextInputCompletesCurrentPair = Boolean(
      currentPair && nextPair?.phase === currentPair.phase && nextPair.pairKey === currentPair.pairKey,
    );
    // Both signed Account legs must exist in scratch state before matching or
    // any other immediate cross-j effect can observe either leg. Runtime has
    // already validated that an atomic cohort contains exactly two inputs.
    if (!nextInputCompletesCurrentPair) {
      await drainImmediateCrossJurisdictionOutputs(env, options, context);
    }
  }

  const elapsedMs = Math.round(getPerfMs() - profileStartedAt);
  if (entityInputProfileEnabled() || elapsedMs >= entityInputSlowMs()) {
    entityInputLog.info('inputs.profile', {
      height: env.height,
      elapsedMs,
      mergedInputs: mergedInputs.length,
      appliedInputs: context.appliedEntityInputs.length,
      outputs: context.entityOutbox.length,
      jOutputs: context.jOutbox.length,
      phaseTotals: {
        externalApply: context.externalApplyMs,
        immediateCrossJApply: context.immediateCrossJApplyMs,
        remainder: Math.max(0, elapsedMs - context.externalApplyMs - context.immediateCrossJApplyMs),
      },
      slowInputs: context.profiledInputs
        .sort((left, right) => Number(right['elapsedMs'] || 0) - Number(left['elapsedMs'] || 0))
        .slice(0, 16),
    });
  }

  return context;
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
  if (!Number.isSafeInteger(priorHeight) || !Number.isSafeInteger(nextHeight) || nextHeight !== priorHeight + 1) {
    throw new Error(`ENTITY_FRAME_HEIGHT_TRANSITION_INVALID:${priorHeight}:${nextHeight}`);
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
  ...(routedInput.runtimeId !== undefined ? { runtimeId: routedInput.runtimeId } : {}),
  ...(routedInput.from !== undefined ? { from: routedInput.from } : {}),
  ...(routedInput.sourceRuntimeFrame ? { sourceRuntimeFrame: { ...routedInput.sourceRuntimeFrame } } : {}),
  ...(routedInput.atomicCrossJurisdictionPair
    ? { atomicCrossJurisdictionPair: { ...routedInput.atomicCrossJurisdictionPair } }
    : {}),
});

const normalizeEntityInputForReplica = (entityInput: RoutedEntityInput, signerId: string): EntityInput => ({
  entityId: entityInput.entityId,
  signerId,
  ...(entityInput.entityTxs ? { entityTxs: entityInput.entityTxs } : {}),
  ...(entityInput.proposedFrame ? { proposedFrame: entityInput.proposedFrame } : {}),
  ...(entityInput.hashPrecommitFrame ? { hashPrecommitFrame: entityInput.hashPrecommitFrame } : {}),
  ...(entityInput.hashPrecommits ? { hashPrecommits: entityInput.hashPrecommits } : {}),
  ...(entityInput.jPrefixAttestations ? { jPrefixAttestations: entityInput.jPrefixAttestations } : {}),
  ...(entityInput.leaderTimeoutVote ? { leaderTimeoutVote: entityInput.leaderTimeoutVote } : {}),
});

const decodeEntityOutputs = (outputs: unknown[], replicaKey: string): RoutedEntityInput[] =>
  outputs.map((output, index) => {
    try {
      return decodeRoutedEntityOutput(output);
    } catch (error) {
      logError('RUNTIME_TICK', `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityOutput[${index}] from ${replicaKey}!`, {
        error: (error as Error).message,
        output,
      });
      throw error;
    }
  });

const applyEntityInputToReplica = async (
  env: RuntimeState,
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

  const normalizedInput = normalizeEntityInputForReplica(entityInput, actualSignerId);
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
      trustedLocalCrossJurisdiction ? { trustedLocalRuntimeProtocol: 'cross-j' } : undefined,
    );
  } catch (error) {
    throw new RuntimeEntityInputApplyError(entityInput, trustedLocalCrossJurisdiction, error);
  }
  const { outcome, newState, outputs, jOutputs, workingReplica, canonicalAppliedInput } = applied;
  // Consensus may canonicalize the applied body (for example, signing a local
  // leader vote), while Runtime routing provenance must remain byte-identical
  // to the authenticated envelope. Dropping the origin here makes WAL replay
  // merge inputs that live execution deliberately kept in separate origin
  // lanes, changing Entity frame partitioning and hashes after restart.
  const appliedInput = preserveAppliedRoutedProvenance(
    canonicalAppliedInput ?? normalizedInput,
    entityInput,
    actualSignerId,
  );
  const committed = isCommittedEntityInput(outcome);
  const nextReplica: EntityReplica = committed
    ? {
        ...workingReplica,
        state: newState,
      }
    : entityReplica;
  const entityFrameCommitted = didCommitEntityFrame(entityReplica, nextReplica, outcome);

  return {
    outcome,
    appliedInput,
    entityFrameCommitted,
    nextReplica,
    outputs: decodeEntityOutputs(outputs, replicaKey),
    jOutputs: jOutputs || [],
  };
};

const findReplicaKeyInsensitive = (env: RuntimeState, entityId: string, signerId?: string | null): string | null => {
  const entityNorm = String(entityId || '').toLowerCase();
  const signerNorm = signerId ? String(signerId).toLowerCase() : null;
  if (signerNorm) {
    const directKey = `${entityNorm}:${signerNorm}`;
    if (env.eReplicas.has(directKey)) return directKey;
  }
  for (const key of env.eReplicas.keys()) {
    const [repEntityId, repSignerId] = String(key).split(':');
    if (!repEntityId || String(repEntityId).toLowerCase() !== entityNorm) continue;
    if (!signerNorm) return key;
    if (repSignerId && String(repSignerId).toLowerCase() === signerNorm) return key;
  }
  return null;
};

const findReplicaKeysForEntityInsensitive = (env: RuntimeState, entityId: string): string[] => {
  const entityNorm = String(entityId || '').toLowerCase();
  return Array.from(env.eReplicas.keys()).filter(key => {
    const [repEntityId] = String(key).split(':');
    return Boolean(repEntityId && String(repEntityId).toLowerCase() === entityNorm);
  });
};

const normalizeRuntimeRef = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

type CrossJCommandEnvelope = RoutedEntityInput & {
  entityTxs: [Extract<EntityTx, { type: 'runtimeOutput' }>];
};

const isCrossJCommandEnvelope = (output: RoutedEntityInput): output is CrossJCommandEnvelope =>
  !output.proposedFrame &&
  !output.hashPrecommits &&
  !output.leaderTimeoutVote &&
  Array.isArray(output.entityTxs) &&
  output.entityTxs.length === 1 &&
  output.entityTxs[0]?.type === 'runtimeOutput' &&
  output.entityTxs[0].data.protocol === 'cross-j';

const decodeCrossJCommand = (env: RuntimeState, output: RoutedEntityInput): CrossJCommand => {
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
  const sourceEntityId = String(wrapper.data.sourceEntityId || '')
    .trim()
    .toLowerCase();
  const targetEntityId = String(wrapper.data.targetEntityId || '')
    .trim()
    .toLowerCase();
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

const crossJCommandToEntityInput = (command: CrossJCommand, proposerSignerId: string): RoutedEntityInput => ({
  entityId: command.targetEntityId,
  signerId: proposerSignerId,
  entityTxs: [
    {
      type: 'runtimeOutput',
      data: {
        protocol: 'cross-j',
        sourceEntityId: command.sourceEntityId,
        targetEntityId: command.targetEntityId,
        entityTxs: structuredClone(command.entityTxs),
      },
    },
  ],
});
