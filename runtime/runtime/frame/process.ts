import { TIMING } from '../../config/constants';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { recordRuntimeHistoryTraceForTesting } from '../observability/history-retention';
import { createStructuredLogger } from '../../infra/logger';
import type { createRuntimeLoopApi } from '../loop/loop.ts';
import { materializePendingJurisdictionImportResults } from '../jurisdiction/jurisdiction-import';
import { requireRuntimeMempool } from '../input-pipeline/input-queue';
import { haltRuntimeRequiresOperator } from '../lifecycle';
import { ensureRuntimeInfrastructure } from '../infrastructure/runtime-infrastructure';
import type { createRuntimeRecoveryApi } from '../../storage/recovery/restore';
import type { createRuntimeStorageApi } from '../../storage/runtime-storage';
import { notifyRuntimeSyncAfterCommit } from '../../storage/runtime-storage';
import type { EntityInput } from '../../entity/types';
import type { RuntimeInput, RuntimeReplica } from '../types';
import { getWallClockMs } from '../../infra/time';
import { clearPendingAuditEvents, flushPendingAuditEvents } from '../observability/env-events';
import { acquireRuntimeFrameWriter, assertRuntimeWriterAcceptingIngress } from './lifecycle/writer-lock';
import { createFrameExecutionState, type FrameExecutionState } from './input/execution-state';
import {
  createRuntimeFrameTransaction,
  previewPublishedRuntimeInput,
  publishRuntimeFrameTransaction,
} from './transaction';
import { createRuntimeProcessProfile, type RuntimeProcessProfile } from './process-profile';
import { restoreUndurableRuntimeInput } from './input/recovery';
import { startRuntimeFrame } from './lifecycle/start';
import { prepareRuntimeFrameInput } from './lifecycle/prepare';
import { applyPreparedRuntimeFrame } from './apply';
import { planRuntimeFrameOutputs } from './plan';
import { prepareRuntimeFrameCommit } from './snapshot';
import { handleRuntimeFrameStorageFailure } from './lifecycle/storage-failure';
import { runCommittedRuntimeEffects } from './lifecycle/post-commit';
import { finishRuntimeFrame, handleRuntimeFrameFailure } from './lifecycle/finish';
import type { RuntimeInputReducer } from './input/reducer';
import { getLiveJAdapterEntries } from '../jurisdiction/live-jadapters';

const runtimeLog = createStructuredLogger('runtime');

type RuntimeLoopProcessDeps = Pick<
  ReturnType<typeof createRuntimeLoopApi>,
  | 'ensureRuntimeConfig'
  | 'enqueueRuntimeInputs'
  | 'enqueueRuntimeContinuation'
  | 'collectAccountMempoolWakeInputs'
  | 'collectEntityMempoolWakeInputs'
  | 'generateHookPings'
  | 'hasRuntimeWork'
  | 'isRuntimeFrameReady'
  | 'prioritizeJEventFrame'
  | 'applyEntityInputFrameCap'
  | 'applyEntityTxFrameCap'
  | 'discardRejectedEntityInput'
  | 'RuntimeInputDiscardedError'
  | 'getRuntimeWorkReason'
>;

type RuntimeRecoveryProcessDeps = Pick<
  ReturnType<typeof createRuntimeRecoveryApi>,
  | 'hasPendingLocalReliableOutput'
  | 'applyDeterministicRuntimeOutputPlan'
  | 'reconcileCommittedRuntimeInfraEffects'
>;

type RuntimeStorageProcessDeps = Pick<
  ReturnType<typeof createRuntimeStorageApi>,
  'saveEnvToDB' | 'RuntimeFrameStorageError'
>;

export type RuntimeProcessDeps = {
  loop: RuntimeLoopProcessDeps;
  recovery: RuntimeRecoveryProcessDeps;
  storage: RuntimeStorageProcessDeps;
  attachEventEmitters(env: RuntimeReplica): void;
  applyRuntimeInput: RuntimeInputReducer;
  setApplyAllowed(env: RuntimeReplica, allowed: boolean): void;
  getRuntimeOutputRoutingDeps(): ReturnType<
    ReturnType<typeof createRuntimeLoopApi>['getRuntimeOutputRoutingDeps']
  >;
  notifyEnvChange(env: RuntimeReplica): void;
  notifyRuntimeFrameCommitted(env: RuntimeReplica, input: RuntimeInput): void;
};

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;
type RuntimeIngressDecision =
  | { ready: true }
  | { ready: false; outcome: 'no-work' | 'not-ready' };

