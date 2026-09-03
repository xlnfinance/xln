import { runtimeIsBrowser } from '../support/process/runtime-process';
export { getLiveJAdapter, getLiveJAdapterEntries } from './j-submit/live-jadapters';

// The testnet exposes one canonical runtime contract. Breaking changes replace
// v1 in place; there are no compatibility branches inside the state machine.
export const RUNTIME_SCHEMA_VERSION = 1;

import { assertBrowserVMJurisdiction } from '../jurisdiction/adapter/browservm/browservm-registry';
import { attachEventEmitters } from './observability/env-events';
import type { EntityInput } from '../entity/types';
import type { RuntimeReplica } from './types';
import { createPersistenceQueries } from '../storage/queries';
import { createRuntimeStorageApi } from '../storage/runtime-storage';
import { rehydrateRestoredRuntimeInfra, type TrustedJurisdictionRpcBinding } from './recovery/j-adapter-restore';
import { createRuntimeLoopApi } from './loop/loop.ts';
import { createRuntimeRecoveryApi } from '../storage/recovery/restore';
import { createRuntimeStateApi } from './replica/state-create';
import { loadGossipProfilesFromInfraDb } from './envelope/gossip-store';
import { ensureRuntimeInfrastructure } from './envelope/replica-envelope';
import { withStorageConsistentRead } from '../storage/runtime-dbs';
import {
  createRuntimeCommandApi,
} from './command/api';
import {
  runtimeInputHasQueuedWork,
} from './frame/transaction';
import {
  admitAtomicCrossJAccountInputs,
} from './frame/cross-j/atomic-admission';
import { createRuntimeInputReducer } from './frame/intake/reducer';
import { createRuntimeProcessor } from './frame/process';
import { clearRuntimeDatabases } from './envelope/storage-admin';
import { loadLiveRuntimeFromDB } from './recovery/live-restore';
import {
  bootstrapRuntime,
  type RuntimeCreationOptions,
  type RuntimeLocalSigner,
} from './replica/bootstrap';
import {
  notifyRuntimeFrameCommitted,
  notifyRuntimeStateChanged,
} from './frame/notifications';
import {
  authorityDriverEnabled,
  discardAuthorityRuntime,
  restoreAuthorityExact,
  setAuthorityRuntimeSuppressed,
} from '../rscore/authority-driver';

export { admitAtomicCrossJAccountInputs };
export { quoteHtlcPaymentRoute } from '../pathfinding/htlc-quote';

let processRuntimeImpl: ReturnType<typeof createRuntimeProcessor> | undefined;

export const processRuntime = async (
  env: RuntimeReplica,
  inputs?: EntityInput[],
): Promise<RuntimeReplica> => {
  if (!processRuntimeImpl) throw new Error('RUNTIME_PROCESSOR_NOT_INITIALIZED');
  return processRuntimeImpl(env, inputs);
};

// Runtime execution state lives on RuntimeReplica. This module owns the canonical
// frame transition; runtime.ts is intentionally only the public entrypoint.

const runtimeLoopApi = createRuntimeLoopApi({
  notifyEnvChange: env => notifyRuntimeStateChanged(env),
  processRuntime: (env, inputs) => processRuntime(env, inputs),
  waitForRuntimeProcessingIdle: (env, timeoutMs) => waitForRuntimeProcessingIdle(env, timeoutMs),
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
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenRuntimeWalDb,
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
} from './mempool/input-completion';

export {
  registerRuntimePublishedCallback,
  registerRuntimeFrameCommitCallback,
  registerRecoveryBackupBarrier,
  getRuntimeStorageDb,
  getInfraDb,
  getRuntimeWalDb,
  tryOpenStorageDb,
  tryOpenRuntimeWalDb,
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
export { canonicalEntitySeed, importEntity } from './registration/entity-creation';

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
  startJurisdictionWatchers,
  getRuntimeOutputRoutingDeps,
  applyRuntimeInput,
  accountAuthorityConfigured: () => authorityDriverEnabled(),
  setAccountAuthoritySuppressed: setAuthorityRuntimeSuppressed,
});

export const restoreEnvFromCheckpointSnapshot = runtimeRecoveryApi.restoreEnvFromCheckpointSnapshot;
export const restoreEnvFromRecoveryBundles = runtimeRecoveryApi.restoreEnvFromRecoveryBundles;
export const persistRestoredEnvToDB = runtimeRecoveryApi.persistRestoredEnvToDB;
export const replayRecoveryFrameJournals = runtimeRecoveryApi.replayRecoveryFrameJournals;
const assertPersistedContractConfigReady = runtimeRecoveryApi.assertPersistedContractConfigReady;
const registerCommittedSingleSignerWallets = runtimeRecoveryApi.registerCommittedSingleSignerWallets;

const runtimeStorageApi = createRuntimeStorageApi({
  ensureRuntimeInfrastructure,
  getStorageDb,
  getRuntimeWalDb,
  tryOpenStorageDb,
  rotateStorageEpochDb,
  tryOpenRuntimeWalDb,
  closeRuntimeDb,
  closeInfraDb,
  waitForPromiseBeforeTimeout,
  createEmptyEnv,
  replayRecoveryFrameJournals,
  restoreAccountAuthorityExact: restoreAuthorityExact,
  discardAccountAuthority: discardAuthorityRuntime,
  setAccountAuthoritySuppressed: setAuthorityRuntimeSuppressed,
  accountAuthorityConfigured: () => authorityDriverEnabled(),
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
export const RuntimeStorageWriteTimeoutError = runtimeStorageApi.RuntimeStorageWriteTimeoutError;
export type RuntimeStorageWriteTimeoutError = InstanceType<typeof RuntimeStorageWriteTimeoutError>;
export const RuntimeFrameStorageError = runtimeStorageApi.RuntimeFrameStorageError;
export type RuntimeFrameStorageError = InstanceType<typeof RuntimeFrameStorageError>;
export const saveEnvToDB = runtimeStorageApi.saveEnvToDB;
export const readPersistedStorageFrameRecord = runtimeStorageApi.readPersistedStorageFrameRecord;
const readPersistedStorageFramePayloads = runtimeStorageApi.readPersistedStorageFramePayloads;
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
  readPersistedRuntimeActivityRecord,
  readPersistedAccountFrameHistory,
  readPersistedAccountFrameHistoryRecords,
  readPersistedAccountSwapHistoryPage,
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
  resolvePersistedLatestHeight,
  resolvePersistedCheckpointHeights,
  readPersistedStorageFrameRecord,
  readPersistedStorageFramePayloads,
  loadEnvFromStorageByReplay,
  replayRecoveryFrameJournals,
  closeRuntimeDb,
  closeInfraDb,
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
  discardAccountAuthority: discardAuthorityRuntime,
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
export const submitCrossJurisdictionIntents = runtimeCommandApi.submitCrossJurisdictionIntents;
export const submitCrossJurisdictionSwap = runtimeCommandApi.submitCrossJurisdictionSwap;
