/**
 * Canonical Runtime frame transaction: validate, mutate an isolated candidate,
 * commit the authoritative WAL, publish live state, then run external effects.
 * Key entrypoint: applyAndCommitRuntimeFrame. Human-audit importance: 100/100.
 */
import { recordOpEvent, runWithOpScopes } from '../../support/performance/op-counters';
import { TIMING } from '../../config/constants';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { recordRuntimeTraceForTesting } from '../observability/runtime-trace';
import { createStructuredLogger } from '../../support/logger';
import { flushCommittedNetworkOutputs } from './dispatch';
import { ensureRuntimeConfig } from '../loop/loop-environment';
import { enqueueRuntimeContinuation, enqueueRuntimeInputs } from '../loop/loop-envelope';
import { collectReplicaMempoolWakeInputs, generateHookPings } from '../loop/loop-work';
import { notifyRuntimeFrameCommitted } from './notifications';
import type { createRuntimeLoopApi } from '../loop/loop.ts';
import { materializePendingJurisdictionImportResults } from '../j-submit/jurisdiction-import';
import { requireRuntimeMempool } from '../mempool/input-queue';
import { haltRuntimeRequiresOperator } from '../replica/lifecycle';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import type { createRuntimeRecoveryApi } from '../../storage/recovery/restore';
import type { createRuntimeStorageApi } from '../../storage/runtime-storage';
import { notifyRuntimeSyncAfterCommit } from '../../storage/runtime-storage';
import type { EntityInput } from '../../entity/types';
import type { RuntimeInput, RuntimeReplica } from '../types';
import { getWallClockMs } from '../../support/time';
import {
  clearPendingAuditEvents,
  clearRuntimeFrameEvents,
  flushPendingAuditEvents,
  readRuntimeFrameEvents,
} from '../observability/env-events';
import { recordCommittedRuntimeEntityMetrics } from '../observability/entity-metrics';
import { acquireRuntimeFrameWriter, assertRuntimeWriterAcceptingIngress } from './lifecycle/writer-lock';
import { createFrameExecutionState, type FrameExecutionState } from './intake/execution-state';
import {
  createRuntimeFrameTransaction,
  publishRuntimeFrameTransaction,
} from './transaction';
import { createRuntimeProcessProfile, type RuntimeProcessProfile } from './process-profile';
import { restoreUndurableRuntimeInput } from './intake/recovery';
import {
  applyRejectedIngressPolicy,
  discardRejectedEntityInput,
  RuntimeInputDiscardedError,
  type RejectedEntityIngressEvidence,
} from './intake/discard';
import { startRuntimeFrame, type RuntimeFrameStart } from './lifecycle/start';
import { prepareRuntimeFrameInput } from './lifecycle/prepare';
import { applyPreparedRuntimeFrame } from './apply';
import { planRuntimeFrameOutputs } from './plan';
import { prepareRuntimeFrameCommit } from './snapshot';
import { handleRuntimeFrameStorageFailure } from './lifecycle/storage-failure';
import { runCommittedRuntimeEffects } from './lifecycle/post-commit';
import { finishRuntimeFrame, handleRuntimeFrameFailure } from './lifecycle/finish';
import type { RuntimeInputReducer } from './intake/reducer';
import { getLiveJAdapterEntries } from '../j-submit/live-jadapters';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeProcessDeps = {
  loop: Pick<ReturnType<typeof createRuntimeLoopApi>, 'hasRuntimeWork' | 'isRuntimeFrameReady' | 'getRuntimeWorkReason'>;
  recovery: Pick<ReturnType<typeof createRuntimeRecoveryApi>, 'reconcileCommittedRuntimeInfraEffects'>;
  storage: Pick<ReturnType<typeof createRuntimeStorageApi>, 'saveEnvToDB' | 'RuntimeFrameStorageError'>;
  applyRuntimeInput: RuntimeInputReducer;
  getRuntimeOutputRoutingDeps(): ReturnType<ReturnType<typeof createRuntimeLoopApi>['getRuntimeOutputRoutingDeps']>;
};

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;
type RuntimeIngressDecision =
  | { ready: true }
  | { ready: false; outcome: 'no-work' | 'not-ready' };