const collectRuntimeIngress = async (
  env: RuntimeReplica,
  inputs: EntityInput[] | undefined,
  state: RuntimeLifecycleState,
  runtimeDelay: number,
  profile: RuntimeProcessProfile,
  deps: RuntimeProcessDeps,
): Promise<RuntimeIngressDecision> => {
  const { loop } = deps;
  const ingressTimestamp = env.scenarioMode ? (env.state.timestamp ?? 0) : getWallClockMs();
  if (inputs?.length) loop.enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  if (env.pendingOutputs?.length) {
    loop.enqueueRuntimeContinuation(env, env.pendingOutputs, undefined, undefined, ingressTimestamp);
    env.pendingOutputs = [];
  }
  if (env.networkInbox?.length) {
    loop.enqueueRuntimeContinuation(env, env.networkInbox, undefined, undefined, ingressTimestamp);
    env.networkInbox = [];
  }
  profile.mark('ingressQueues');

  await materializePendingJurisdictionImportResults(env, runtimeTx => {
    loop.enqueueRuntimeContinuation(
      env,
      undefined,
      [runtimeTx],
      undefined,
      env.scenarioMode ? env.state.timestamp : getWallClockMs(),
    );
  });
  profile.mark('jurisdictionImports');

  state.pendingProfileCertificationEntityIds = new Set();
  profile.mark('profileCertification');
  profile.mark('enqueue');

  if (!loop.hasRuntimeWork(env)) return { ready: false, outcome: 'no-work' };
  const gateTimestamp = env.scenarioMode ? (env.state.timestamp ?? 0) : getWallClockMs();
  if (!loop.isRuntimeFrameReady(env, gateTimestamp, runtimeDelay)) {
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
  deps: RuntimeProcessDeps,
): RuntimeInput => {
  const automaticInputs = [
    ...deps.loop.collectEntityMempoolWakeInputs(env),
    ...deps.loop.collectAccountMempoolWakeInputs(env),
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
  return {
    runtimeTxs: [...mempool.runtimeTxs],
    entityInputs: [...mempool.entityInputs, ...dedupedAutomaticInputs],
    ...(mempool.jInputs?.length ? { jInputs: [...mempool.jInputs] } : {}),
    ...(mempool.reliableReceipts?.length
      ? { reliableReceipts: [...mempool.reliableReceipts] }
      : {}),
  };
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
  deps: RuntimeProcessDeps,
): RuntimeFrameCandidate => {
  const quietRuntimeLogs = liveEnv.quietRuntimeLogs === true;
  const frameTimestamp = resolveRuntimeFrameTimestamp(
    liveEnv,
    requireRuntimeMempool(liveEnv).queuedAt,
  );
  // Due scheduler work belongs to the frame being detached, not to arrivals
  // that may race in while this single writer awaits storage or signatures.
  // Compute against the candidate timestamp without publishing that timestamp:
  // public readers must continue to observe the committed frame until WAL
  // accepts this candidate.
  deps.loop.generateHookPings(liveEnv, frameTimestamp, frameTimestamp);
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
  const runtimeInput = buildRuntimeFrameInput(env, mempool, deps);
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
  deps: RuntimeProcessDeps,
): RuntimeFrameCommitResult => {
  if (!frame.transaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_COMMIT');
  frame.commitDisposition = 'committed';
  frame.reliableReceiptStateDurable = true;
  profile.mark('save');
  flushPendingAuditEvents(candidateEnv);
  candidateEnv.frameLogs = [];
  const env = publishRuntimeFrameTransaction(frame.transaction);
  const state = ensureRuntimeInfrastructure(env);
  if (frame.pendingTraceSnapshot) {
    recordRuntimeHistoryTraceForTesting(env, frame.pendingTraceSnapshot);
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
    deps.notifyRuntimeFrameCommitted(env, appliedInput);
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
    // Candidate time is needed while evaluating due work, but timestamp is
    // canonical Runtime State. If no frame advanced there is no WAL record,
    // so publishing the candidate timestamp would create state that vanishes
    // after restart. Restore the committed clock before releasing readers.
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
      previewPublishedRuntimeInput(frame.transaction),
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
      deps,
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
    {
      prioritizeJEventFrame: deps.loop.prioritizeJEventFrame,
      applyEntityTxFrameCap: deps.loop.applyEntityTxFrameCap,
      applyEntityInputFrameCap: deps.loop.applyEntityInputFrameCap,
    },
  );
  return applyPreparedRuntimeFrame(
    env,
    candidate.runtimeInput,
    prepared.hasInput,
    prepared.jEventPrioritized,
    candidate.quietRuntimeLogs,
    deps.recovery.hasPendingLocalReliableOutput(env),
    frame,
    profile,
    {
      applyRuntimeInput: deps.applyRuntimeInput,
      setApplyAllowed: deps.setApplyAllowed,
    },
  );
};

const applyAndCommitRuntimeFrame = async (
  liveEnv: RuntimeReplica,
  processState: RuntimeLifecycleState,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  started: { frameHeightBeforeTick: number; frameTimestampBeforeTick: number },
  deps: RuntimeProcessDeps,
): Promise<{ env: RuntimeReplica; staleWriterStopped: boolean }> => {
  const candidate = openRuntimeFrameCandidate(
    liveEnv,
    processState,
    frame,
    profile,
    deps,
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
      quietRuntimeLogs: candidate.quietRuntimeLogs,
      discardMalformedRemoteInput: (input, cause, quiet) =>
        deps.loop.discardRejectedEntityInput(liveEnv, input, cause, quiet),
      discardedError: cause => new deps.loop.RuntimeInputDiscardedError(cause),
    }, error, options);
    env = rollback.env;
    state = rollback.state;
    return rollback.error;
  };
  beginRuntimeFrameMutation(candidate, frame, deps);
  const applied = await applyRuntimeFrameCandidate(env, state, candidate, frame, profile, deps);
  const routing = deps.getRuntimeOutputRoutingDeps();
  const outputPlan = planRuntimeFrameOutputs(
    env,
    applied.entityOutbox,
    routing,
    profile,
    candidate.quietRuntimeLogs,
    {
      applyOutputPlan: deps.recovery.applyDeterministicRuntimeOutputPlan,
      generateHookPings: deps.loop.generateHookPings,
    },
  );
  profile.metrics.jOutputs = applied.jOutbox.length;
  const frameAdvanced = prepareRuntimeFrameCommit(
    env,
    liveEnv,
    started.frameHeightBeforeTick,
    applied.appliedInput,
    frame,
    profile,
  );
  const commit = await commitRuntimeFrame(env, liveEnv, frame, profile, {
    frameAdvanced,
    frameHeightBeforeTick: started.frameHeightBeforeTick,
    frameTimestampBeforeTick: started.frameTimestampBeforeTick,
    appliedInput: applied.appliedInput,
    quietLogs: candidate.quietRuntimeLogs,
  }, deps);
  if (commit.staleWriterStopped) return commit;

  await runCommittedRuntimeEffects(
    commit.env,
    frame,
    {
      appliedInput: applied.appliedInput,
      changedEntityIds: applied.changedEntityIds,
      jOutbox: applied.jOutbox,
      queuedJSubmitRetries: applied.queuedJSubmitRetries,
      outputPlan,
      routing,
    },
    profile,
    {
      enqueueRuntimeInputs: deps.loop.enqueueRuntimeContinuation,
      reconcileRuntimeInfraEffects: deps.recovery.reconcileCommittedRuntimeInfraEffects,
      notifyEnvChange: deps.notifyEnvChange,
    },
  );
  return { env: commit.env, staleWriterStopped: false };
};

export const createRuntimeProcessor = (deps: RuntimeProcessDeps) => async (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeDelay = 0,
): Promise<RuntimeReplica> => {
  const liveEnv = env;
  deps.loop.ensureRuntimeConfig(env);
  const processState = ensureRuntimeInfrastructure(env);
  assertRuntimeWriterAcceptingIngress(processState);
  if (inputs?.length) {
    const ingressTimestamp = env.scenarioMode ? (env.state.timestamp ?? 0) : getWallClockMs();
    deps.loop.enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  }
  const releaseProcessLock = await acquireRuntimeFrameWriter(processState);
  const profile = createRuntimeProcessProfile(liveEnv, deps.loop.getRuntimeWorkReason(env));
  const frame = createFrameExecutionState();
  try {
    const started = await startRuntimeFrame(
      env,
      undefined,
      processState,
      runtimeDelay,
      profile,
      {
        attachEventEmitters: deps.attachEventEmitters,
        collectIngress: (target, queued, state, delay, processProfile) =>
          collectRuntimeIngress(target, queued, state, delay, processProfile, deps),
      },
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
    return env;
  } catch (error) {
    const failure = await handleRuntimeFrameFailure(error, liveEnv, frame, {
      isStorageError: candidate => candidate instanceof deps.storage.RuntimeFrameStorageError,
      isDiscardedInputError: candidate => candidate instanceof deps.loop.RuntimeInputDiscardedError,
    });
    env = failure.env;
    if (!failure.inputDropped) throw failure.error;
    profile.outcome = 'input-discarded';
    return liveEnv;
  } finally {
    finishRuntimeFrame(env, liveEnv, processState, frame, profile, releaseProcessLock);
  }
};
