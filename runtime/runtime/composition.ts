import { runtimeIsBrowser } from '../infra/process/runtime-process';
export { getLiveJAdapter, getLiveJAdapterEntries } from './live-jadapters';

// The testnet exposes one canonical runtime contract. Breaking changes replace
// v1 in place; there are no compatibility branches inside the state machine.
export const RUNTIME_SCHEMA_VERSION = 1;

import { assertBrowserVMJurisdiction } from '../jurisdiction/adapter/browservm/browservm-registry';
import { attachEventEmitters } from './env-events';
import type { EntityInput } from '../entity/types';
import type { RuntimeReplica } from './types';
import { createPersistenceQueries } from '../storage/queries';
import { createRuntimeStorageApi } from '../storage/runtime-storage';
import { rehydrateRestoredRuntimeInfra, type TrustedJurisdictionRpcBinding } from './infra';
import { createRuntimeLoopApi } from './loop/loop.ts';
import { createRuntimeRecoveryApi } from '../storage/recovery/restore';
import { createRuntimeStateApi } from './state-create';
import { loadGossipProfilesFromInfraDb } from './infra-gossip-store';
import { withStorageConsistentRead } from '../storage/runtime-dbs';
import {
  createRuntimeCommandApi,
} from './command-api';
import {
  cloneRuntimeFrameMempool,
  runtimeInputHasQueuedWork,
} from './frame/transaction';
import {
  admitAtomicCrossJAccountInputs,
} from './frame/cross-j/atomic-admission';
import { createRuntimeInputReducer } from './frame/input/reducer';
import { createRuntimeProcessor } from './frame/process';
import { clearRuntimeDatabases } from './storage-admin';
import { loadLiveRuntimeFromDB } from './live-restore';
import {
  bootstrapRuntime,
  type RuntimeCreationOptions,
  type RuntimeLocalSigner,
} from './bootstrap';
import {
  notifyRuntimeFrameCommitted,
  notifyRuntimeStateChanged,
} from './frame/notifications';

export { admitAtomicCrossJAccountInputs };
export { quoteHtlcPaymentRoute } from '../entity/htlc/payment-admission';

let processRuntimeImpl: ReturnType<typeof createRuntimeProcessor> | undefined;

export const processRuntime = async (
  env: RuntimeReplica,
  inputs?: EntityInput[],
  runtimeDelay = 0,
): Promise<RuntimeReplica> => {
  if (!processRuntimeImpl) throw new Error('RUNTIME_PROCESSOR_NOT_INITIALIZED');
  return processRuntimeImpl(env, inputs, runtimeDelay);
};

// Runtime execution state lives on RuntimeReplica. This module owns the canonical
// frame transition; runtime.ts is intentionally only the public entrypoint.

const runtimeLoopApi = createRuntimeLoopApi({
  notifyEnvChange: env => notifyRuntimeStateChanged(env),
  processRuntime: (env, inputs, runtimeDelay) => processRuntime(env, inputs, runtimeDelay),
  waitForRuntimeProcessingIdle: (env, timeoutMs) => waitForRuntimeProcessingIdle(env, timeoutMs),
  getRuntimeProcessGlobal: () => getRuntimeProcessGlobal(),
  runtimeInputHasQueuedWork: input => runtimeInputHasQueuedWork(input),
});

const {
  registerRuntimePublishedCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  readRuntimeMetadata,
  writeRuntimeMetadata,
  ensureRuntimeConfig,
  getRuntimeStorageDb,
  getStorageDb,
  getInfraDb,
  getRuntimeWalDb,
  getHistoryViewDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenRuntimeWalDb,
  tryOpenHistoryViewDb,
  closeRuntimeDb,
  closeInfraDb,
  getCleanLogs,
  clearCleanLogs,
  copyCleanLogs,
  enqueueRuntimeInputs,
  enqueueRuntimeContinuation,
  infraGossipDbAccess,
  trackInfraDbWrite,
  hasRuntimeWork,
  prioritizeJEventFrame,
  generateHookPings,
  startRuntimeLoop,
  waitForPromiseBeforeTimeout,
  stopRuntimeLoopAndWait,
  resumeRuntimeLoop,
  resumeRuntimeAfterPersistenceQuiesce,
  waitForRuntimeWorkDrained,
  startJurisdictionWatchers,
  stopJurisdictionWatchers,
  stopJurisdictionWatchersAndWait,
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
  findCommittedRuntimeInputHeight,
  findPersistedRuntimeInputHeight,
  runtimeFrameContainsSubmittedInput,
  runtimeInputParts,
  waitForRuntimeInputCommitted,
} from './input-completion';