const collectRuntimeIngress = async (
  env: RuntimeReplica,
  profile: RuntimeProcessProfile,
  deps: RuntimeProcessDeps,
): Promise<RuntimeIngressDecision> => {
  const ingressTimestamp = env.scenarioMode ? (env.state.timestamp ?? 0) : getWallClockMs();
  if (env.pendingOutputs?.length) {
    enqueueRuntimeContinuation(env, env.pendingOutputs, undefined, undefined, ingressTimestamp);
    env.pendingOutputs = [];
  }
  if (env.networkInbox?.length) {
    enqueueRuntimeContinuation(env, env.networkInbox, undefined, undefined, ingressTimestamp);
    env.networkInbox = [];
  }
  profile.mark('ingressQueues');

  await materializePendingJurisdictionImportResults(env, runtimeTx => {
    enqueueRuntimeContinuation(
      env,
      undefined,
      [runtimeTx],
      undefined,
      env.scenarioMode ? env.state.timestamp : getWallClockMs(),
    );
  });
  profile.mark('jurisdictionImports');
  profile.mark('enqueue');

  if (!deps.loop.hasRuntimeWork(env)) return { ready: false, outcome: 'no-work' };
  const gateTimestamp = env.scenarioMode ? (env.state.timestamp ?? 0) : getWallClockMs();
  if (!deps.loop.isRuntimeFrameReady(env, gateTimestamp)) {
    return { ready: false, outcome: 'not-ready' };
  }
  profile.mark('frameReady');
  return { ready: true };
};

type RuntimeFrameCandidate = {
  transaction: ReturnType<typeof createRuntimeFrameTransaction>;
  env: RuntimeReplica;
  state: RuntimeLifecycleState;
  mempool: RuntimeInput;
  runtimeInput: RuntimeInput;
  frameTimestamp: number;
  mempoolQueuedAt: number | undefined;
  quietRuntimeLogs: boolean;
};

const buildRuntimeFrameInput = (
  env: RuntimeReplica,
  mempool: RuntimeInput,
): RuntimeInput => {
  const replicaWakes = collectReplicaMempoolWakeInputs(env);
  const automaticInputs = [
    ...replicaWakes.entityInputs,
    ...replicaWakes.accountInputs,
  ];
  const explicitKeys = new Set(
    mempool.entityInputs.map(input =>
      `${String(input.entityId || '').toLowerCase()}:${String(input.signerId || '').toLowerCase()}`),
  );
  const dedupedAutomaticInputs = automaticInputs.filter(input => {
    const key = `${input.entityId.toLowerCase()}:${input.signerId.toLowerCase()}`;
    if (explicitKeys.has(key)) return false;
    explicitKeys.add(key);
    return true;
  });
  const runtimeInput: RuntimeInput = {
    runtimeTxs: [...mempool.runtimeTxs],
    entityInputs: [...mempool.entityInputs, ...dedupedAutomaticInputs],
    ...(mempool.jInputs?.length ? { jInputs: [...mempool.jInputs] } : {}),
  };
  return runtimeInput;
};

const recordRuntimeFrameIngress = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  queuedAt: number | undefined,
): void => {
  let entityTxs = 0;
  let accountProposals = 0;
  let ackFrames = 0;
  let acks = 0;
  for (const input of runtimeInput.entityInputs) {
    for (const tx of input.entityTxs ?? []) {
      entityTxs += 1;
      if (tx.type !== 'accountInput') continue;
      if (tx.data.kind === 'ack_frame') {
        accountProposals += 1;
        if (tx.data.ack) ackFrames += 1;
      }
      else if (tx.data.kind === 'ack') acks += 1;
    }
  }
  recordOpEvent('runtime.frame.ingress', {
    runtimeId: String(env.runtimeId ?? env.dbNamespace ?? 'unknown').trim().toLowerCase(),
    height: env.state.height + 1,
    queuedAt: queuedAt ?? -1,
    entityInputs: runtimeInput.entityInputs.length,
    entityTxs,
    accountProposals,
    ackFrames,
    acks,
  });
};

