import { TIMING } from './constants';
import { dbRootPath, nodeProcess, runtimeIsBrowser } from './runtime/platform';

// Bump this on runtime bundle changes that must be reflected in frontend immediately.
const RUNTIME_BUILD_ID = '2026-07-18-16:00Z';
// Bump this only on breaking persistence/replay format or invariants.
export const RUNTIME_SCHEMA_VERSION = 5;
export const RUNTIME_BUILD = RUNTIME_BUILD_ID;

import { getWallClockMs } from './utils';
import { requireBoundaryInteger } from './protocol/boundary-validation';
import { recordRuntimeHistoryTraceForTesting } from './history-retention';
import { setBrowserVMJurisdiction } from './jadapter';
import { attachEventEmitters, clearPendingAuditEvents, flushPendingAuditEvents } from './runtime/env-events';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from './account/crypto';
import { markRestoredReliableOutputsDue } from './runtime/output-routing';
import { collectDueLocalProfileCertificationInputs } from './networking/local-profile-lifecycle';
import { transitionRuntimeLifecycle } from './runtime/lifecycle';
import { requireRuntimeMempool } from './runtime/input-queue';
import { ensureRuntimeState } from './runtime/runtime-state';
import { materializePendingJurisdictionImportResults } from './runtime/jurisdiction-import';
import type {
  EntityInput,
  EntityTx,
  RuntimeState,
  RuntimeInput,
} from './types';
import { createStructuredLogger } from './infra/logger';
import { createPersistenceQueries } from './persistence/queries';
import {
  createRuntimeStorageApi,
  notifyRuntimeSyncAfterCommit,
} from './persistence/runtime-storage';
import { rehydrateRestoredRuntimeInfra, type TrustedJurisdictionRpcBinding } from './runtime/infra';
import { createRuntimeLoopApi } from './runtime/loop';
import { createRuntimeRecoveryApi } from './recovery/restore';
import { createRuntimeStateApi } from './state/create';
import { loadGossipProfilesFromInfraDb } from './runtime/infra-gossip-store';
import { withStorageConsistentRead } from './storage/runtime-dbs';
import {
  createRuntimeCommandApi,
  getEntityDisplayInfoFromProfile,
  resolveEntityName,
  searchEntityNames,
} from './runtime/command-api';
import {
  cloneRuntimeFrameMempool,
  createRuntimeFrameTransaction,
  publishRuntimeFrameTransaction,
  runtimeInputHasQueuedWork,
} from './runtime/frame/transaction';
import {
  createRuntimeProcessProfile,
  type RuntimeProcessProfile,
} from './runtime/frame/process-profile';
import {
  createFrameExecutionState,
  type FrameExecutionState,
} from './runtime/frame/execution-state';
import {
  acquireRuntimeFrameWriter,
  assertRuntimeWriterAcceptingIngress,
} from './runtime/frame/writer-lock';
import { rollbackUndurableRuntimeFrame } from './runtime/frame/rollback';
import { applyPreparedRuntimeFrame } from './runtime/frame/apply';
import {
  finishRuntimeFrame,
  handleRuntimeFrameFailure,
} from './runtime/frame/finish';
import { handleRuntimeFrameStorageFailure } from './runtime/frame/storage-failure';
import { planRuntimeFrameOutputs } from './runtime/frame/plan';
import { runCommittedRuntimeEffects } from './runtime/frame/post-commit';
import { prepareRuntimeFrameInput } from './runtime/frame/prepare';
import { prepareRuntimeFrameCommit } from './runtime/frame/snapshot';
import { startRuntimeFrame } from './runtime/frame/start';
import {
  prepareAtomicCrossJAccountInputs,
} from './runtime/frame/cross-j-preflight';
import { createRuntimeInputReducer } from './runtime/frame/input-reducer';

export { prepareAtomicCrossJAccountInputs };

const runtimeLog = createStructuredLogger('runtime');

// Runtime execution state lives on RuntimeState. This module owns the canonical
// frame transition; runtime.ts is intentionally only the public entrypoint.

const runtimeLoopApi = createRuntimeLoopApi({
  notifyEnvChange: env => notifyEnvChange(env),
  processRuntime: (env, inputs, runtimeDelay) => processRuntime(env, inputs, runtimeDelay),
  waitForRuntimeProcessingIdle: (env, timeoutMs) => waitForRuntimeProcessingIdle(env, timeoutMs),
  getRuntimeProcessGlobal: () => getRuntimeProcessGlobal(),
  runtimeInputHasQueuedWork: input => runtimeInputHasQueuedWork(input),
});