export {
  registerRuntimePublishedCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  getRuntimeStorageDb,
  getInfraDb,
  getRuntimeWalDb,
  getHistoryViewDb,
  tryOpenStorageDb,
  tryOpenRuntimeWalDb,
  tryOpenHistoryViewDb,
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
const applyRuntimeInput = createRuntimeInputReducer({
  assertApplyAllowed: env => {
    failfastAssert(
      env.scenarioMode === true || readRuntimeMetadata(env, ENV_APPLY_ALLOWED_KEY) === true,
      'RUNTIME_APPLY_DIRECT_CALL',
      'applyRuntimeInput must be invoked via process()/WAL replay (non-scenario)',
      { runtimeId: env.runtimeId, height: env.state.height },
    );
  },
  isReplay: env => readRuntimeMetadata(env, ENV_REPLAY_MODE_KEY) === true,
  normalizeEntityInput: normalizeRuntimeEntityInput,
  getRoutingDeps: getRuntimeEntityRoutingDeps,
  applyCommittedLocalReceipts: (env, commits, options) =>
    applyCommittedLocalReliableReceipts(env, commits, options),
});

export type { RuntimeCreationOptions, RuntimeLocalSigner };

const main = (
  runtimeSeedOverride?: string | null,
  options?: RuntimeCreationOptions,
): Promise<RuntimeReplica> => bootstrapRuntime({
  createRuntime: createEmptyEnv,
  loadRuntime: loadEnvFromDB,
  loadGossipProfiles: env => loadGossipProfilesFromInfraDb(env, infraGossipDbAccess),
  startRuntimeLoop,
}, runtimeSeedOverride, options);

// Clear database for a specific runtime and return a fresh env
export {
  applyRuntimeInput,
  main,
  assertBrowserVMJurisdiction,
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
  getRuntimeWalDb,
  tryOpenStorageDb,
  tryOpenRuntimeWalDb,
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
const applyCommittedLocalReliableReceipts = runtimeRecoveryApi.applyCommittedLocalReliableReceipts;

const runtimeStorageApi = createRuntimeStorageApi({
  getStorageDb,
  getRuntimeWalDb,
  getHistoryViewDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenRuntimeWalDb,
  tryOpenHistoryViewDb,
  closeRuntimeDb,
  closeInfraDb,
  waitForPromiseBeforeTimeout,
  createEmptyEnv,
  replayRecoveryFrameJournals,
});

processRuntimeImpl = createRuntimeProcessor({
  loop: runtimeLoopApi,
  recovery: runtimeRecoveryApi,
  storage: runtimeStorageApi,
  attachEventEmitters,
  applyRuntimeInput,
  setApplyAllowed: (env, allowed) => {
    writeRuntimeMetadata(env, ENV_APPLY_ALLOWED_KEY, allowed);
  },
  getRuntimeOutputRoutingDeps,
  notifyEnvChange: notifyRuntimeStateChanged,
  notifyRuntimeFrameCommitted,
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
  tryOpenRuntimeWalDb,
  getRuntimeWalDb,
  tryOpenHistoryViewDb,
  getHistoryViewDb,
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
): Promise<RuntimeReplica | null> => loadLiveRuntimeFromDB({
  loadByReplay: loadEnvFromStorageByReplay,
  rehydrate: (env, trustedJurisdictionRpcBindings) =>
    rehydrateRestoredRuntimeInfra(env, {
      isBrowser: runtimeIsBrowser,
      loadGossipProfiles: targetEnv =>
        loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
      assertPersistedContractConfigReady,
      assertBrowserVMJurisdiction,
      ...(trustedJurisdictionRpcBindings ? { trustedJurisdictionRpcBindings } : {}),
    }),
  registerCommittedSingleSignerWallets,
}, runtimeId, runtimeSeed, options);

export const clearDB = async (env?: RuntimeReplica): Promise<void> => {
  const targetEnv = env ?? createEmptyEnv(null);
  await clearRuntimeDatabases(targetEnv, runtimeLoopApi);
};

const runtimeCommandApi = createRuntimeCommandApi({
  enqueueRuntimeInputs,
  getRuntimeOutputRoutingDeps,
});

export const submitCrossJurisdictionIntent = runtimeCommandApi.submitCrossJurisdictionIntent;
export const submitCrossJurisdictionSwap = runtimeCommandApi.submitCrossJurisdictionSwap;