const resolveRuntimeFrameTimestamp = (
  env: RuntimeReplica,
  mempoolQueuedAt: number | undefined,
): number => {
  if (env.scenarioMode) {
    return requireBoundaryInteger(
      requireBoundaryInteger(env.state.timestamp, 'RUNTIME_TIMESTAMP_INVALID') + 100,
      'RUNTIME_TIMESTAMP_OVERFLOW',
    );
  }
  const liveNow = getWallClockMs();
  const previousTimestamp = requireBoundaryInteger(env.state.timestamp, 'RUNTIME_TIMESTAMP_INVALID');
  if (previousTimestamp > liveNow + TIMING.TIMESTAMP_DRIFT_MS) {
    throw new Error(`RUNTIME_CLOCK_AHEAD: env.timestamp=${previousTimestamp} wall=${liveNow}`);
  }
  const queuedTimestamp = requireBoundaryInteger(
    mempoolQueuedAt ?? liveNow,
    'RUNTIME_MEMPOOL_TIMESTAMP_INVALID',
  );
  return Math.max(
    previousTimestamp,
    Math.min(queuedTimestamp, liveNow + TIMING.TIMESTAMP_DRIFT_MS),
  );
};

const openRuntimeFrameCandidate = (
  liveEnv: RuntimeReplica,
  liveState: RuntimeLifecycleState,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
): RuntimeFrameCandidate => {
  const quietRuntimeLogs = liveEnv.quietRuntimeLogs === true;
  const frameTimestamp = resolveRuntimeFrameTimestamp(
    liveEnv,
    requireRuntimeMempool(liveEnv).queuedAt,
  );
  // Due scheduler work belongs to the frame being detached, not to arrivals
  // that may race in while this single writer awaits storage or signatures.
  generateHookPings(liveEnv, frameTimestamp, frameTimestamp);
  const mempoolQueuedAt = requireRuntimeMempool(liveEnv).queuedAt;
  const transaction = createRuntimeFrameTransaction(liveEnv);
  frame.transaction = transaction;
  profile.metrics.cloneBytes = 0;
  profile.metrics.cloneMs = 0;
  const env = liveEnv;
  const state = ensureRuntimeInfrastructure(env);
  const mempool = transaction.frameMempool;
  for (const { adapter } of getLiveJAdapterEntries(env)) {
    adapter.setQuietLogs?.(quietRuntimeLogs);
  }
  const runtimeInput = buildRuntimeFrameInput(env, mempool);
  recordRuntimeFrameIngress(env, runtimeInput, mempoolQueuedAt);
  liveState.inFlightEntityInputs = runtimeInput.entityInputs.length;
  return {
    transaction,
    env,
    state,
    mempool,
    runtimeInput,
    frameTimestamp,
    mempoolQueuedAt,
    quietRuntimeLogs,
  };
};

const beginRuntimeFrameMutation = (
  candidate: RuntimeFrameCandidate,
  frame: FrameExecutionState,
  deps: RuntimeProcessDeps,
): void => {
  // All expected ingress rejection must happen while the durable State is
  // still untouched. Past this line every exception requires halt + reload.
  deps.applyRuntimeInput.validate(candidate.env, candidate.runtimeInput);
  frame.mutationStarted = true;
  ensureRuntimeInfrastructure(candidate.env).stateMutationInFlight = true;
  candidate.env.state.timestamp = candidate.frameTimestamp;
  for (const { adapter } of getLiveJAdapterEntries(candidate.env)) {
    adapter.setBlockTimestamp?.(candidate.env.state.timestamp);
  }
};

type RuntimeFrameCommitResult = {
  env: RuntimeReplica;
  state: RuntimeLifecycleState;
  staleWriterStopped: boolean;
};