const {
  registerEnvChangeCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  envRecord,
  ensureRuntimeConfig,
  getRuntimeStorageDb,
  getStorageDb,
  getInfraDb,
  getFrameDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  getCleanLogs,
  clearCleanLogs,
  copyCleanLogs,
  enqueueRuntimeInputs,
  enqueueRuntimeContinuation,
  tryOpenInfraDb,
  infraGossipDbAccess,
  trackInfraDbWrite,
  hasRuntimeWork,
  getRuntimeWorkReason,
  collectAccountMempoolWakeInputs,
  collectEntityMempoolWakeInputs,
  prioritizeJEventFrame,
  applyEntityInputFrameCap,
  applyEntityTxFrameCap,
  generateHookPings,
  isRuntimeFrameReady,
  quarantineLiveRuntimeInput,
  RuntimeInputQuarantinedError,
  startRuntimeLoop,
  waitForPromiseBeforeTimeout,
  stopRuntimeLoopAndWait,
  resumeRuntimeLoop,
  resumeRuntimeAfterPersistenceQuiesce,
  waitForRuntimeWorkDrained,
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
  getEnv,
  setRuntimeId,
  deriveRuntimeId,
  registerEntityRuntimeHint,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  MAX_RUNTIME_J_INPUT_BYTES,
  handleInboundP2PEntityInput,
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
  normalizeRuntimeEntityInput,
  validateRuntimeInputAdmission,
  getRuntimeEntityRoutingDeps,
  getRuntimeOutputRoutingDeps,
  sendEntityInput,
  startP2P,
  stopP2P,
  stopP2PAndWait,
  getP2P,
  getP2PState,
  refreshGossip,
  ensureGossipProfiles,
  clearGossip,
} = runtimeLoopApi;