const haltStaleRuntimeWriter = async (
  liveEnv: RuntimeReplica,
  frame: FrameExecutionState,
  frameHeightBeforeTick: number,
  profile: RuntimeProcessProfile,
): Promise<RuntimeFrameCommitResult> => {
  frame.failureHandled = true;
  if (!frame.restoreUndurableInput) throw new Error('RUNTIME_FRAME_INPUT_RESTORE_MISSING');
  const staleWriterError = new Error('STALE_RUNTIME_WRITER_STOPPED');
  const rollbackError = await frame.restoreUndurableInput(staleWriterError, {
    discardMalformedRemoteInput: false,
    requeue: false,
  });
  const state = ensureRuntimeInfrastructure(liveEnv);
  haltRuntimeRequiresOperator(
    liveEnv,
    new Error(
      `STALE_RUNTIME_WRITER_STOPPED: frame=${frameHeightBeforeTick + 1} ` +
      `runtime=${String(liveEnv.runtimeId || '').slice(0, 12)}`,
    ),
  );
  profile.outcome = 'stale-writer-stopped';
  if (rollbackError !== staleWriterError) throw rollbackError;
  return { env: liveEnv, state, staleWriterStopped: true };
};

const publishCommittedRuntimeFrame = (
  candidateEnv: RuntimeReplica,
  frame: FrameExecutionState,
  appliedInput: RuntimeInput | undefined,
  quietLogs: boolean,
  profile: RuntimeProcessProfile,
): RuntimeFrameCommitResult => {
  if (!frame.transaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_COMMIT');
  frame.commitDisposition = 'committed';
  profile.mark('save');
  flushPendingAuditEvents(candidateEnv);
  const committedEvents = readRuntimeFrameEvents(candidateEnv);
  clearRuntimeFrameEvents(candidateEnv);
  const env = publishRuntimeFrameTransaction(frame.transaction);
  recordCommittedRuntimeEntityMetrics(env, env.state.height, committedEvents);
  const state = ensureRuntimeInfrastructure(env);
  if (frame.pendingTraceSnapshot) {
    recordRuntimeTraceForTesting(env, frame.pendingTraceSnapshot);
  }
  if (!quietLogs) runtimeLog.debug('storage.save.done', { height: env.state.height });
  profile.mark('publish');
  if (appliedInput) {
    const notificationError = notifyRuntimeSyncAfterCommit(env);
    if (notificationError) {
      runtimeLog.error('runtime_sync.notification_failed', {
        error: notificationError.message,
        height: env.state.height,
      });
    }
    notifyRuntimeFrameCommitted(env, appliedInput);
  }
  return { env, state, staleWriterStopped: false };
};

const commitRuntimeFrame = async (
  candidateEnv: RuntimeReplica,
  liveEnv: RuntimeReplica,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  options: {
    frameAdvanced: boolean;
    frameHeightBeforeTick: number;
    frameTimestampBeforeTick: number;
    appliedInput: RuntimeInput | undefined;
    quietLogs: boolean;
  },
  deps: RuntimeProcessDeps,
): Promise<RuntimeFrameCommitResult> => {
  if (!frame.transaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_COMMIT');
  if (!options.frameAdvanced) {
    candidateEnv.state.timestamp = options.frameTimestampBeforeTick;
    for (const { adapter } of getLiveJAdapterEntries(candidateEnv)) {
      adapter.setBlockTimestamp?.(options.frameTimestampBeforeTick);
    }
    frame.commitDisposition = 'committed';
    clearPendingAuditEvents(candidateEnv);
    const env = publishRuntimeFrameTransaction(frame.transaction);
    return { env, state: ensureRuntimeInfrastructure(env), staleWriterStopped: false };
  }

  if (!options.quietLogs) runtimeLog.debug('storage.save.start', { height: candidateEnv.state.height });
  try {
    const outcome = await deps.storage.saveEnvToDB(
      candidateEnv,
      options.appliedInput,
      candidateEnv.pendingNetworkOutputs,
      frame.entityContexts,
    );
    profile.metrics.storageMs = outcome.persistencePerfMs;
    if (outcome.persistencePerfMs) {
      profile.metrics.walMs = outcome.persistencePerfMs.authoritativeWrite;
    }
    if (outcome.staleWriterStopped) {
      return haltStaleRuntimeWriter(liveEnv, frame, options.frameHeightBeforeTick, profile);
    }
    return publishCommittedRuntimeFrame(
      candidateEnv,
      frame,
      options.appliedInput,
      options.quietLogs,
      profile,
    );
  } catch (error) {
    if (error instanceof deps.storage.RuntimeFrameStorageError) {
      await handleRuntimeFrameStorageFailure(
        error.commitStatus,
        error,
        liveEnv,
        candidateEnv,
        frame,
      );
    } else {
      clearPendingAuditEvents(candidateEnv);
    }
    throw error;
  }
};

const applyRuntimeFrameCandidate = async (
  env: RuntimeReplica,
  state: RuntimeLifecycleState,
  candidate: RuntimeFrameCandidate,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  deps: RuntimeProcessDeps,
): Promise<Awaited<ReturnType<typeof applyPreparedRuntimeFrame>>> => {
  const prepared = await prepareRuntimeFrameInput(
    env,
    state,
    candidate.runtimeInput,
    candidate.mempool,
    candidate.mempoolQueuedAt,
    frame,
    profile,
  );
  candidate.state.runtimeFramePhase = 'candidate.mutate';
  beginRuntimeFrameMutation(candidate, frame, deps);
  candidate.state.runtimeFramePhase = 'apply';
  return applyPreparedRuntimeFrame(
    env,
    candidate.runtimeInput,
    prepared.hasInput,
    prepared.jEventPrioritized,
    candidate.quietRuntimeLogs,
    frame,
    profile,
    { applyRuntimeInput: deps.applyRuntimeInput },
  );
};

const planAppliedRuntimeOutputs = (
  env: RuntimeReplica,
  applied: Awaited<ReturnType<typeof applyPreparedRuntimeFrame>>,
  profile: RuntimeProcessProfile,
  quietRuntimeLogs: boolean,
  deps: RuntimeProcessDeps,
) => {
  const routing = deps.getRuntimeOutputRoutingDeps();
  const outputPlan = planRuntimeFrameOutputs(
    env,
    applied.entityOutbox,
    routing,
    profile,
    quietRuntimeLogs,
  );
  profile.metrics.jOutputs = applied.jOutbox.length;
  return { routing, outputPlan };
};

const buildRuntimePostCommitInput = (
  applied: Awaited<ReturnType<typeof applyPreparedRuntimeFrame>>,
  planned: ReturnType<typeof planAppliedRuntimeOutputs>,
  frameAdvanced: boolean,
  started: RuntimeFrameStart,
) => ({
  appliedInput: applied.appliedInput,
  changedEntityIds: applied.changedEntityIds,
  jOutbox: applied.jOutbox,
  queuedJSubmitRetries: applied.queuedJSubmitRetries,
  outputPlan: planned.outputPlan,
  routing: planned.routing,
  ...(frameAdvanced && started.frameStartedAt !== undefined
    ? { frameStartedAt: started.frameStartedAt }
    : {}),
});

const applyAndCommitRuntimeFrame = async (
  liveEnv: RuntimeReplica,
  processState: RuntimeLifecycleState,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  started: RuntimeFrameStart,
  deps: RuntimeProcessDeps,
): Promise<{
  env: RuntimeReplica;
  staleWriterStopped: boolean;
  rejectedIngress: readonly RejectedEntityIngressEvidence[];
}> => {
  ensureRuntimeInfrastructure(liveEnv).runtimeFramePhase = 'candidate.open';
  const candidate = openRuntimeFrameCandidate(
    liveEnv,
    processState,
    frame,
    profile,
  );
  let env = candidate.env;
  let state = candidate.state;
  frame.restoreUndurableInput = async (
    error: unknown,
    options: { discardMalformedRemoteInput?: boolean; requeue?: boolean } = {},
  ): Promise<Error> => {
    const rollback = await restoreUndurableRuntimeInput({
      frame,
      liveEnv,
      attemptedEnv: env,
      runtimeInput: candidate.runtimeInput,
      mempoolQueuedAt: candidate.mempoolQueuedAt,
      frameTimestampBeforeTick: started.frameTimestampBeforeTick,
      discardMalformedRemoteInput: (input, cause) =>
        discardRejectedEntityInput(liveEnv, input, cause),
      discardedError: cause => new RuntimeInputDiscardedError(cause),
    }, error, options);
    env = rollback.env;
    state = rollback.state;
    return rollback.error;
  };
  candidate.state.runtimeFramePhase = 'candidate.validate';
  deps.applyRuntimeInput.validate(candidate.env, candidate.runtimeInput, { frameLimits: false });
  candidate.state.runtimeFramePhase = 'candidate.prepare';
  const applied = await applyRuntimeFrameCandidate(env, state, candidate, frame, profile, deps);
  candidate.state.runtimeFramePhase = 'outputs.plan';
  const planned = planAppliedRuntimeOutputs(
    env,
    applied,
    profile,
    candidate.quietRuntimeLogs,
    deps,
  );
  candidate.state.runtimeFramePhase = 'commit.prepare';
  const frameAdvanced = prepareRuntimeFrameCommit(
    env,
    liveEnv,
    started.frameHeightBeforeTick,
    applied.appliedInput,
    frame,
    profile,
  );
  candidate.state.runtimeFramePhase = 'commit.storage';
  const commit = await commitRuntimeFrame(env, liveEnv, frame, profile, {
    frameAdvanced,
    frameHeightBeforeTick: started.frameHeightBeforeTick,
    frameTimestampBeforeTick: started.frameTimestampBeforeTick,
    appliedInput: applied.appliedInput,
    quietLogs: candidate.quietRuntimeLogs,
  }, deps);
  if (commit.staleWriterStopped) {
    return { ...commit, rejectedIngress: applied.rejectedIngress };
  }

  candidate.state.runtimeFramePhase = 'effects.post-commit';
  await runCommittedRuntimeEffects(
    commit.env,
    buildRuntimePostCommitInput(applied, planned, frameAdvanced, started),
    profile,
    { reconcileRuntimeInfraEffects: deps.recovery.reconcileCommittedRuntimeInfraEffects },
  );
  return {
    env: commit.env,
    staleWriterStopped: false,
    rejectedIngress: applied.rejectedIngress,
  };
};

export const createRuntimeProcessor = (deps: RuntimeProcessDeps) => (
  env: RuntimeReplica,
  inputs?: EntityInput[],
): Promise<RuntimeReplica> => {
  const runtimeScope = String(env.runtimeId ?? env.dbNamespace ?? 'unknown').trim().toLowerCase();
  return runWithOpScopes(
    ['frame', `runtime:${runtimeScope || 'unknown'}`],
    () => processRuntimeFrameOnce(deps, env, inputs),
  );
};

const processRuntimeFrameOnce = async (
  deps: RuntimeProcessDeps,
  env: RuntimeReplica,
  inputs: EntityInput[] | undefined,
): Promise<RuntimeReplica> => {
  const liveEnv = env;
  ensureRuntimeConfig(env);
  const processState = ensureRuntimeInfrastructure(env);
  processState.runtimeFramePhase = 'writer.wait';
  assertRuntimeWriterAcceptingIngress(processState);
  if (inputs?.length) {
    const ingressTimestamp = env.scenarioMode ? (env.state.timestamp ?? 0) : getWallClockMs();
    enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  }
  const releaseProcessLock = await acquireRuntimeFrameWriter(processState);
  processState.runtimeFramePhase = 'frame.start';
  const profile = createRuntimeProcessProfile(liveEnv, deps.loop.getRuntimeWorkReason(env));
  const frame = createFrameExecutionState();
  try {
    await flushCommittedNetworkOutputs(env, deps.getRuntimeOutputRoutingDeps());
    const started = await startRuntimeFrame(
      env,
      profile,
      { collectIngress: (target, processProfile) => collectRuntimeIngress(target, processProfile, deps) },
    );
    if (!started.ready) return env;
    const committed = await applyAndCommitRuntimeFrame(
      liveEnv,
      processState,
      frame,
      profile,
      started,
      deps,
    );
    env = committed.env;
    if (committed.staleWriterStopped) return env;
    profile.outcome = 'completed';
    applyRejectedIngressPolicy(committed.rejectedIngress);
    return env;
  } catch (error) {
    const failure = await handleRuntimeFrameFailure(error, liveEnv, frame, {
      isStorageError: candidate => candidate instanceof deps.storage.RuntimeFrameStorageError,
    });
    env = failure.env;
    if (!failure.inputDropped) throw failure.error;
    profile.outcome = 'input-discarded';
    return liveEnv;
  } finally {
    processState.runtimeFramePhase = null;
    finishRuntimeFrame(env, liveEnv, processState, profile, releaseProcessLock);
  }
};