const failfastAssert: (
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => asserts condition = runtimeLoopApi.failfastAssert;

export type RuntimeLoopConfig = NonNullable<Parameters<typeof startRuntimeLoop>[1]>;

export {
  registerEnvChangeCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  getRuntimeStorageDb,
  getInfraDb,
  getFrameDb,
  tryOpenStorageDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  getCleanLogs,
  clearCleanLogs,
  copyCleanLogs,
  hasRuntimeWork,
  prioritizeJEventFrame,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
  resumeRuntimeLoop,
  resumeRuntimeAfterPersistenceQuiesce,
  waitForRuntimeWorkDrained,
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
  getEnv,
  setRuntimeId,
  deriveRuntimeId,
  registerEntityRuntimeHint,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  MAX_RUNTIME_J_INPUT_BYTES,
  handleInboundP2PEntityInput,
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
  validateRuntimeInputAdmission,
  sendEntityInput,
  startP2P,
  stopP2P,
  stopP2PAndWait,
  getP2P,
  getP2PState,
  refreshGossip,
  ensureGossipProfiles,
  clearGossip,
};
export const initEnv = (seed?: string | null): RuntimeState => {
  return createEmptyEnv(seed ?? null);
};

const notifyEnvChange = (env: RuntimeState) => {
  const state = ensureRuntimeState(env);
  if (!state.envChangeCallbacks || state.envChangeCallbacks.size === 0) return;
  for (const cb of state.envChangeCallbacks) {
    try {
      cb(env);
    } catch (error) {
      runtimeLog.warn('env_change.callback_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
};

const notifyRuntimeFrameCommitted = (env: RuntimeState, runtimeInput: RuntimeInput): void => {
  const callbacks = ensureRuntimeState(env).runtimeFrameCommitCallbacks;
  if (!callbacks || callbacks.size === 0) return;
  const frame = { height: env.height, runtimeInput };
  for (const callback of callbacks) {
    try {
      callback(frame);
    } catch (error) {
      runtimeLog.warn('frame_commit.callback_failed', {
        error: error instanceof Error ? error.message : String(error),
        height: env.height,
      });
    }
  }
};

const applyRuntimeInput = createRuntimeInputReducer({
  assertApplyAllowed: env => {
    failfastAssert(
      env.scenarioMode === true || envRecord(env)[ENV_APPLY_ALLOWED_KEY] === true,
      'RUNTIME_APPLY_DIRECT_CALL',
      'applyRuntimeInput must be invoked via process()/WAL replay (non-scenario)',
      { runtimeId: env.runtimeId, height: env.height },
    );
  },
  isReplay: env => envRecord(env)[ENV_REPLAY_MODE_KEY] === true,
  normalizeEntityInput: normalizeRuntimeEntityInput,
  getRoutingDeps: getRuntimeEntityRoutingDeps,
  applyCommittedLocalReceipts: (env, commits, options) =>
    applyCommittedLocalReliableReceipts(env, commits, options),
});

// Runtime bootstrap
export type RuntimeLocalSigner = Readonly<{
  label: string;
  seed?: Uint8Array | string;
}>;

export type RuntimeCreationOptions = Readonly<{
  trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  localSigners?: readonly RuntimeLocalSigner[];
}>;

const main = async (runtimeSeedOverride?: string | null, options?: RuntimeCreationOptions): Promise<RuntimeState> => {
  const runtimeSeed = runtimeSeedOverride ?? null;
  if (options?.localSigners?.length && runtimeSeed === null) {
    throw new Error('RUNTIME_LOCAL_SIGNERS_REQUIRE_SEED');
  }
  if (runtimeSeed !== null) {
    for (const signer of options?.localSigners ?? []) {
      const label = String(signer.label || '').trim();
      if (!label) throw new Error('RUNTIME_LOCAL_SIGNER_LABEL_REQUIRED');
      const signerSeed = signer.seed ?? runtimeSeed;
      const signerId = deriveSignerAddressSync(signerSeed, label).toLowerCase();
      registerSignerKey(runtimeSeed, signerId, deriveSignerKeySync(signerSeed, label));
    }
  }
  const baseEnv = createEmptyEnv(runtimeSeed);

  let env = baseEnv;
  let restoredFromCoreDb = false;
  const restoreDisabled =
    !runtimeIsBrowser &&
    !!nodeProcess &&
    /^(1|true)$/i.test(String(nodeProcess.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? ''));
  if (!restoreDisabled) {
    const loaded = await loadEnvFromDB(baseEnv.runtimeId, baseEnv.runtimeSeed, {
      ...(options?.trustedJurisdictionRpcBindings
        ? { trustedJurisdictionRpcBindings: options.trustedJurisdictionRpcBindings }
        : {}),
    });
    if (loaded) {
      env = loaded;
      restoredFromCoreDb = true;
      runtimeLog.info('main.restored', { runtime: String(env.runtimeId || '').slice(0, 12), height: env.height });
    }
  }

  attachEventEmitters(env);
  if (!restoredFromCoreDb) {
    try {
      await loadGossipProfilesFromInfraDb(env, infraGossipDbAccess);
    } catch (error) {
      runtimeLog.warn('main.infra_gossip_restore_skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!env.runtimeId && env.runtimeSeed) {
    try {
      env.runtimeId = deriveSignerAddressSync(env.runtimeSeed, '1');
      runtimeLog.debug('main.runtime_id_derived', { runtime: env.runtimeId.slice(0, 12) });
    } catch (error) {
      runtimeLog.warn('main.runtime_id_derive_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (runtimeIsBrowser) {
    runtimeLog.info('main.loop_start_browser');
    startRuntimeLoop(env);
  }

  return env;
};

// === TIME MACHINE API ===
const getHistory = (env: RuntimeState) => env.history || [];
const getSnapshot = (env: RuntimeState, index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = (env: RuntimeState) => (env.history || []).length - 1;

// Clear database for a specific runtime and return a fresh env
/**
 * Queue an entity transaction for processing (helper for UI components)
 * Wraps applyRuntimeInput with a single entity tx
 */
export const queueEntityInput = async (
  env: RuntimeState,
  entityId: string,
  signerId: string,
  txData: { type: EntityTx['type'] } & Record<string, unknown>,
): Promise<void> => {
  enqueueRuntimeInputs(
    env,
    [
      {
        entityId,
        signerId,
        entityTxs: [{ type: txData.type, data: txData } as EntityTx],
      },
    ],
    undefined,
    undefined,
    env.timestamp,
  );
};

export {
  applyRuntimeInput,
  getCurrentHistoryIndex,
  getEntityDisplayInfoFromProfile,
  getHistory,
  getSnapshot,
  main,
  resolveEntityName,
  searchEntityNames,
  setBrowserVMJurisdiction,
};

// Runtime is a pure library - no auto-execution side effects.
// Browser and server entrypoints call xln.main() explicitly.

const runtimeStateApi = createRuntimeStateApi({
  ensureRuntimeConfig,
  infraGossipDbAccess,
  trackInfraDbWrite,
});

export const prewarmRuntimeSignerCache = runtimeStateApi.prewarmRuntimeSignerCache;
export const createEmptyEnv = runtimeStateApi.createEmptyEnv;
export { cloneRuntimeFrameMempool };

const runtimeRecoveryApi = createRuntimeRecoveryApi({
  ensureRuntimeConfig,
  createEmptyEnv,
  getStorageDb,
  getFrameDb,
  tryOpenStorageDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  enqueueRuntimeContinuation,
  infraGossipDbAccess,
  generateHookPings,
  startJurisdictionWatchers,
  getRuntimeOutputRoutingDeps,
  applyRuntimeInput,
});

export const restoreEnvFromCheckpointSnapshot = runtimeRecoveryApi.restoreEnvFromCheckpointSnapshot;
export const restoreEnvFromRecoveryBundles = runtimeRecoveryApi.restoreEnvFromRecoveryBundles;
export const persistRestoredEnvToDB = runtimeRecoveryApi.persistRestoredEnvToDB;
const replayRecoveryFrameJournals = runtimeRecoveryApi.replayRecoveryFrameJournals;
const assertPersistedContractConfigReady = runtimeRecoveryApi.assertPersistedContractConfigReady;
const registerCommittedSingleSignerWallets = runtimeRecoveryApi.registerCommittedSingleSignerWallets;
const reconcileCommittedRuntimeInfraEffects = runtimeRecoveryApi.reconcileCommittedRuntimeInfraEffects;
const hasPendingLocalReliableOutput = runtimeRecoveryApi.hasPendingLocalReliableOutput;
const applyDeterministicRuntimeOutputPlan = runtimeRecoveryApi.applyDeterministicRuntimeOutputPlan;
const applyCommittedLocalReliableReceipts = runtimeRecoveryApi.applyCommittedLocalReliableReceipts;

type RuntimeLifecycleState = NonNullable<RuntimeState['runtimeState']>;

type RuntimeIngressDecision =
  | { ready: true }
  | { ready: false; outcome: 'no-work' | 'not-ready' };

const collectRuntimeIngress = async (
  env: RuntimeState,
  inputs: EntityInput[] | undefined,
  state: RuntimeLifecycleState,
  runtimeDelay: number,
  profile: RuntimeProcessProfile,
): Promise<RuntimeIngressDecision> => {
  const ingressTimestamp = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
  if (inputs?.length) enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
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
      env.scenarioMode ? env.timestamp : getWallClockMs(),
    );
  });
  profile.mark('jurisdictionImports');

  const profileInputs = collectDueLocalProfileCertificationInputs(
    env,
    state.pendingProfileCertificationEntityIds,
  );
  // Undefined triggers the first complete scan. Later frames consume only the
  // Entity ids dirtied by the previous committed frame.
  state.pendingProfileCertificationEntityIds = new Set();
  if (profileInputs.length > 0) {
    const profileTimestamp = requireRuntimeMempool(env).queuedAt ?? ingressTimestamp;
    enqueueRuntimeContinuation(env, profileInputs, undefined, undefined, profileTimestamp);
  }
  profile.mark('profileCertification');
  profile.mark('enqueue');

  if (!hasRuntimeWork(env)) return { ready: false, outcome: 'no-work' };
  const gateTimestamp = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
  if (!isRuntimeFrameReady(env, gateTimestamp, runtimeDelay)) {
    return { ready: false, outcome: 'not-ready' };
  }
  profile.mark('frameReady');
  return { ready: true };
};

type RuntimeFrameCandidate = {
  transaction: ReturnType<typeof createRuntimeFrameTransaction>;
  env: RuntimeState;
  state: RuntimeLifecycleState;
  mempool: RuntimeInput;
  runtimeInput: RuntimeInput;
  mempoolQueuedAt: number | undefined;
  quietRuntimeLogs: boolean;
};

const openRuntimeFrameCandidate = (
  liveEnv: RuntimeState,
  liveState: RuntimeLifecycleState,
): RuntimeFrameCandidate => {
  const mempoolQueuedAt = requireRuntimeMempool(liveEnv).queuedAt;
  const quietRuntimeLogs = liveEnv.quietRuntimeLogs === true;
  const transaction = createRuntimeFrameTransaction(liveEnv);
  const env = transaction.workingEnv;
  const state = ensureRuntimeState(env);
  const mempool = requireRuntimeMempool(env);
  for (const replica of env.jReplicas.values()) {
    replica.jadapter?.setQuietLogs?.(quietRuntimeLogs);
  }

  if (env.scenarioMode) {
    env.timestamp = requireBoundaryInteger(
      requireBoundaryInteger(env.timestamp, 'RUNTIME_TIMESTAMP_INVALID') + 100,
      'RUNTIME_TIMESTAMP_OVERFLOW',
    );
  } else {
    const liveNow = getWallClockMs();
    const previousTimestamp = requireBoundaryInteger(env.timestamp, 'RUNTIME_TIMESTAMP_INVALID');
    if (previousTimestamp > liveNow + TIMING.TIMESTAMP_DRIFT_MS) {
      throw new Error(`RUNTIME_CLOCK_AHEAD: env.timestamp=${previousTimestamp} wall=${liveNow}`);
    }
    const queuedTimestamp = requireBoundaryInteger(
      mempoolQueuedAt ?? liveNow,
      'RUNTIME_MEMPOOL_TIMESTAMP_INVALID',
    );
    env.timestamp = Math.max(
      previousTimestamp,
      Math.min(queuedTimestamp, liveNow + TIMING.TIMESTAMP_DRIFT_MS),
    );
  }
  for (const replica of env.jReplicas.values()) {
    replica.jadapter?.setBlockTimestamp(env.timestamp);
  }

  generateHookPings(env);
  const automaticInputs = [
    ...collectEntityMempoolWakeInputs(env),
    ...collectAccountMempoolWakeInputs(env),
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
    ...(mempool.reliableReceipts?.length
      ? { reliableReceipts: [...mempool.reliableReceipts] }
      : {}),
  };
  liveState.inFlightEntityInputs = runtimeInput.entityInputs.length;
  return { transaction, env, state, mempool, runtimeInput, mempoolQueuedAt, quietRuntimeLogs };
};

type RuntimeFrameCommitResult = {
  env: RuntimeState;
  state: RuntimeLifecycleState;
  staleWriterStopped: boolean;
};

const commitRuntimeFrame = async (
  candidateEnv: RuntimeState,
  liveEnv: RuntimeState,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  options: {
    frameAdvanced: boolean;
    frameHeightBeforeTick: number;
    appliedInput: RuntimeInput | undefined;
    quietLogs: boolean;
  },
): Promise<RuntimeFrameCommitResult> => {
  if (!frame.transaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_COMMIT');
  if (!options.frameAdvanced) {
    frame.commitDisposition = 'committed';
    clearPendingAuditEvents(candidateEnv);
    const env = publishRuntimeFrameTransaction(frame.transaction);
    return { env, state: ensureRuntimeState(env), staleWriterStopped: false };
  }

  if (!options.quietLogs) runtimeLog.debug('storage.save.start', { height: candidateEnv.height });
  try {
    const outcome = await saveEnvToDB(
      candidateEnv,
      options.appliedInput,
      candidateEnv.pendingNetworkOutputs,
    );
    profile.metrics.storageMs = outcome.persistencePerfMs;
    if (outcome.staleWriterStopped) {
      frame.rollbackHandled = true;
      if (!frame.rollbackUndurable) throw new Error('RUNTIME_FRAME_ROLLBACK_MISSING');
      const rollbackError = await frame.rollbackUndurable(new Error('STALE_RUNTIME_WRITER_STOPPED'), {
        quarantine: false,
        requeue: false,
      });
      const state = ensureRuntimeState(liveEnv);
      transitionRuntimeLifecycle(state, 'halted');
      state.fatalDebugPayload = {
        message:
          `STALE_RUNTIME_WRITER_STOPPED: frame=${options.frameHeightBeforeTick + 1} ` +
          `runtime=${String(liveEnv.runtimeId || '').slice(0, 12)}`,
        height: Math.max(0, liveEnv.height),
        timestamp: Math.max(0, liveEnv.timestamp),
      };
      state.stopLoop?.();
      profile.outcome = 'stale-writer-stopped';
      if (rollbackError.message !== 'STALE_RUNTIME_WRITER_STOPPED') throw rollbackError;
      return { env: liveEnv, state, staleWriterStopped: true };
    }

    frame.commitDisposition = 'committed';
    frame.reliableReceiptStateDurable = true;
    profile.mark('save');
    flushPendingAuditEvents(candidateEnv);
    candidateEnv.frameLogs = [];
    const env = publishRuntimeFrameTransaction(frame.transaction);
    const state = ensureRuntimeState(env);
    if (frame.pendingTraceSnapshot) {
      recordRuntimeHistoryTraceForTesting(env, frame.pendingTraceSnapshot);
    }
    if (!options.quietLogs) runtimeLog.debug('storage.save.done', { height: env.height });
    profile.mark('publish');
    if (options.appliedInput) {
      const notificationError = notifyRuntimeSyncAfterCommit(env);
      if (notificationError) {
        runtimeLog.error('runtime_sync.notification_failed', {
          error: notificationError.message,
          height: env.height,
        });
      }
      notifyRuntimeFrameCommitted(env, options.appliedInput);
    }
    return { env, state, staleWriterStopped: false };
  } catch (error) {
    if (error instanceof RuntimeFrameStorageError) {
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

// === CONSENSUS PROCESSING ===
// ONE TICK = ONE ITERATION. No cascade. E→E communication always requires new tick.

export const processRuntime = async (env: RuntimeState, inputs?: EntityInput[], runtimeDelay = 0) => {
  const liveEnv = env;
  // Direct callers and the background loop must hash the same effective local
  // configuration. Recovery replays normalize these defaults before applying
  // a journal frame, so the live writer must do so before its own frame too.
  ensureRuntimeConfig(env);
  const processState = ensureRuntimeState(env);
  // Admission belongs to the one live Runtime mempool, not to the writer that
  // happens to process it. Enqueue synchronously before waiting so inputs that
  // arrive during frame H remain visible and are picked up by H+1. The
  // lifecycle assertion prevents a halted Runtime from accumulating work.
  assertRuntimeWriterAcceptingIngress(processState);
  if (inputs?.length) {
    const ingressTimestamp = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  }
  const releaseProcessLock = await acquireRuntimeFrameWriter(processState);

  const processProfile = createRuntimeProcessProfile(liveEnv, getRuntimeWorkReason(env));
  const frame = createFrameExecutionState();
  try {
    const started = await startRuntimeFrame(
      env,
      undefined,
      processState,
      runtimeDelay,
      processProfile,
      {
        attachEventEmitters,
        collectIngress: collectRuntimeIngress,
      },
    );
    if (!started.ready) return env;
    const { frameHeightBeforeTick, frameTimestampBeforeTick } = started;

    const candidate = openRuntimeFrameCandidate(env, processState);
    frame.transaction = candidate.transaction;
    env = candidate.env;
    let state = candidate.state;
    const mempool = candidate.mempool;
    const runtimeInput = candidate.runtimeInput;
    const mempoolQueuedAt = candidate.mempoolQueuedAt;
    const quietRuntimeLogs = candidate.quietRuntimeLogs;
    frame.rollbackUndurable = async (
      error: unknown,
      options: { quarantine?: boolean; requeue?: boolean } = {},
    ): Promise<Error> => {
      const rollback = await rollbackUndurableRuntimeFrame({
        frame,
        liveEnv,
        attemptedEnv: env,
        runtimeInput,
        mempoolQueuedAt,
        frameTimestampBeforeTick,
        quietRuntimeLogs,
        quarantine: (input, cause, quiet) =>
          quarantineLiveRuntimeInput(liveEnv, input, cause, quiet),
        quarantinedError: cause => new RuntimeInputQuarantinedError(cause),
      }, error, options);
      env = rollback.env;
      state = rollback.state;
      return rollback.error;
    };
    const prepared = await prepareRuntimeFrameInput(
      env,
      state,
      runtimeInput,
      mempool,
      mempoolQueuedAt,
      frame,
      processProfile,
      {
        prioritizeJEventFrame,
        applyEntityTxFrameCap,
        applyEntityInputFrameCap,
      },
    );
    const {
      hasInput: hasRuntimeInput,
      jEventPrioritized: jEventFramePrioritized,
    } = prepared;
    const applied = await applyPreparedRuntimeFrame(
      env,
      runtimeInput,
      hasRuntimeInput,
      jEventFramePrioritized,
      quietRuntimeLogs,
      hasPendingLocalReliableOutput(env),
      frame,
      processProfile,
      {
        applyRuntimeInput,
        setApplyAllowed: (targetEnv, allowed) => {
          envRecord(targetEnv)[ENV_APPLY_ALLOWED_KEY] = allowed;
        },
      },
    );
    const {
      appliedInput: appliedRuntimeInputForPersistence,
      entityOutbox,
      jOutbox,
      queuedJSubmitRetries,
      changedEntityIds,
    } = applied;
    const outputRoutingDeps = getRuntimeOutputRoutingDeps();
    const outputPlan = planRuntimeFrameOutputs(
      env,
      entityOutbox,
      outputRoutingDeps,
      processProfile,
      quietRuntimeLogs,
      {
        applyOutputPlan: applyDeterministicRuntimeOutputPlan,
        generateHookPings,
      },
    );
    processProfile.metrics.jOutputs = jOutbox.length;
    const frameAdvanced = prepareRuntimeFrameCommit(
      env,
      liveEnv,
      frameHeightBeforeTick,
      appliedRuntimeInputForPersistence,
      frame,
      processProfile,
    );

    // WAL is the only commit point. The helper returns only after install, or
    // after making an ambiguous/stale outcome terminal.
    const commit = await commitRuntimeFrame(env, liveEnv, frame, processProfile, {
      frameAdvanced,
      frameHeightBeforeTick,
      appliedInput: appliedRuntimeInputForPersistence,
      quietLogs: quietRuntimeLogs,
    });
    env = commit.env;
    state = commit.state;
    if (commit.staleWriterStopped) return env;

    await runCommittedRuntimeEffects(
      env,
      frame,
      {
        appliedInput: appliedRuntimeInputForPersistence,
        changedEntityIds,
        jOutbox,
        queuedJSubmitRetries,
        outputPlan,
        routing: outputRoutingDeps,
      },
      processProfile,
      {
        enqueueRuntimeInputs: enqueueRuntimeContinuation,
        reconcileRuntimeInfraEffects: reconcileCommittedRuntimeInfraEffects,
        notifyEnvChange,
      },
    );

    processProfile.outcome = 'completed';
    return env;
  } catch (error) {
    const failure = await handleRuntimeFrameFailure(error, liveEnv, frame, {
      isStorageError: candidate => candidate instanceof RuntimeFrameStorageError,
      isQuarantinedError: candidate => candidate instanceof RuntimeInputQuarantinedError,
    });
    env = failure.env;
    if (!failure.inputDropped) throw failure.error;
    processProfile.outcome = 'input-dropped';
    return liveEnv;
  } finally {
    finishRuntimeFrame(
      env,
      liveEnv,
      processState,
      frame,
      processProfile,
      releaseProcessLock,
    );
  }
};

const runtimeStorageApi = createRuntimeStorageApi({
  getStorageDb,
  getFrameDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenFrameDb,
  closeRuntimeDb,
  closeInfraDb,
  waitForPromiseBeforeTimeout,
  createEmptyEnv,
  replayRecoveryFrameJournals,
});

export const waitForRuntimeProcessingIdle = runtimeStorageApi.waitForRuntimeProcessingIdle;
const getRuntimeProcessGlobal = runtimeStorageApi.getRuntimeProcessGlobal;
export const RuntimeStorageWriteTimeoutError = runtimeStorageApi.RuntimeStorageWriteTimeoutError;
export type RuntimeStorageWriteTimeoutError = InstanceType<typeof RuntimeStorageWriteTimeoutError>;
export const RuntimeFrameStorageError = runtimeStorageApi.RuntimeFrameStorageError;
export type RuntimeFrameStorageError = InstanceType<typeof RuntimeFrameStorageError>;
export const saveEnvToDB = runtimeStorageApi.saveEnvToDB;
export const readPersistedStorageFrameRecord = runtimeStorageApi.readPersistedStorageFrameRecord;
export const listPersistedEntityIdsAtHeight = runtimeStorageApi.listPersistedEntityIdsAtHeight;
export const verifyRuntimeChain = runtimeStorageApi.verifyRuntimeChain;
const resolvePersistedLatestHeight = runtimeStorageApi.resolvePersistedLatestHeight;
const resolvePersistedCheckpointHeights = runtimeStorageApi.resolvePersistedCheckpointHeights;
const loadEnvFromStorageByReplay = runtimeStorageApi.loadEnvFromStorageByReplay;
export const {
  getPersistedLatestHeight,
  loadEntityStateFromStorageDb,
  loadEntityAccountDocFromStorageDb,
  loadEntityViewPageFromStorageDb,
  inspectStorageDb,
  listPersistedCheckpointHeights,
  readPersistedStorageHead,
  verifyLiveRuntimeStorage,
  readPersistedFrameJournal,
  readPersistedRuntimeActivityJournal,
  readPersistedAccountFrameHistory,
  readPersistedEntityFrameHistory,
  readPersistedFrameJournals,
  readPersistedRuntimeActivityPage,
  readPersistedCheckpointSnapshot,
  buildPersistedRuntimeRecording,
  openDetachedRuntimeRecording,
} = createPersistenceQueries({
  tryOpenStorageDb,
  getStorageDb,
  tryOpenFrameDb,
  getFrameDb,
  resolvePersistedLatestHeight,
  resolvePersistedCheckpointHeights,
  readPersistedStorageFrameRecord,
  loadEnvFromStorageByReplay,
  closeRuntimeDb,
  restoreEnvFromRecoveryBundles,
  withStorageConsistentRead,
});

export const loadEnvFromDB = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: {
    fromSnapshotHeight?: number;
    trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  },
): Promise<RuntimeState | null> => {
  try {
    const restored = await loadEnvFromStorageByReplay(
      runtimeId,
      runtimeSeed,
      Number.isFinite(options?.fromSnapshotHeight) ? Math.floor(Number(options?.fromSnapshotHeight)) : undefined,
    );
    const latestEnv = restored?.env ?? null;

    if (latestEnv) {
      // Persisted payloads and retry evidence are verified byte-for-byte by
      // loadEnvFromStorage. Only after that boundary may a new transport
      // session discard stale wall-clock deadlines and retry reliable heads.
      markRestoredReliableOutputsDue(latestEnv);
      await rehydrateRestoredRuntimeInfra(latestEnv, {
        isBrowser: runtimeIsBrowser,
        loadGossipProfiles: targetEnv => loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
        assertPersistedContractConfigReady,
        setBrowserVMJurisdiction,
        ...(options?.trustedJurisdictionRpcBindings
          ? { trustedJurisdictionRpcBindings: options.trustedJurisdictionRpcBindings }
          : {}),
      });
      registerCommittedSingleSignerWallets(latestEnv);
    }

    return latestEnv;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    runtimeLog.error('load_env_from_db.failed', { error: message });
    throw err;
  }
};

export const clearDB = async (env?: RuntimeState): Promise<void> => {
  const targetEnv = env ?? createEmptyEnv(null);

  if (!runtimeIsBrowser && nodeProcess) {
    try {
      await closeRuntimeDb(targetEnv);
      await closeInfraDb(targetEnv);
      const fs = await import('fs/promises');
      await fs.rm(dbRootPath, { recursive: true, force: true });
      await fs.mkdir(dbRootPath, { recursive: true });
      runtimeLog.info('db.clear_root_complete', { path: dbRootPath });
    } catch (err) {
      runtimeLog.error('db.clear_root_failed', {
        path: dbRootPath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return;
  }

  if (!runtimeIsBrowser) return;

  try {
    const infraReady = await tryOpenInfraDb(targetEnv);
    const storageReady = await tryOpenStorageDb(targetEnv, 'current');
    const storagePreviousReady = await tryOpenStorageDb(targetEnv, 'previous');
    const frameReady = await tryOpenFrameDb(targetEnv);
    if (infraReady) {
      const infraDb = getInfraDb(targetEnv);
      await infraDb.clear();
    }
    if (storageReady) {
      const storageDb = getStorageDb(targetEnv, 'current');
      await storageDb.clear();
    }
    if (storagePreviousReady) {
      const previousStorageDb = getStorageDb(targetEnv, 'previous');
      await previousStorageDb.clear();
    }
    if (frameReady) {
      const frameDb = getFrameDb(targetEnv);
      await frameDb.clear();
    }
    runtimeLog.info('db.clear_complete');
  } catch (err) {
    runtimeLog.error('db.clear_failed', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};

const runtimeCommandApi = createRuntimeCommandApi({
  getP2P,
  getRuntimeOutputRoutingDeps,
});

export const submitCrossJurisdictionIntent = runtimeCommandApi.submitCrossJurisdictionIntent;
export const submitCrossJurisdictionSwap = runtimeCommandApi.submitCrossJurisdictionSwap;
