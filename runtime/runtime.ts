import { Level } from 'level';
import { ethers } from 'ethers';
import type { Provider } from 'ethers';
import { TIMING } from './constants';
import {
  DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
  dbRootPath,
  isProductionRuntime,
  nodeProcess,
  runtimeIsBrowser,
  yieldRuntimeIoTurn,
} from './machine/platform';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from './infra/perf-runtime-flags';

// Bump this on runtime bundle changes that must be reflected in frontend immediately.
const RUNTIME_BUILD_ID = '2026-07-18-16:00Z';
// Bump this only on breaking persistence/replay format or invariants.
export const RUNTIME_SCHEMA_VERSION = 5;
export const RUNTIME_BUILD = RUNTIME_BUILD_ID;

const RUNTIME_APPLY_PROFILE =
  nodeProcess?.env?.['XLN_RUNTIME_APPLY_PROFILE'] === '1';
const RUNTIME_APPLY_SLOW_MS = Math.max(
  0,
  Number(nodeProcess?.env?.['XLN_RUNTIME_APPLY_SLOW_MS'] || '500'),
);
const RUNTIME_ACCOUNT_CAUSAL_TRACE =
  nodeProcess?.env?.['XLN_ACCOUNT_CAUSAL_TRACE'] === '1';
const RUNTIME_PROCESS_PROFILE =
  RUNTIME_APPLY_PROFILE ||
  RUNTIME_ACCOUNT_CAUSAL_TRACE ||
  nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const RUNTIME_PROCESS_SLOW_MS = Math.max(
  0,
  Number(nodeProcess?.env?.['XLN_RUNTIME_PROCESS_SLOW_MS'] || '1000'),
);
const runtimeProcessProfileEnabled = (): boolean =>
  RUNTIME_PROCESS_PROFILE || isRuntimePerfProfileEnabled('XLN_RUNTIME_APPLY_PROFILE', 'XLN_ACCOUNT_CAUSAL_TRACE');
const runtimeProcessSlowMs = (): number =>
  readRuntimePerfSlowMs('XLN_RUNTIME_PROCESS_SLOW_MS', RUNTIME_PROCESS_SLOW_MS);
import { getPerfMs, getWallClockMs } from './utils';
import { cumulativeMarksToPhases } from './infra/perf-profile';
import {
  causalTraceContainsWork,
  summarizeRuntimeAccountCausality,
  type EntityInputCausalTrace,
} from './infra/account-causal-trace';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
  cloneIsolatedRuntimeSnapshot,
} from './protocol/runtime-input-clone';
import { requireBoundaryInteger } from './protocol/boundary-validation';
import { listOpenSwapOffers } from './orderbook/open-swap-offers';
import { requireDurableJurisdictionStack } from './jurisdiction/contract-address';
import { withCanonicalCrossJurisdictionRouteHash } from './extensions/cross-j/index';
import {
  buildCanonicalEnvSnapshot,
  buildCanonicalJReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimeMachineSnapshot,
  buildRuntimeCheckpointSnapshot,
  authorizeRestoredRuntimeInput,
  normalizePersistedSnapshotInPlace,
  projectReplayVerifiableRuntimeMachine,
  restoreDurableRuntimeSnapshot,
} from './wal/snapshot';
import {
  hasRuntimeHistoryTraceForTesting,
  recordRuntimeHistoryTraceForTesting,
} from './history-retention';
import {
  mergeEntityInputs,
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
} from './entity/consensus/index';
import { accountHasProposableMempool } from './entity/consensus/account-mempool-eligibility';
import { hasVerifiedEntityCommitPrecertificate } from './entity/consensus/commit-precheck';
import {
  copyLocalEntityLeaderTimeoutVoteAuthorization,
  isEntityActiveLeader,
  isLocalEntityLeaderTimeoutVote,
} from './entity/consensus/leader';
import type { JAdapter } from './jadapter';
import {
  createLazyEntity,
  createNumberedEntity,
  createNumberedEntitiesBatch,
  detectEntityType,
  encodeBoard,
  generateLazyEntityId,
  generateNamedEntityId,
  generateNumberedEntityId,
  hashBoard,
  isEntityRegistered,
  requestNamedEntity,
  resolveEntityIdentifier,
} from './entity/factory';
import { assertPersistedLocalEntityCryptoKeys } from './entity/crypto';
import {
  assignNameOnChain,
  getBrowserVMInstance,
  debugFundReserves,
  getEntityInfoFromChain,
  getJurisdictionByAddress,
  setBrowserVMJurisdiction,
  submitProcessBatch,
  transferNameBetweenEntities,
} from './jadapter';
import { getAvailableJurisdictions } from './jurisdiction/config';
import {
  assertCertifiedBoardRootsAvailable,
  collectReachableCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from './jurisdiction/board-registry';
import {
  assertConsumptionRootsAvailable,
  collectReachableConsumptionNodes,
  getConsumptionNodeStore,
  getLiveConsumptionAccumulatorStates,
} from './entity/consumption-store';
import {
  collectReachableAccountJClaimNodes,
} from './account/j-claim-accumulator';
import {
  assertAccountJClaimRootsAvailable,
  getAccountJClaimNodeStore,
  getLiveAccountJClaimAccumulatorStates,
} from './account/j-claim-store';
import { createGossipLayer } from './networking/gossip';
import {
  attachEventEmitters,
  clearPendingAuditEvents,
  dropPendingFrameDbRecords,
  dropOverlay,
  flushPendingAuditEvents,
  peekPendingFrameDbRecords,
  setAccountFrameHistoryView,
} from './machine/env-events';
import { recordRuntimeSecurityIncident } from './machine/security-incidents';
import { accountInputAck, accountInputProposal } from './account/consensus/flush';
import { getEffectiveEntityInputTxs } from './entity/consensus/output-envelope';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  getCachedSignerPrivateKey,
  getLocalSignerPrivateKey,
  getSignerPrivateKeyIfAvailable,
  prewarmSignerKeyCache,
  registerSignerKey,
} from './account/crypto';
import {
  buildLocalEntityProfile,
} from './networking/gossip-helper';
import type { Profile } from './networking/gossip';
import { normalizeRuntimeId } from './networking/runtime-id';
import {
  ensureRuntimeGossipProfiles,
  getRuntimeP2P,
  getRuntimeP2PState,
  refreshRuntimeGossip,
  startPendingRuntimeP2PIfReady,
  startRuntimeP2P,
  stopRuntimeP2P,
  stopRuntimeP2PAndWait,
  type P2PConfig,
  type P2PConnectionState,
  type RuntimeP2PLifecycleDeps,
} from './machine/p2p-lifecycle';
import {
  parseReplicaKey,
  extractEntityId,
  extractSignerId,
  formatReplicaKey,
  createReplicaKey,
  formatReplicaDisplay,
  // Constants
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  XLN_COORDINATOR,
  CHAIN_IDS,
  MAX_NUMBERED_ENTITY,
  // Type guards
  isValidEntityId,
  isValidSignerId,
  isValidJId,
  isValidEpAddress,
  // Constructors
  toEntityId,
  toSignerId,
  toJId,
  toEpAddress,
  isNumberedEntity,
  isLazyEntity,
  getEntityDisplayNumber,
  // URI operations
  formatReplicaUri,
  parseReplicaUri,
  createLocalUri,
  // Type-safe collections
  ReplicaMap,
  EntityMap,
  jIdFromChainId,
  createLazyJId,
  // Tolerant parsing helpers
  safeParseReplicaKey,
  safeExtractEntityId,
} from './ids';
import {
  createProfileUpdateTx,
  getEntityDisplayInfo as getEntityDisplayInfoFromProfileOriginal,
  resolveEntityName as resolveEntityNameOriginal,
  searchEntityNames as searchEntityNamesOriginal,
} from './routing/name-resolution';
import { decode, encode } from './storage/snapshot-coder'; // encode used in exports
import {
  deriveDelta,
  isLeft,
  getTokenInfo,
  getKnownTokenIds,
  getTokenIdsForJurisdiction,
  isLiquidSwapToken,
  getSwapPairOrientation,
  getDefaultSwapTradingPairs,
  createDemoDelta,
  getDefaultCreditLimit,
} from './account/utils';
import {
  computeSwapPriceTicks,
  getSwapLotScale,
  prepareSwapOrder,
  quantizeSwapOrder,
  requantizeRemainingSwapAtPrice,
} from './orderbook';
import {
  buildCrossJurisdictionSwapSubmission,
  type CrossJurisdictionSwapSubmitParams,
  type CrossJurisdictionSwapSubmitResult,
} from './machine/jurisdiction-api';
import {
  buildPendingNetworkOutputs,
  dispatchEntityOutputs,
  getReliableOutputIdentity,
  getNextNetworkRetryTimestamp,
  hasReadyPendingNetworkOutputs,
  markPendingCrossJAdmissionOutputsReady,
  markRestoredReliableOutputsDue,
  MAX_PENDING_NETWORK_OUTPUTS,
  planEntityOutputs,
  pruneReceiptedReliableOutputs,
  rescheduleDeferredOutputs,
  sendEntityInputWithRouting,
  splitRoutedOutputByDeliveryLane,
  splitPendingOutputsByRetryWindow,
  type RuntimeEntityInputRoutingResult,
  type RuntimeOutputRoutingDeps,
} from './machine/output-routing';
import { runtimeInputRequiresOutboxCapacity } from './machine/admission';
import { isDeliveryDelivered, requireDeliveryResult } from './protocol/payments/delivery-result';
import { prepareHtlcPaymentEntityInputs } from './protocol/htlc/payment-admission';
import { copyDeterministicHtlcTestSecretCapability } from './protocol/htlc/test-secret-capability';
import {
  announceCertifiedLocalProfiles,
  collectDueLocalProfileCertificationInputs,
} from './networking/local-profile-lifecycle';
import {
  createRuntimeOutputRoutingDeps,
  handleInboundP2PEntityInput as routeInboundP2PEntityInput,
  handleInboundP2PEntityInputs as routeInboundP2PEntityInputs,
  registerEntityRuntimeHint as registerEntityRuntimeHintForRouting,
  selectMatchedCrossJAccountInputPairs,
  selectPotentialCrossJAccountInputPairs,
  validateInboundP2PEntityInput,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeInboundEntityInputOptions,
  type RuntimeEntityRoutingDeps,
} from './machine/entity-routing';
import {
  entityNeedsPeriodicWake as entityNeedsPeriodicWakeForRuntime,
  generateHookPings as generateRuntimeHookPings,
  getEarliestWallClockDueTimestamp as getEarliestRuntimeWallClockDueTimestamp,
  getNextWallClockWakeTimestamp as getNextRuntimeWallClockWakeTimestamp,
  hasDueEntityHooks as hasDueRuntimeEntityHooks,
  type RuntimeWakeDeps,
} from './machine/wake';
import {
  assertScheduledWakeTxAuthorized,
  copyLocalScheduledWakeAuthorization,
  deleteScheduledWakeIndex,
  rebuildScheduledWakeIndex,
  refreshScheduledWakeIndex,
} from './machine/scheduled-wake';
import {
  inferRuntimeLifecyclePhase,
  transitionRuntimeLifecycle,
} from './machine/lifecycle';
import {
  enqueueRuntimeInputs as enqueueRuntimeInputsWithDeps,
  ensureRuntimeMempool,
  type RuntimeInputQueueDeps,
  type RuntimeInputQueueOptions,
} from './machine/input-queue';
import {
  applyReliableDeliveryReceipts,
  captureReliableReceiptSenderCheckpoint,
  commitReliableIngress,
  finalizeReliableIngressCommit,
  getInputReliableIdentity,
  registerReliableIngress,
  registerReliableReceiptIngress,
  releaseUncommittedReliableIngress,
  rollbackReliableDeliveryReceipts,
  rollbackReliableIngressCommit,
  matchReceiptsToOutputs,
  type ReliableIngressCommit,
  type ReliableReceiptSenderCheckpoint,
} from './machine/reliable-delivery';
import { reliableIdentityExactKey } from './machine/reliable-frontier';
import { restoreDurableOutputRetryState } from './machine/durable-output-retry';
import { submitRuntimeJOutbox } from './machine/j-submit';
import {
  copyLocalJSubmitRuntimeTxAuthorization,
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from './machine/j-submit-state';
import { copyLocalEntityProviderActionRuntimeTxAuthorization } from './machine/entity-provider-action-submit-auth';
import {
  clearRuntimeCleanLogs,
  copyRuntimeCleanLogs,
  getRuntimeCleanLogs,
  type RuntimeCleanLogDeps,
} from './machine/clean-logs';
import { applyRuntimeTx } from './machine/tx-handlers';
import { copyLocalRuntimeAdapterCommandAuthorization } from './radapter/command-frontier-auth';
import {
  applyMergedEntityInputs,
  RuntimeEntityInputApplyError,
} from './machine/entity-inputs';
import { applyEntityHeightDurabilityBarrier } from './machine/entity-height-barrier';
import { classifyBilateralState, getAccountBarVisual } from './account/view-state';
import { calculateSolvency, verifySolvency } from './account/solvency';
import {
  formatTokenAmount,
  formatTokenAmount as formatTokenAmountEthers,
  parseTokenAmount,
  convertTokenPrecision,
  calculatePercentage as calculatePercentageEthers,
  formatAssetAmount as formatAssetAmountEthers,
  BigIntMath,
  FINANCIAL_CONSTANTS,
} from './account/financial-utils';
import {
  clearReplayOutputSignerHints,
  cloneEntityState,
  cloneTrustedEntityReplica,
  installReplayOutputSignerHints,
  resolveEntityProposerId,
} from './state-helpers';
import { getEntityShortId, formatEntityId } from './utils';
import { safeStringify } from './protocol/serialization';
import { validateJInputs } from './wal/runtime-machine-schema/j';
import {
  canonicalizeStorageAuditValue,
  computeCanonicalEntityHash,
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalRuntimeStateHash,
  computeCanonicalStateHashFromEnv,
} from './storage/canonical-hash';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from './storage/entity-lineage';
import {
  assertCertifiedRegistrationEvidenceStore,
  copyLocalJAuthorityRuntimeTxAuthorization,
} from './jurisdiction/registration-evidence';
import {
  copyLocalJImportResultRuntimeTxAuthorization,
  materializePendingJurisdictionImportResults,
} from './machine/jurisdiction-import';
import {
  computeStoragePostStateHash,
  findStorageLatestSnapshotAtOrBelow,
  hydrateAccountJClaimRootNodesFromStorage,
  hydrateCertifiedBoardRootNodesFromStorage,
  hydrateConsumptionRootNodesFromStorage,
  inspectStorage,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  listStorageSnapshotReplicaMetas,
  listStorageReplicaMetas,
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityStatesAtHeightFromStorage,
  loadEntityViewPageFromStorage,
  readFrameDbAccountFrames,
  readFrameDbEntityFrames,
  readFrameDbRuntimeActivity,
  readStorageFrameRecord,
  readStorageHead,
  readStorageOverlayRecordsFromDiffs,
  replaceRestoredStorageBase,
  saveRuntimeFrameToStorage,
  type StorageFrameRecord,
  type StorageHead,
  verifyStorageSnapshotAtHeight,
} from './storage';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
  STORAGE_SCHEMA_VERSION,
} from './storage/keys';
import {
  hydrateEntityStateFromStorage,
  projectAccountDoc,
  projectEntityCoreDoc,
} from './storage/projections';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  inspectStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaFields,
  summarizeStorageReplicaMetaHeads,
} from './storage/replicas';
import { assertStorageSafetyOverridesAllowed } from './storage/safety';
import { storageOverlayRecordKey } from './storage/overlay';
import type { StorageDoc, StoragePersistenceBoundaryHook } from './storage/types';
import { evaluateStorageProgressDeadline } from './storage/progress-deadline';
import type { RuntimeAdapterReadQuery } from './radapter';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryMatchesCertifiedAnchor,
  assertValidatorJHistoryIntegrity,
} from './jurisdiction/local-history';
import {
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  hasCurrentRoundJPrefixAttestation,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
  restoreJPrefixRound,
} from './jurisdiction/j-prefix-consensus';
export {
  resolveRuntimeAdapterRead,
  EmbeddedRuntimeAdapter,
  RemoteRuntimeAdapter,
} from './radapter';
export type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterStatus,
} from './radapter';
import {
  validateDelta,
  validateAccountDeltas,
  createDefaultDelta,
  isDelta,
  validateEntityInput,
} from './validation-utils';
import type {
  AccountFrame,
  CertifiedEntityFrameLink,
  CrossJurisdictionSwapRoute,
  EntityInput,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  EnvSnapshot,
  FrameLogEntry,
  JInput,
  JReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
  RuntimeFrameIngressBuffer,
  RuntimeOverlayRecord,
  RuntimeInput,
  RuntimeTx,
} from './types';
import {
  clearDatabase,
  DEBUG,
  formatEntityDisplay,
  formatSignerDisplay,
  hashToAvatar,
  generateEntityAvatar,
  generateSignerAvatar,
  getEntityDisplayInfo,
  getSignerDisplayInfo,
  log,
} from './utils';
import { createStructuredLogger, logError } from './infra/logger';
import type { PersistedFrameJournal } from './wal/store';
import {
  buildRuntimeActivityEvents,
  dedupeRuntimeActivityEvents,
  type PersistedActivityJournal,
  type RuntimeActivityEvent,
  type RuntimeActivityFilters,
} from './api/activity-history';
import {
  assertRuntimeRecoveryBundleAuthenticity,
  buildRuntimeRecoveryBundle,
  buildRuntimeRecoveryCheckpointBundle,
} from './recovery/bundle';
import { buildRuntimeRecording, validateRuntimeRecording } from './recovery/recording';
import type {
  RuntimeRecording,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
} from './recovery/types';
import {
  ensureLiveJAdapterForReplica,
  rehydrateRestoredRuntimeInfra,
  type TrustedJurisdictionRpcBinding,
} from './machine/infra';
import { findWatcherJurisdictionReplica } from './jadapter/helpers';
import {
  clearInfraGossipProfiles,
  loadGossipProfilesFromInfraDb,
  persistGossipProfileToInfraDb,
} from './machine/infra-gossip-store';
import {
  closeFrameDb,
  closeInfraDb as closeInfraDbStorage,
  closeStorageDb,
  deriveRuntimeIdFromSeed,
  getFrameDb as getFrameDbStorage,
  getInfraDb as getInfraDbStorage,
  getRuntimeDb as getRuntimeDbStorage,
  getStorageDb as getStorageDbStorage,
  normalizeDbNamespace,
  resolveFrameDbPath,
  resolveStorageDbPath,
  rotateStorageEpochDb as rotateStorageEpochDbStorage,
  tryOpenDb as tryOpenDbStorage,
  tryOpenFrameDb as tryOpenFrameDbStorage,
  tryOpenStorageDb as tryOpenStorageDbStorage,
  withStorageConsistentRead,
  withStorageWriterLock,
  type RuntimeStorageDbDeps,
  type StorageDbRole,
} from './storage/runtime-dbs';

const runtimeLog = createStructuredLogger('runtime');

const formatPerfMs = (value: number): string => value.toFixed(2);

// Per-runtime state is stored on env.runtimeState/runtimeMempool/runtimeConfig.

export const registerEnvChangeCallback = (env: Env, callback: (env: Env) => void): (() => void) => {
  const state = ensureRuntimeState(env);
  if (!state.envChangeCallbacks) {
    state.envChangeCallbacks = new Set();
  }
  state.envChangeCallbacks.add(callback);
  return () => state.envChangeCallbacks?.delete(callback);
};

export const registerRuntimeFrameCommitCallback = (
  env: Env,
  callback: (frame: { height: number; runtimeInput: RuntimeInput }) => void,
): (() => void) => {
  const state = ensureRuntimeState(env);
  if (!state.runtimeFrameCommitCallbacks) state.runtimeFrameCommitCallbacks = new Set();
  state.runtimeFrameCommitCallbacks.add(callback);
  return () => state.runtimeFrameCommitCallbacks?.delete(callback);
};

export const registerRecoveryBackupBarrier = (
  env: Env,
  callback: (env: Env, info: { height: number; remoteOutputCount: number; jInputCount: number }) => Promise<void>,
): (() => void) => {
  const state = ensureRuntimeState(env);
  state.recoveryBackupBarrier = callback;
  return () => {
    if (state.recoveryBackupBarrier === callback) {
      state.recoveryBackupBarrier = null;
    }
  };
};

const ensureRuntimeConfig = (env: Env): NonNullable<Env['runtimeConfig']> => {
  if (!env.runtimeConfig) {
    env.runtimeConfig = {
      minFrameDelayMs: 0,
      loopIntervalMs: isProductionRuntime ? 25 : 0,
      snapshotIntervalFrames: DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
    };
  }
  const configuredSnapshotInterval = env.runtimeConfig.snapshotIntervalFrames;
  if (!Number.isFinite(configuredSnapshotInterval ?? NaN) || (configuredSnapshotInterval ?? 0) < 1) {
    env.runtimeConfig.snapshotIntervalFrames = DEFAULT_SNAPSHOT_INTERVAL_FRAMES;
  }
  return env.runtimeConfig;
};

const ensureRuntimeState = (env: Env): NonNullable<Env['runtimeState']> => {
  if (!env.runtimeState) {
    env.runtimeState = {
      lifecyclePhase: 'booting',
      loopActive: false,
      halted: false,
      loopPromise: null,
      stopLoop: null,
      wakeLoop: null,
      wakeRequested: false,
      inFlightEntityInputs: 0,
      p2p: null,
      pendingP2PConfig: null,
      lastP2PConfig: null,
      directEntityInputsDispatch: null,
      directReliableReceiptDispatch: null,
      canUseConnectedRelayFallback: null,
      recoveryBackupBarrier: null,
    };
  }
  if (!env.runtimeState.entityRuntimeHints) {
    env.runtimeState.entityRuntimeHints = new Map();
  }
  if (!env.runtimeState.lifecyclePhase) {
    env.runtimeState.lifecyclePhase = inferRuntimeLifecyclePhase(env.runtimeState);
  }
  if (!env.runtimeState.watcherDedupCounter) {
    env.runtimeState.watcherDedupCounter = { value: 0 };
  }
  return env.runtimeState;
};

const getRuntimeStorageDbDeps = (): RuntimeStorageDbDeps => ({
  ensureRuntimeState,
});

export const getRuntimeDb = (env: Env): Level<Buffer, Buffer> =>
  getRuntimeDbStorage(env, getRuntimeStorageDbDeps());

export const getRuntimeStorageDb = (env: Env, role: StorageDbRole = 'current'): Level<Buffer, Buffer> =>
  getStorageDb(env, role);

const getStorageDb = (env: Env, role: StorageDbRole = 'current'): Level<Buffer, Buffer> =>
  getStorageDbStorage(env, getRuntimeStorageDbDeps(), role);

export const getInfraDb = (env: Env): Level<Buffer, Buffer> =>
  getInfraDbStorage(env, getRuntimeStorageDbDeps());

export const getFrameDb = (env: Env): Level<Buffer, Buffer> =>
  getFrameDbStorage(env, getRuntimeStorageDbDeps());

const tryOpenStorageDb = (env: Env, role: StorageDbRole = 'current'): Promise<boolean> =>
  tryOpenStorageDbStorage(env, getRuntimeStorageDbDeps(), role);

const rotateStorageEpochDb = (env: Env, snapshotHeight: number, timestamp = env.timestamp): Promise<boolean> =>
  rotateStorageEpochDbStorage(env, getRuntimeStorageDbDeps(), snapshotHeight, timestamp);

export const tryOpenDb = (env: Env): Promise<boolean> =>
  tryOpenDbStorage(env, getRuntimeStorageDbDeps());

export const tryOpenFrameDb = (env: Env): Promise<boolean> =>
  tryOpenFrameDbStorage(env, getRuntimeStorageDbDeps());

const throwSettledErrors = (results: PromiseSettledResult<unknown>[], code: string): void => {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, code);
};

const closeLegacyRuntimeDb = async (env: Env): Promise<void> => {
  const state = env.runtimeState;
  const db = state?.db;
  if (!state || !db) return;
  await db.close();
  if (state.db === db) {
    state.db = null;
    state.dbOpenPromise = null;
  }
};

export const closeRuntimeDb = async (env: Env): Promise<void> => {
  await stopJurisdictionWatchersAndWait(env);
  const shutdown = await Promise.allSettled([
    stopRuntimeLoopAndWait(env, 10_000).then((stopped) => {
      if (!stopped) throw new Error('RUNTIME_DB_CLOSE_LOOP_DRAIN_TIMEOUT');
    }),
    stopP2PAndWait(env, 10_000),
  ]);
  throwSettledErrors(shutdown, 'RUNTIME_DB_CLOSE_QUIESCE_FAILED');
  detachRuntimeEnv(env);
  const closed = await Promise.allSettled([
    closeStorageDb(env, 'current'),
    closeStorageDb(env, 'previous'),
    closeFrameDb(env),
    closeLegacyRuntimeDb(env),
  ]);
  throwSettledErrors(closed, 'RUNTIME_DB_CLOSE_FAILED');
};

export const closeInfraDb = async (env: Env): Promise<void> => {
  const state = ensureRuntimeState(env);
  state.infraDbClosing = true;
  await drainInfraDbWrites(env);
  await closeInfraDbStorage(env);
};

const requestRuntimeLoopWake = (env: Env): void => {
  const state = ensureRuntimeState(env);
  if (state.halted) return;
  const wakeLoop = state.wakeLoop;
  if (wakeLoop) {
    state.wakeLoop = null;
    wakeLoop();
    return;
  }
  state.wakeRequested = true;
};

const waitForRuntimeLoopWake = async (env: Env): Promise<void> => {
  const state = ensureRuntimeState(env);
  if (state.wakeRequested) {
    state.wakeRequested = false;
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.wakeLoop === wake) {
        state.wakeLoop = null;
      }
      resolve();
    };
    const wake = () => {
      state.wakeRequested = false;
      finish();
    };
    state.wakeLoop = wake;
  });
};

const waitForRuntimeLoopWakeOrTimeout = async (env: Env, timeoutMs: number): Promise<'wake' | 'timeout'> => {
  const state = ensureRuntimeState(env);
  if (timeoutMs <= 0) {
    if (state.wakeRequested) state.wakeRequested = false;
    await sleep(0);
    return 'timeout';
  }
  if (state.wakeRequested) {
    state.wakeRequested = false;
    return 'wake';
  }
  return await new Promise<'wake' | 'timeout'>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let result: 'wake' | 'timeout' = 'timeout';
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (state.wakeLoop === wake) {
        state.wakeLoop = null;
      }
      resolve(result);
    };
    const wake = () => {
      state.wakeRequested = false;
      result = 'wake';
      finish();
    };
    state.wakeLoop = wake;
    timeoutId = setTimeout(finish, timeoutMs);
  });
};

const ENV_APPLY_ALLOWED_KEY = Symbol.for('xln.runtime.env.apply.allowed');
const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');

const envRecord = (env: Env): Record<PropertyKey, unknown> => env as unknown as Record<PropertyKey, unknown>;

const failfastAssert: (
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

export const getCleanLogs = (env: Env): string =>
  getRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

export const clearCleanLogs = (env: Env): void =>
  clearRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

export const copyCleanLogs = async (env: Env): Promise<string> =>
  copyRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

function getRuntimeCleanLogDeps(): RuntimeCleanLogDeps {
  return { ensureRuntimeState };
}

const enqueueRuntimeInputs = (
  env: Env,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
  options: RuntimeInputQueueOptions = {},
): void => {
  enqueueRuntimeInputsWithDeps(
    env,
    getRuntimeInputQueueDeps(),
    inputs,
    runtimeTxs,
    jInputs,
    explicitTimestamp,
    reliableReceipts,
    options,
  );
};

/** Queue only deterministic work derived from an already-accepted transition. */
const enqueueRuntimeContinuation = (
  env: Env,
  inputs?: EntityInput[],
  runtimeTxs?: RuntimeTx[],
  jInputs?: JInput[],
  explicitTimestamp?: number,
  reliableReceipts?: ReliableDeliveryReceipt[],
): void => enqueueRuntimeInputs(
  env,
  inputs,
  runtimeTxs,
  jInputs,
  explicitTimestamp,
  reliableReceipts,
  { acceptedBeforeQuiesce: true },
);

function getRuntimeInputQueueDeps(): RuntimeInputQueueDeps {
  return {
    ensureRuntimeState,
    requestRuntimeLoopWake,
  };
}

export async function tryOpenInfraDb(env: Env): Promise<boolean> {
  const state = ensureRuntimeState(env);
  if (state.infraDbClosing) return false;
  if (!state.infraDbOpenPromise) {
    const db = getInfraDb(env);
    state.infraDbOpenPromise = (async () => {
      try {
        await db.open();
        return true;
      } catch (error) {
        const isBlocked =
          error instanceof Error &&
          (error.message?.includes('blocked') || error.name === 'SecurityError' || error.name === 'InvalidStateError');
        if (isBlocked) {
          runtimeLog.warn('infra_db.blocked_in_memory', { error: error instanceof Error ? error.message : String(error) });
          return false;
        }
        state.infraDbOpenPromise = null;
        throw error;
      }
    })();
  }
  try {
    return await state.infraDbOpenPromise;
  } catch (error) {
    runtimeLog.error('infra_db.open_failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const infraGossipDbAccess = { tryOpenInfraDb, getInfraDb };

const trackInfraDbWrite = (env: Env, promise: Promise<void>): void => {
  const state = ensureRuntimeState(env);
  if (!state.infraDbPendingWrites) state.infraDbPendingWrites = new Set();
  const tracked = promise.finally(() => {
    state.infraDbPendingWrites?.delete(tracked);
  });
  state.infraDbPendingWrites.add(tracked);
};

const drainInfraDbWrites = async (env: Env): Promise<void> => {
  const state = ensureRuntimeState(env);
  while (state.infraDbPendingWrites && state.infraDbPendingWrites.size > 0) {
    await Promise.allSettled([...state.infraDbPendingWrites]);
  }
};

export const enqueueRuntimeInput = (env: Env, runtimeInput: RuntimeInput): void => {
  const ingressTimestamp = env.scenarioMode
    ? (runtimeInput.timestamp ?? env.timestamp ?? 0)
    : (runtimeInput.timestamp ?? getWallClockMs());
  enqueueRuntimeInputs(
    env,
    runtimeInput.entityInputs,
    runtimeInput.runtimeTxs,
    runtimeInput.jInputs,
    ingressTimestamp,
    runtimeInput.reliableReceipts,
  );
};

const getRuntimeWorkReason = (env: Env): string | null => {
  const mempool = ensureRuntimeMempool(env);
  if ((env.runtimeState?.pendingProfileCertificationEntityIds?.size ?? 0) > 0) return 'profile-certification';
  if ((env.runtimeState?.pendingCommittedJOutbox?.length ?? 0) > 0) return 'committed-j-outbox';
  if ((env.runtimeState?.pendingJurisdictionImports?.size ?? 0) > 0) return 'jurisdiction-import';
  if (mempool.runtimeTxs.length > 0 || mempool.entityInputs.length > 0) return 'runtime-mempool';
  if ((mempool.jInputs?.length ?? 0) > 0) return 'j-input';
  if ((mempool.reliableReceipts?.length ?? 0) > 0) return 'reliable-receipt';
  if (runtimeInputHasQueuedWork(mempool) && (mempool.queuedAt ?? 0) > (env.timestamp ?? 0)) {
    return 'future-queued-input';
  }
  if (env.pendingOutputs && env.pendingOutputs.length > 0) return 'pending-output';
  if (env.networkInbox && env.networkInbox.length > 0) return 'network-inbox';
  if (hasReadyPendingNetworkOutputs(env, getRuntimeOutputRoutingDeps(), getWallClockMs())) return 'network-retry';
  if (hasEntityMempoolWakeInput(env)) return 'entity-mempool';
  if (hasAccountMempoolWakeInput(env)) return 'account-mempool';
  // Quiesce drains work accepted before the ingress fence. Timers remain
  // durable and fire after an explicit resume; materializing a newly-due hook
  // while the loop is stopping makes repeated shutdown impossible.
  if (!env.runtimeState?.persistenceQuiescing && hasDueEntityHooks(env)) return 'entity-hook';
  return null;
};

export const hasRuntimeWork = (env: Env): boolean => getRuntimeWorkReason(env) !== null;

export const retryPendingCrossJAdmissionEnvelopes = (
  env: Env,
  targetRuntimeId?: string,
): number => {
  const ready = markPendingCrossJAdmissionOutputsReady(
    env,
    getRuntimeOutputRoutingDeps(),
    targetRuntimeId,
  );
  if (ready > 0) requestRuntimeLoopWake(env);
  return ready;
};

const collectAccountMempoolWakeInputs = (env: Env): EntityInput[] => {
  const wakeInputs: EntityInput[] = [];
  for (const replica of env.eReplicas?.values?.() ?? []) {
    const entityId = String(replica?.entityId || replica?.state?.entityId || '').trim().toLowerCase();
    const signerId = String(replica?.signerId || '').trim().toLowerCase();
    if (!entityId || !signerId) continue;
    const accounts = replica?.state?.accounts;
    if (!(accounts instanceof Map)) continue;
    const hasAccountMempool = Array.from(accounts.values()).some((account) =>
      accountHasProposableMempool(account, replica.state)
    );
    if (!hasAccountMempool) continue;
    wakeInputs.push({ entityId, signerId, entityTxs: [] });
  }
  return wakeInputs;
};

const entityJPrefixReadyForWake = (replica: EntityReplica): boolean => {
  const prefixNeeded = entityRequiresJPrefixCertificate(replica.state) ||
    hasPendingLocalJEvent(replica.state, replica.jHistory);
  if (!prefixNeeded || replica.jPrefixRound?.certificate) return true;
  if (hasCurrentRoundJPrefixAttestation(replica)) return false;
  return Boolean(
    replica.jHistory &&
    getLocalJPrefixAttestableHeight(replica.state, replica.jHistory) !== null,
  );
};

const entityMempoolNeedsWake = (replica: EntityReplica): boolean =>
  isEntityActiveLeader(replica) &&
  entityJPrefixReadyForWake(replica) &&
  (
    replica.mempool.length > 0 ||
    Boolean(
      replica.jPrefixRound?.certificate &&
      replica.jPrefixRound.certificate.selected.scannedThroughHeight > replica.state.lastFinalizedJHeight,
    ) ||
    isFrozenBaseJPrefixRollAuthorized(replica, replica.jPrefixRound?.certificate)
  ) &&
  !replica.proposal &&
  !replica.lockedFrame;

const collectEntityMempoolWakeInputs = (env: Env): EntityInput[] => {
  const wakeInputs: EntityInput[] = [];
  for (const replica of env.eReplicas?.values?.() ?? []) {
    if (!entityMempoolNeedsWake(replica)) continue;
    const entityId = String(replica.entityId || replica.state?.entityId || '').trim().toLowerCase();
    const signerId = String(replica.signerId || '').trim().toLowerCase();
    if (!entityId || !signerId) continue;
    wakeInputs.push({ entityId, signerId, entityTxs: [] });
  }
  return wakeInputs;
};

const hasEntityMempoolWakeInput = (env: Env): boolean => {
  for (const replica of env.eReplicas?.values?.() ?? []) {
    if (entityMempoolNeedsWake(replica)) return true;
  }
  return false;
};

const hasAccountMempoolWakeInput = (env: Env): boolean => {
  for (const replica of env.eReplicas?.values?.() ?? []) {
    for (const account of replica.state?.accounts?.values?.() ?? []) {
      if (accountHasProposableMempool(account, replica.state)) return true;
    }
  }
  return false;
};

const prioritizeJEventFrame = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  timestamp: number,
): boolean => {
  const priorityInputs: EntityInput[] = [];
  const deferredInputs: EntityInput[] = [];

  for (const input of runtimeInput.entityInputs) {
    const entityTxs = input.entityTxs ?? [];
    const jEventTxs = entityTxs.filter((tx) => tx?.type === 'j_event');
    const otherTxs = entityTxs.filter((tx) => tx?.type !== 'j_event');
    const hasNonTxPayload =
      !!input.proposedFrame ||
      (!!input.hashPrecommits && input.hashPrecommits.size > 0) ||
      (!!input.jPrefixAttestations && input.jPrefixAttestations.size > 0) ||
      !!input.leaderTimeoutVote;

    if (jEventTxs.length > 0) {
      priorityInputs.push({ ...input, entityTxs: jEventTxs });
    }

    if (otherTxs.length > 0 || hasNonTxPayload) {
      const deferredInput: EntityInput = { ...input, entityTxs: otherTxs };
      if (otherTxs.length === 0) {
        delete deferredInput.entityTxs;
      }
      deferredInputs.push(deferredInput);
    }
  }

  if (priorityInputs.length === 0 || deferredInputs.length === 0) return false;

  // Chain observations are frame-boundary facts. Apply them alone before any
  // local follow-up tx that may depend on sentBatch, entityNonce, reserves, or
  // account-settlement claims; merging both into one entity frame can make the
  // follow-up build a stale J batch against pre-event state.
  runtimeInput.entityInputs = priorityInputs;
  mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];
  mempool.queuedAt = mempool.queuedAt ?? timestamp;
  return true;
};

const applyEntityInputFrameCap = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  maxEntityInputsPerFrame: number,
  timestamp: number,
): boolean => {
  const frameLimit = Math.max(0, Math.floor(Number(maxEntityInputsPerFrame)));
  if (frameLimit <= 0 || runtimeInput.entityInputs.length <= frameLimit) return false;

  const deferredInputs = runtimeInput.entityInputs.slice(frameLimit);
  runtimeInput.entityInputs = runtimeInput.entityInputs.slice(0, frameLimit);
  mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];
  mempool.queuedAt = mempool.queuedAt ?? timestamp;
  return true;
};

const applyEntityTxFrameCap = (
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  maxEntityTxsPerFrame: number,
  timestamp: number,
): boolean => {
  const frameLimit = Math.max(0, Math.floor(Number(maxEntityTxsPerFrame)));
  if (frameLimit <= 0) return false;

  let selectedTxs = 0;
  let capReached = false;
  let changed = false;
  const frameInputs: EntityInput[] = [];
  const deferredInputs: EntityInput[] = [];

  for (const input of runtimeInput.entityInputs) {
    const txs = input.entityTxs ?? [];
    const txCount = txs.length;

    if (capReached) {
      deferredInputs.push(input);
      changed = true;
      continue;
    }

    if (txCount === 0) {
      frameInputs.push(input);
      continue;
    }

    const remaining = frameLimit - selectedTxs;
    if (remaining <= 0) {
      deferredInputs.push(input);
      changed = true;
      continue;
    }

    // EntityInput is the accepted consensus envelope. Splitting entityTxs here
    // would turn one authorized intent into independently durable prefixes and
    // make receipts/cross-leg invariants observe states the sender never made.
    // The cap schedules whole envelopes only; one oversized head may pass whole
    // so FIFO can never deadlock.
    if (txCount <= remaining || selectedTxs === 0) {
      frameInputs.push(input);
      selectedTxs += txCount;
      if (selectedTxs >= frameLimit) capReached = true;
      continue;
    }

    deferredInputs.push(input);
    capReached = true;
    changed = true;
  }

  if (!changed) return false;

  runtimeInput.entityInputs = frameInputs;
  mempool.entityInputs = [...deferredInputs, ...mempool.entityInputs];
  mempool.queuedAt = mempool.queuedAt ?? timestamp;
  return true;
};

const getRuntimeWakeDeps = (): RuntimeWakeDeps => ({
  ensureRuntimeState,
  ensureRuntimeMempool,
  enqueueRuntimeInputs,
  getRuntimeNowMs,
});

export const entityNeedsPeriodicWake = entityNeedsPeriodicWakeForRuntime;

const hasDueEntityHooks = (env: Env): boolean =>
  hasDueRuntimeEntityHooks(env, getRuntimeWakeDeps());

const getEarliestWallClockDueTimestamp = (env: Env): number | null =>
  getEarliestRuntimeWallClockDueTimestamp(env, getRuntimeWakeDeps());

const getNextWallClockWakeTimestamp = (env: Env): number | null => {
  const entityDueAt = getNextRuntimeWallClockWakeTimestamp(env, getRuntimeWakeDeps());
  const networkDueAt = getNextNetworkRetryTimestamp(env, getRuntimeOutputRoutingDeps());
  if (entityDueAt === null) return networkDueAt;
  if (networkDueAt === null) return entityDueAt;
  return Math.min(entityDueAt, networkDueAt);
};

const generateHookPings = (env: Env, nowMs = getRuntimeNowMs(env), queuedAt = env.timestamp ?? 0): void => {
  // Quiesce drains only work accepted before its ingress fence. Scheduled
  // hooks remain durable for resume and must not extend the shutdown drain.
  if (env.runtimeState?.persistenceQuiescing) return;
  generateRuntimeHookPings(env, getRuntimeWakeDeps(), nowMs, queuedAt);
};

const isRuntimeFrameReady = (env: Env, now: number, overrideDelayMs?: number): boolean => {
  if (env.scenarioMode) return true; // deterministic scenarios advance manually
  const config = ensureRuntimeConfig(env);
  const rawDelayMs = overrideDelayMs !== undefined ? overrideDelayMs : (config.minFrameDelayMs ?? 0);
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return true;
  const delayMs = Math.max(0, Math.floor(rawDelayMs));
  const state = ensureRuntimeState(env);
  const lastFrameAt = state.lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) return true;
  return Math.max(0, now - lastFrameAt) >= delayMs;
};

const getRemainingRuntimeFrameDelayMs = (env: Env, overrideDelayMs?: number): number => {
  if (env.scenarioMode) return 0;
  const wallClockNow = getWallClockMs();
  const config = ensureRuntimeConfig(env);
  const rawDelayMs = overrideDelayMs !== undefined ? overrideDelayMs : (config.minFrameDelayMs ?? 0);
  if (!Number.isFinite(rawDelayMs) || rawDelayMs <= 0) return 0;
  const delayMs = Math.max(0, Math.floor(rawDelayMs));
  const lastFrameAt = ensureRuntimeState(env).lastFrameAt;
  if (typeof lastFrameAt !== 'number' || !Number.isFinite(lastFrameAt) || lastFrameAt <= 0) return 0;
  return Math.max(0, delayMs - Math.max(0, wallClockNow - lastFrameAt));
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const emitRuntimeLoopError = (
  env: Env,
  code: 'RUNTIME_LOOP_ERROR' | 'RUNTIME_LOOP_HALTED',
  payload: Record<string, unknown>,
): void => {
  try {
    env.error?.('system', code, payload, env.runtimeId);
  } catch (reportError) {
    runtimeLog.error('loop.report_failed', {
      code,
      error: reportError instanceof Error ? reportError.message : String(reportError),
    });
  }
};

const MAX_RUNTIME_INPUT_QUARANTINE_RECORDS = 50;
const QUARANTINABLE_RUNTIME_INPUT_ERROR_MARKERS = [
  'FINANCIAL-SAFETY:',
  'Invalid runtimeTxs:',
  'Invalid entityInputs:',
  'Too many runtime transactions:',
  'Too many entity inputs:',
  'RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET',
  'RUNTIME_REPLICA_NOT_FOUND',
  'RUNTIME_SIGNER_MISSING',
  // Exact ingress-boundary code only. The bare 'CROSS_J_'/'ORDERBOOK_'
  // prefixes also match dozens of internal invariant throws deep inside
  // entity-tx handlers (e.g. ORDERBOOK_RESIZE_CORRUPT, CROSS_J_CLEAR_
  // MATERIALIZE_PROOF_MISMATCH) that invariant-errors.ts deliberately
  // rethrows instead of skipping. A substring match here silently undid
  // that rethrow and quarantined-instead-of-halted a real consensus bug.
  'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN',
] as const;

const getRuntimeInputErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runtimeInputHasWork = (runtimeInput: RuntimeInput): boolean =>
  runtimeInput.runtimeTxs.length > 0 ||
  runtimeInput.entityInputs.length > 0 ||
  (runtimeInput.jInputs?.length ?? 0) > 0 ||
  (runtimeInput.reliableReceipts?.length ?? 0) > 0;

const getRuntimeInputQuarantineReason = (error: unknown, message: string): string | null => {
  if (error instanceof RuntimeEntityInputApplyError && error.isRemoteIngress) {
    return 'REMOTE_ENTITY_INPUT_APPLY_FAILED';
  }
  return QUARANTINABLE_RUNTIME_INPUT_ERROR_MARKERS.find(marker => message.includes(marker)) ?? null;
};

const summarizeRuntimeInputForQuarantine = (runtimeInput: RuntimeInput) => ({
  counts: {
    runtimeTxs: runtimeInput.runtimeTxs.length,
    entityInputs: runtimeInput.entityInputs.length,
    jInputs: runtimeInput.jInputs?.length ?? 0,
  },
  entityInputs: runtimeInput.entityInputs.slice(0, 10).map(input => ({
    entityId: String(input.entityId || ''),
    signerId: String(input.signerId || ''),
    txTypes: (input.entityTxs || []).slice(0, 20).map(tx => String(tx?.type || '')),
  })),
  runtimeTxTypes: runtimeInput.runtimeTxs.slice(0, 20).map(tx => String(tx?.type || '')),
  jInputs: (runtimeInput.jInputs || []).slice(0, 10).map(input => ({
    jurisdictionName: String(input.jurisdictionName || ''),
    jTxCount: input.jTxs?.length ?? 0,
  })),
});

const quarantineLiveRuntimeInput = (
  env: Env,
  runtimeInput: RuntimeInput,
  error: unknown,
  quietRuntimeLogs: boolean,
): boolean => {
  if (env.scenarioMode === true || envRecord(env)[ENV_REPLAY_MODE_KEY] === true) return false;
  if (!runtimeInputHasWork(runtimeInput)) return false;
  const message = getRuntimeInputErrorMessage(error);
  const reason = getRuntimeInputQuarantineReason(error, message);
  if (!reason) return false;

  const state = ensureRuntimeState(env);
  const summary = summarizeRuntimeInputForQuarantine(runtimeInput);
  const record = {
    id: `runtime-input-quarantine-${Math.max(0, env.height)}-${Math.max(0, env.timestamp || 0)}-${(state.quarantinedRuntimeInputs?.length ?? 0) + 1}`,
    height: Math.max(0, env.height),
    timestamp: Math.max(0, env.timestamp || 0),
    reason,
    message,
    action: 'dropped' as const,
    ...summary,
  };
  state.quarantinedRuntimeInputs = [
    ...(state.quarantinedRuntimeInputs ?? []),
    record,
  ].slice(-MAX_RUNTIME_INPUT_QUARANTINE_RECORDS);
  if (reason === 'RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN') {
    recordRuntimeSecurityIncident(env, {
      domain: 'cross-j',
      code: 'CROSS_J_REMOTE_INPUT_REJECTED',
      source: 'remote-ingress',
      severity: 'warning',
      summary: 'An untrusted cross-j input was rejected before state application',
      entityId: summary.entityInputs[0]?.entityId ?? '',
    });
  }
  const payload = {
    quarantineId: record.id,
    reason,
    action: record.action,
    message,
    ...summary,
  };
  env.error?.('system', 'RUNTIME_INPUT_QUARANTINED', payload, env.runtimeId);
  if (!quietRuntimeLogs) {
    runtimeLog.error('input.quarantined', payload);
  }
  return true;
};

class RuntimeInputQuarantinedError extends Error {
  constructor(cause: Error) {
    super(`RUNTIME_INPUT_DROPPED:${cause.message}`, { cause });
    this.name = 'RuntimeInputQuarantinedError';
  }
}

/**
 * Start the single runtime event loop. Called once on init.
 * Async while-loop — no re-entry possible by construction.
 * Returns a stop function for graceful shutdown.
 *
 * Loop cycle:
 *   1. process() — drain mempool, apply R-frame (pure E/A consensus)
 *   2. persist   — atomic LevelDB write of finalized frame
 *   3. broadcast — J-batch execution + E-output P2P dispatch (side effects)
 *   4. schedule  — optional configured delay; zero drains chained work immediately
 */
export type RuntimeLoopConfig = {
  tickDelayMs?: number;
  maxEntityInputsPerFrame?: number;
  maxEntityTxsPerFrame?: number;
};

export function startRuntimeLoop(env: Env, config?: RuntimeLoopConfig): () => void {
  if (env.scenarioMode) return () => {};
  const state = ensureRuntimeState(env);
  if (config?.maxEntityInputsPerFrame !== undefined) {
    const configuredMaxEntityInputs = Number(config.maxEntityInputsPerFrame);
    if (Number.isFinite(configuredMaxEntityInputs) && configuredMaxEntityInputs > 0) {
      state.maxEntityInputsPerFrame = Math.floor(configuredMaxEntityInputs);
    } else {
      delete state.maxEntityInputsPerFrame;
    }
  }
  if (config?.maxEntityTxsPerFrame !== undefined) {
    const configuredMaxEntityTxs = Number(config.maxEntityTxsPerFrame);
    if (Number.isFinite(configuredMaxEntityTxs) && configuredMaxEntityTxs > 0) {
      state.maxEntityTxsPerFrame = Math.floor(configuredMaxEntityTxs);
    } else {
      delete state.maxEntityTxsPerFrame;
    }
  }
  const lifecyclePhase = inferRuntimeLifecyclePhase(state);
  if (lifecyclePhase === 'halted') return state.stopLoop ?? (() => {});
  if (lifecyclePhase === 'running') return state.stopLoop ?? (() => {});
  if (lifecyclePhase === 'quiescing' && state.persistenceQuiescing) return state.stopLoop ?? (() => {});
  const runtimeLoopTickDelayMs = Math.max(0, Math.floor(Number(config?.tickDelayMs ?? 0)));
  let running = true;
  let loopPromise: Promise<void> | null = null;
  transitionRuntimeLifecycle(state, 'running');
  rebuildScheduledWakeIndex(env);
  // J-watchers are a runtime concern, not a UI/store concern.
  // The runtime loop is the single canonical owner of watcher lifecycle for
  // the current env. This keeps restored runtimes, fresh runtimes, and
  // long-lived runtimes on one obvious path:
  //   startRuntimeLoop(env) -> startJurisdictionWatchers(env) -> one poller per jReplica
  //
  // Why we do it here:
  // - restored envs need watchers restarted after process reload
  // - UI code should not decide when blockchain watchers exist
  // - watchers already guard against duplicate starts internally
  //
  // This still coexists with importJ starting the watcher for newly imported
  // jurisdictions while a loop is already running.
  startJurisdictionWatchers(env);

  const loop = async () => {
    let haltedMessage: string | null = null;
    try {
      while (running) {
        try {
          // jReplicas can appear after the loop has already started:
          // - server bootstrap wires the RPC adapter after startRuntimeLoop(env)
          // - restored/fresh runtimes can import jurisdictions later
          //
          // The runtime loop remains the single canonical owner of watcher lifecycle.
          // Re-checking here is safe because startWatching() is idempotent and guards
          // duplicate intervals internally. Do not add parallel server/UI watcher starts.
          startJurisdictionWatchers(env);
          if (hasRuntimeWork(env)) {
            const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
            if (remainingDelayMs > 0) {
              await sleep(remainingDelayMs);
              continue;
            }
            await process(env);
            // Zero configured delay means no throttling; it must not mean an
            // unbounded microtask chain that prevents WebSocket ACK delivery.
            await yieldRuntimeIoTurn();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          runtimeLog.error('loop.error', { message, ...(stack ? { stack } : {}) });
          transitionRuntimeLifecycle(state, 'halted');
          state.fatalDebugPayload = {
            message,
            ...(stack ? { stack } : {}),
            height: Math.max(0, env.height ?? 0),
            timestamp: Math.max(0, env.timestamp ?? 0),
          };
          emitRuntimeLoopError(
            env,
            'RUNTIME_LOOP_ERROR',
            {
              message,
              ...(stack ? { stack } : {}),
            },
          );
          const runtimeProcess = getRuntimeProcessGlobal();
          if (shouldExitOnRuntimeFatal(runtimeProcess) && runtimeProcess?.exit) {
            runtimeProcess.exit(1);
          }
          // Fail-fast: stop runtime loop on any unhandled runtime error.
          haltedMessage = message;
          running = false;
        }
        if (!running) break;
        if (hasRuntimeWork(env)) {
          const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
          if (remainingDelayMs > 0) {
            await sleep(remainingDelayMs);
          } else if (runtimeLoopTickDelayMs > 0) {
            // A positive operator override intentionally throttles chained work.
            await sleep(runtimeLoopTickDelayMs);
          }
          continue;
        }
        const nextDueAt = getNextWallClockWakeTimestamp(env);
        if (nextDueAt !== null) {
          const waitResult = await waitForRuntimeLoopWakeOrTimeout(
            env,
            Math.max(0, nextDueAt - getWallClockMs()),
          );
          if (waitResult === 'timeout') {
            const dueTimestamp = getEarliestWallClockDueTimestamp(env) ?? nextDueAt;
            const mempool = ensureRuntimeMempool(env);
            mempool.queuedAt =
              mempool.queuedAt === undefined
                ? dueTimestamp
                : Math.max(mempool.queuedAt, dueTimestamp);
            generateHookPings(env, dueTimestamp, dueTimestamp);
          }
          continue;
        }
        await waitForRuntimeLoopWake(env);
      }
    } finally {
      if (haltedMessage) {
        emitRuntimeLoopError(
          env,
          'RUNTIME_LOOP_HALTED',
          { message: haltedMessage },
        );
      }
      if (inferRuntimeLifecyclePhase(state) === 'running') {
        transitionRuntimeLifecycle(state, 'stopped');
      }
      state.stopLoop = null;
      if (state.loopPromise === loopPromise) state.loopPromise = null;
      state.wakeLoop = null;
      state.wakeRequested = false;
    }
  };

  loopPromise = loop(); // fire-and-forget — single async chain, never overlaps
  state.loopPromise = loopPromise;
  void loopPromise;
  state.stopLoop = () => {
    running = false;
    requestRuntimeLoopWake(env);
  };
  return state.stopLoop;
}

const waitForPromiseBeforeTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  promise.then(
    () => {
      clearTimeout(timer);
      resolve(true);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
});

export const stopRuntimeLoopAndWait = async (env: Env, timeoutMs = 10_000): Promise<boolean> => {
  const state = env.runtimeState;
  if (state && inferRuntimeLifecyclePhase(state) !== 'halted') {
    transitionRuntimeLifecycle(state, 'quiescing');
  }
  state?.stopLoop?.();
  const startedAt = Date.now();
  const loopPromise = state?.loopPromise ?? null;
  if (loopPromise) {
    const loopDone = await waitForPromiseBeforeTimeout(loopPromise, timeoutMs);
    if (!loopDone) return false;
  }
  const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
  return waitForRuntimeProcessingIdle(env, remaining);
};

export const resumeRuntimeLoop = (env: Env, config?: RuntimeLoopConfig): (() => void) => {
  const state = ensureRuntimeState(env);
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase === 'halted') throw new Error('RUNTIME_RESUME_HALTED');
  if (phase === 'running') return state.stopLoop ?? (() => {});
  if (phase === 'quiescing') {
    if (state.loopPromise || state.processingPromise) {
      throw new Error('RUNTIME_RESUME_BEFORE_QUIESCE_DRAINED');
    }
    transitionRuntimeLifecycle(state, 'stopped');
  }
  return startRuntimeLoop(env, config);
};

/**
 * Resume a runtime that was fully drained and persistence-fenced for a wallet
 * switch. The persistence fence must be removed before the loop can accept new
 * work; otherwise process() advances memory while saveRuntimeFrameToStorage()
 * intentionally skips the durable write.
 */
export const resumeRuntimeAfterPersistenceQuiesce = (
  env: Env,
  config?: RuntimeLoopConfig,
): (() => void) => {
  const state = ensureRuntimeState(env);
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase === 'halted') throw new Error('RUNTIME_RESUME_HALTED');
  if (phase === 'running' && (state.persistencePaused || state.persistenceQuiescing)) {
    throw new Error('RUNTIME_DURABLE_RESUME_RUNNING_WITH_PERSISTENCE_FENCE');
  }
  if (phase === 'running') return state.stopLoop ?? (() => {});
  if (state.processingPromise || state.loopPromise) {
    throw new Error('RUNTIME_DURABLE_RESUME_BEFORE_QUIESCE_DRAINED');
  }
  state.persistencePaused = false;
  state.persistenceQuiescing = false;
  return resumeRuntimeLoop(env, config);
};

export const waitForRuntimeWorkDrained = async (
  env: Env,
  timeoutMs = 10_000,
  quietMs = 250,
  options: { allowPersistencePaused?: boolean } = {},
): Promise<boolean> => {
  const startedAt = Date.now();
  let idleSince: number | null = null;
  requestRuntimeLoopWake(env);
  while (true) {
    const now = Date.now();
    const remaining = timeoutMs - (now - startedAt);
    if (remaining <= 0) return false;

    const processing = env.runtimeState?.processingPromise ?? null;
    if (processing) {
      const completed = await Promise.race([
        processing.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.min(remaining, 250))),
      ]);
      if (!completed) continue;
    }

    const hasWork = hasRuntimeWork(env) || Boolean(env.runtimeState?.processingPromise);
    if (!hasWork) {
      const idleAt = Date.now();
      idleSince ??= idleAt;
      if (idleAt - idleSince >= quietMs) return true;
      await sleep(Math.min(25, quietMs - (idleAt - idleSince)));
      continue;
    }

    idleSince = null;
    const state = ensureRuntimeState(env);
    if (state.persistencePaused && !options.allowPersistencePaused) {
      throw new Error('RUNTIME_WORK_DRAIN_PERSISTENCE_PAUSED');
    }
    if (inferRuntimeLifecyclePhase(state) === 'halted') {
      throw new Error('RUNTIME_WORK_DRAIN_HALTED');
    }
    if (!state.loopPromise && !state.processingPromise) {
      const remainingDelayMs = getRemainingRuntimeFrameDelayMs(env);
      if (remainingDelayMs > 0) {
        await sleep(Math.min(remaining, remainingDelayMs, 25));
        continue;
      }
      // An inactive runtime can still contain work accepted before the
      // persistence fence (for example, a J observation queued immediately
      // before a wallet switch). Drain it through the one canonical runtime
      // transition instead of dropping it or resurrecting external ingress.
      await process(env);
      continue;
    }
    requestRuntimeLoopWake(env);
    await sleep(10);
  }
};

export const startJurisdictionWatchers = (env: Env): void => {
  // Quiesce closes ingress before it drains accepted work. The still-running
  // runtime loop may reach this function once more while draining; it must not
  // resurrect a watcher that quiesce has already stopped.
  if (env.runtimeState?.persistenceQuiescing) return;
  if (!env.jReplicas || env.jReplicas.size === 0) return;
  const watcherOwners = new Map<string, JAdapter>();
  const providerUrlOf = (adapter: JAdapter, replica: JReplica): string => {
    const configured = replica.rpcs?.find((rpc) => typeof rpc === 'string' && rpc.trim().length > 0);
    if (configured) return configured.trim();
    const providerWithConnection = adapter.provider as Provider & {
      _getConnection?: () => { url?: string };
    };
    return String(providerWithConnection?._getConnection?.()?.url || '').trim();
  };
  const watcherKeyOf = (replica: JReplica): string | null => {
    const adapter = replica.jadapter;
    if (!adapter) return null;
    const depository = String(replica.depositoryAddress || replica.contracts?.depository || '').trim().toLowerCase();
    const chainId = String(replica.chainId ?? adapter.chainId ?? '');
    if (adapter.mode === 'browservm') {
      return `browservm:${chainId}:${depository || replica.name}`;
    }
    const rpcUrl = providerUrlOf(adapter, replica).toLowerCase();
    return `rpc:${chainId}:${rpcUrl}:${depository || replica.name}`;
  };
  for (const [name, jReplica] of env.jReplicas.entries()) {
    const adapter = jReplica.jadapter;
    if (!adapter) continue;
    const watcherKey = watcherKeyOf(jReplica);
    const owner = watcherKey ? watcherOwners.get(watcherKey) : undefined;
    if (owner) {
      if (owner !== adapter && adapter.isWatching()) {
        adapter.stopWatching();
        runtimeLog.warn('jadapter_watcher.duplicate_stopped', { jurisdictionName: name, watcherKey });
      }
      continue;
    }
    if (watcherKey) {
      watcherOwners.set(watcherKey, adapter);
    }
    if (adapter.isWatching()) continue;
    adapter.startWatching(env);
    runtimeLog.debug('jadapter_watcher.started', { jurisdictionName: name, watcherKey });
  }
};

export const stopJurisdictionWatchers = (env: Env): void => {
  if (!env.jReplicas || env.jReplicas.size === 0) return;
  for (const [name, jReplica] of env.jReplicas.entries()) {
    const adapter = jReplica.jadapter;
    if (!adapter?.isWatching()) continue;
    try {
      adapter.stopWatching();
    } catch (error) {
      runtimeLog.warn('jadapter_watcher.stop_failed', {
        jurisdictionName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

export const stopJurisdictionWatchersAndWait = async (env: Env): Promise<void> => {
  if (!env.jReplicas || env.jReplicas.size === 0) return;
  const adapters = new Map<JAdapter, string[]>();
  for (const [name, jReplica] of env.jReplicas.entries()) {
    const adapter = jReplica.jadapter;
    if (!adapter) continue;
    const names = adapters.get(adapter) ?? [];
    names.push(name);
    adapters.set(adapter, names);
  }

  const stops = Array.from(adapters, ([adapter, names]) => {
    const wrapFailure = (error: unknown): Error =>
      new Error(
        `JADAPTER_WATCHER_DRAIN_FAILED:${names.join(',')}:${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    try {
      return adapter.stopWatchingAndWait().catch((error: unknown) => {
        throw wrapFailure(error);
      });
    } catch (error) {
      return Promise.reject(wrapFailure(error));
    }
  });
  const settled = await Promise.allSettled(stops);
  throwSettledErrors(settled, 'JADAPTER_WATCHER_DRAIN_FAILED');
};

const detachRuntimeEnv = (env: Env): void => {
  const state = env.runtimeState;
  stopJurisdictionWatchers(env);
  state?.stopLoop?.();
  if (state) {
    try {
      state.runtimeSyncChannel?.close();
    } finally {
      state.runtimeSyncChannel = null;
    }
    state.lastP2PConfig = null;
    state.pendingP2PConfig = null;
    state.directEntityInputsDispatch = null;
    state.loopPromise = null;
    state.stopLoop = null;
    state.wakeLoop = null;
    state.wakeRequested = false;
    if (inferRuntimeLifecyclePhase(state) !== 'halted') {
      transitionRuntimeLifecycle(state, 'stopped');
    }
  }
  deleteScheduledWakeIndex(env);
};

/**
 * Identity function for env (no module-level env exists).
 */
export const getEnv = (env?: Env | null): Env | null => {
  if (!env) {
    runtimeLog.warn('env.missing');
    return null;
  }
  return env;
};

export const setRuntimeId = (env: Env, id: string | null): void => {
  const normalizedRuntimeId = normalizeRuntimeId(id);
  if (normalizedRuntimeId) env.runtimeId = normalizedRuntimeId;
  else delete env.runtimeId;
  if (env.runtimeId) {
    env.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  startPendingRuntimeP2PIfReady(env, getRuntimeP2PLifecycleDeps());
};

// Derive runtimeId from seed (for isolated envs that need to set their own runtimeId)
export const deriveRuntimeId = (seed: string): string => {
  return normalizeRuntimeId(deriveSignerAddressSync(seed, '1'));
};

// scheduleNetworkProcess removed — loop is always-on via startRuntimeLoop()

export const registerEntityRuntimeHint = (env: Env, entityId: string, runtimeId: string): void => {
  registerEntityRuntimeHintForRouting(env, entityId, runtimeId, getRuntimeEntityRoutingDeps());
};

export const MAX_RUNTIME_FRAME_INGRESS_ENTRIES = 1_024;
export const MAX_RUNTIME_FRAME_INGRESS_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_J_INPUTS = 256;
export const MAX_RUNTIME_J_TXS = 1_024;
export const MAX_RUNTIME_J_TXS_PER_JURISDICTION = 512;
export const MAX_RUNTIME_J_INPUT_BYTES = 1024 * 1024;

const validateRuntimeJIngressLimits = (env: Env, runtimeInput: RuntimeInput): void => {
  if (runtimeInput.jInputs === undefined) return;
  if (!Array.isArray(runtimeInput.jInputs)) {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Invalid jInputs: expected array, got ${typeof runtimeInput.jInputs}`);
  }
  if (runtimeInput.jInputs.length > MAX_RUNTIME_J_INPUTS) {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Too many J inputs: ${runtimeInput.jInputs.length} > ${MAX_RUNTIME_J_INPUTS}`);
  }
  let totalTxs = 0;
  let totalBytes = 0;
  const txsByJurisdiction = new Map<string, number>();
  for (const [index, input] of runtimeInput.jInputs.entries()) {
    if (!input || !Array.isArray(input.jTxs)) {
      throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Invalid J input at index ${index}`);
    }
    const jurisdictionName = String(input.jurisdictionName || '');
    if (!env.jReplicas?.has(jurisdictionName)) {
      throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Unknown J jurisdiction: ${jurisdictionName}`);
    }
    totalTxs += input.jTxs.length;
    if (totalTxs > MAX_RUNTIME_J_TXS) {
      throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Too many J transactions: ${totalTxs} > ${MAX_RUNTIME_J_TXS}`);
    }
    const jurisdictionTxs = (txsByJurisdiction.get(jurisdictionName) ?? 0) + input.jTxs.length;
    if (jurisdictionTxs > MAX_RUNTIME_J_TXS_PER_JURISDICTION) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Too many J transactions for ${jurisdictionName}: ` +
        `${jurisdictionTxs} > ${MAX_RUNTIME_J_TXS_PER_JURISDICTION}`,
      );
    }
    txsByJurisdiction.set(jurisdictionName, jurisdictionTxs);
    totalBytes += new TextEncoder().encode(safeStringify(input)).byteLength;
    if (totalBytes > MAX_RUNTIME_J_INPUT_BYTES) {
      throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: J payload too large: ${totalBytes} > ${MAX_RUNTIME_J_INPUT_BYTES}`);
    }
  }
};

type AccountedRuntimeFrameIngressBuffer = RuntimeFrameIngressBuffer & { byteLength: number };
type RuntimeFrameIngressEntry = RuntimeFrameIngressBuffer['entries'][number];

const beginRuntimeFrameIngressBuffer = (env: Env): AccountedRuntimeFrameIngressBuffer => {
  const state = ensureRuntimeState(env);
  if (state.runtimeFrameIngressBuffer) {
    throw new Error(
      `RUNTIME_FRAME_INGRESS_BUFFER_ALREADY_ACTIVE:${state.runtimeFrameIngressBuffer.status}`,
    );
  }
  const buffer: AccountedRuntimeFrameIngressBuffer = {
    status: 'active',
    entries: [],
    byteLength: 0,
  };
  state.runtimeFrameIngressBuffer = buffer;
  return buffer;
};

const getRuntimeFrameIngressBuffer = (env: Env): AccountedRuntimeFrameIngressBuffer | undefined => {
  const buffer = env.runtimeState?.runtimeFrameIngressBuffer;
  if (buffer && buffer.status !== 'active') {
    throw new Error(`RUNTIME_FRAME_INGRESS_BUFFER_INVALID_LIFECYCLE:${buffer.status}`);
  }
  if (!buffer) return undefined;
  const accounted = buffer as AccountedRuntimeFrameIngressBuffer;
  if (!Number.isSafeInteger(accounted.byteLength) || accounted.byteLength < 0) {
    throw new Error(
      `RUNTIME_FRAME_INGRESS_BUFFER_BYTE_LENGTH_INVALID:${String(accounted.byteLength)}`,
    );
  }
  return accounted;
};

const appendRuntimeFrameIngress = (
  buffer: AccountedRuntimeFrameIngressBuffer,
  entry: RuntimeFrameIngressEntry,
): void => {
  const currentCount = buffer.entries.length;
  if (currentCount >= MAX_RUNTIME_FRAME_INGRESS_ENTRIES) {
    throw new Error(
      `RUNTIME_FRAME_INGRESS_CAPACITY_EXCEEDED:dimension=count:` +
        `current=${currentCount}:incoming=1:max=${MAX_RUNTIME_FRAME_INGRESS_ENTRIES}`,
    );
  }
  const incomingBytes = new TextEncoder().encode(safeStringify(entry)).byteLength;
  if (
    incomingBytes > MAX_RUNTIME_FRAME_INGRESS_BYTES ||
    buffer.byteLength > MAX_RUNTIME_FRAME_INGRESS_BYTES - incomingBytes
  ) {
    throw new Error(
      `RUNTIME_FRAME_INGRESS_CAPACITY_EXCEEDED:dimension=bytes:` +
        `current=${buffer.byteLength}:incoming=${incomingBytes}:max=${MAX_RUNTIME_FRAME_INGRESS_BYTES}`,
    );
  }
  const cloned = structuredClone(entry);
  buffer.entries.push(cloned);
  buffer.byteLength += incomingBytes;
};

export const handleInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  ingressTimestamp?: number,
) => {
  const deps = getRuntimeEntityRoutingDeps();
  const buffered = getRuntimeFrameIngressBuffer(env);
  if (!buffered) return routeInboundP2PEntityInput(env, from, input, deps, ingressTimestamp);
  const validation = validateInboundP2PEntityInput(env, from, input, deps);
  if (validation.kind === 'ignored') return validation;
  appendRuntimeFrameIngress(buffered, {
    kind: 'entity',
    from,
    input,
    ...(ingressTimestamp === undefined ? {} : { ingressTimestamp }),
  });
  return { kind: 'queued' } as const;
};

export const handleInboundP2PEntityInputs = (
  env: Env,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp?: number,
) => {
  const deps = getRuntimeEntityRoutingDeps();
  const buffered = getRuntimeFrameIngressBuffer(env);
  if (!buffered) {
    return routeInboundP2PEntityInputs(env, from, envelope, deps, ingressTimestamp);
  }
  validateInboundP2PEntityInputsEnvelope(env, from, envelope, deps);
  appendRuntimeFrameIngress(buffered, {
    kind: 'entity-inputs',
    from,
    envelope,
    ...(ingressTimestamp === undefined ? {} : { ingressTimestamp }),
  });
  return { kind: 'queued' as const, receipts: [] as ReliableDeliveryReceipt[] };
};

export const handleInboundReliableReceipt = (
  env: Env,
  from: string,
  receipt: ReliableDeliveryReceipt,
  options: RuntimeInboundEntityInputOptions = {},
): 'queued' | 'duplicate' | 'deferred' => {
  const sourceRuntimeId = normalizeRuntimeId(from);
  if (!sourceRuntimeId || sourceRuntimeId !== receipt?.body?.receiverRuntimeId) {
    throw new Error('RELIABLE_RECEIPT_TRANSPORT_SOURCE_MISMATCH');
  }
  if (
    env.runtimeState?.persistenceQuiescing &&
    !env.scenarioMode &&
    options.acceptedBeforeQuiesce !== true
  ) {
    // This is a normal persistence boundary, not malformed peer input. The
    // original reliable output remains pending and will recreate this exact
    // signed receipt on retry, so rejecting it as a transport error only
    // creates false browser noise (and a useless debug-event/error loop).
    env.info('network', 'RELIABLE_RECEIPT_DEFERRED_QUIESCING', {
      sourceRuntimeId,
      receiverRuntimeId: receipt.body.receiverRuntimeId,
      identity: receipt.body.identity,
    });
    return 'deferred';
  }
  const registration = registerReliableReceiptIngress(env, receipt);
  if (receipt.body.identity.kind === 'account-ack') {
    runtimeLog.info('reliable.account_receipt.ingress', {
      fromRuntimeId: sourceRuntimeId,
      height: receipt.body.identity.height,
      coverage: receipt.body.coverage,
      registration,
      buffered: Boolean(getRuntimeFrameIngressBuffer(env)),
    });
  }
  if (registration === 'duplicate') return 'duplicate';
  const buffered = getRuntimeFrameIngressBuffer(env);
  if (buffered) {
    appendRuntimeFrameIngress(buffered, { kind: 'receipt', from, receipt });
    return 'queued';
  }
  enqueueRuntimeInputs(
    env,
    undefined,
    undefined,
    undefined,
    env.timestamp,
    [receipt],
    options,
  );
  return 'queued';
};

const dispatchRuntimeReliableReceipt = (
  env: Env,
  runtimeId: string,
  receipt: ReliableDeliveryReceipt,
): void => {
  const state = ensureRuntimeState(env);
  const directResult = state.directReliableReceiptDispatch?.(runtimeId, receipt);
  const result = directResult && isDeliveryDelivered(directResult)
    ? directResult
    : getP2P(env)?.enqueueReliableReceiptDelivery(runtimeId, receipt) ?? directResult;
  if (!result || !isDeliveryDelivered(result)) {
    env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
      targetRuntimeId: runtimeId,
      delivery: result ?? null,
    });
  }
};

export const describeRuntimeFrameIngressErrors = (errors: readonly Error[]): string =>
  errors
    .map((error, index) => `${index + 1}/${errors.length}:${error.name}:${error.message}`)
    .join('|');

const drainRuntimeFrameIngressBuffer = (transaction: RuntimeFrameTransaction): void => {
  const env = transaction.liveEnv;
  const state = ensureRuntimeState(env);
  const buffered = transaction.ingressBuffer;
  if (state.runtimeFrameIngressBuffer !== buffered) {
    throw new Error('RUNTIME_FRAME_INGRESS_BUFFER_OWNERSHIP_MISMATCH');
  }
  if (buffered.status !== 'active') {
    throw new Error(`RUNTIME_FRAME_INGRESS_BUFFER_INVALID_DRAIN:${buffered.status}`);
  }
  buffered.status = 'draining';
  delete state.runtimeFrameIngressBuffer;
  const entries = buffered.entries;
  buffered.entries = [];
  (buffered as AccountedRuntimeFrameIngressBuffer).byteLength = 0;
  const deps = getRuntimeEntityRoutingDeps();
  const errors: Error[] = [];
  try {
    for (const ingress of entries) {
      try {
        if (ingress.kind === 'receipt') {
          handleInboundReliableReceipt(
            env,
            ingress.from,
            ingress.receipt,
            { acceptedBeforeQuiesce: true },
          );
          continue;
        }
        if (ingress.kind === 'entity') {
          const result = routeInboundP2PEntityInput(
            env,
            ingress.from,
            ingress.input,
            deps,
            ingress.ingressTimestamp,
            { acceptedBeforeQuiesce: true },
          );
          if (result.kind === 'receipt') {
            dispatchRuntimeReliableReceipt(env, ingress.from, result.receipt);
          }
          continue;
        }
        const result = routeInboundP2PEntityInputs(
          env,
          ingress.from,
          ingress.envelope,
          deps,
          ingress.ingressTimestamp,
          { acceptedBeforeQuiesce: true },
        );
        for (const receipt of result.receipts) {
          dispatchRuntimeReliableReceipt(env, ingress.from, receipt);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  } finally {
    buffered.status = 'closed';
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `RUNTIME_FRAME_INGRESS_DRAIN_FAILED:${describeRuntimeFrameIngressErrors(errors)}`,
    );
  }
};

const getRuntimeNowMs = (env: Env): number => env.timestamp ?? 0;

const normalizeRuntimeEntityInput = (_env: Env, input: EntityInput, _context: string): RoutedEntityInput => {
  const signerId = input.signerId.trim();
  failfastAssert(
    signerId.length > 0,
    'RUNTIME_ENTITY_INPUT_SIGNER_MISSING',
    'EntityInput signerId must be resolved before enqueue/process',
    { entityId: input.entityId },
  );
  return {
    ...input,
    signerId,
  };
};

const hasLocalSignerForEntity = (env: Env, entityId: string): boolean => {
  return getLocalSignerIdsForEntity(env, entityId).length > 0;
};

const getLocalSignerIdsForEntity = (env: Env, entityId: string): string[] => {
  const targetEntityId = String(entityId || '').toLowerCase();
  const signerIds = new Set<string>();
  for (const replicaKey of env.eReplicas.keys()) {
    const replicaEntityId = extractEntityId(replicaKey).toLowerCase();
    const signerId = extractSignerId(replicaKey);
    if (replicaEntityId !== targetEntityId || !signerId) continue;
    if (getSignerPrivateKeyIfAvailable(env, signerId) !== null) signerIds.add(signerId);
  }
  return [...signerIds];
};

const hasLocalSignerForEntitySigner = (env: Env, entityId: string, signerId: string): boolean => {
  const targetSignerId = String(signerId || '').toLowerCase();
  if (!targetSignerId) return false;
  return getLocalSignerIdsForEntity(env, entityId)
    .some(localSignerId => localSignerId.toLowerCase() === targetSignerId);
};

const resolveSoleLocalSignerForEntity = (env: Env, entityId: string): string | null => {
  const signerIds = getLocalSignerIdsForEntity(env, entityId);
  return signerIds.length === 1 ? signerIds[0]! : null;
};

export const validateRuntimeInputAdmission = (env: Env, runtimeInput: RuntimeInput): void => {
  if (!runtimeInput) {
    throw new Error('RUNTIME_INPUT_ADMISSION_REJECTED: Null runtime input provided');
  }
  if (!Array.isArray(runtimeInput.runtimeTxs)) {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
  }
  if (!Array.isArray(runtimeInput.entityInputs)) {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
  }
  if (runtimeInput.reliableReceipts !== undefined && !Array.isArray(runtimeInput.reliableReceipts)) {
    throw new Error(
      `RUNTIME_INPUT_ADMISSION_REJECTED: Invalid reliableReceipts: expected array, got ${typeof runtimeInput.reliableReceipts}`,
    );
  }
  validateRuntimeJIngressLimits(env, runtimeInput);
  if (runtimeInput.runtimeTxs.length > 1000) {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`);
  }
  if (runtimeInput.entityInputs.length > 10000) {
    throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`);
  }
  if ((runtimeInput.reliableReceipts?.length ?? 0) > 10000) {
    throw new Error(
      `RUNTIME_INPUT_ADMISSION_REJECTED: Too many reliable receipts: ${runtimeInput.reliableReceipts!.length} > 10000`,
    );
  }
  const pendingNetworkOutputs = env.pendingNetworkOutputs?.length ?? 0;
  const hasNewLocalFinancialCommand = runtimeInputRequiresOutboxCapacity(runtimeInput.entityInputs);
  if (pendingNetworkOutputs >= MAX_PENDING_NETWORK_OUTPUTS && hasNewLocalFinancialCommand) {
    throw new Error(
      `RUNTIME_INPUT_ADMISSION_REJECTED: NETWORK_OUTBOX_BACKPRESSURE ` +
      `pending=${pendingNetworkOutputs} max=${MAX_PENDING_NETWORK_OUTPUTS}`,
    );
  }
  const importedReplicaSigners = new Map<string, Set<string>>();
  for (const runtimeTx of runtimeInput.runtimeTxs) {
    if (runtimeTx.type !== 'importReplica') continue;
    const entityId = String(runtimeTx.entityId || '').toLowerCase();
    const signerId = String(runtimeTx.signerId || '').trim();
    if (!entityId || !signerId) continue;
    const signers = importedReplicaSigners.get(entityId) ?? new Set<string>();
    signers.add(signerId);
    importedReplicaSigners.set(entityId, signers);
  }

  runtimeInput.entityInputs.forEach((input, index) => {
    for (const tx of input.entityTxs ?? []) assertScheduledWakeTxAuthorized(tx, false);
    const validated = normalizeRuntimeEntityInput(env, validateEntityInput(input), `runtimeInput[${index}]`);
    const localSignerIds = [
      ...getLocalSignerIdsForEntity(env, validated.entityId),
      ...(importedReplicaSigners.get(String(validated.entityId || '').toLowerCase()) ?? []),
    ];
    if (localSignerIds.length === 0) {
      throw new Error(
        `RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET: Entity input target does not exist in local runtime ` +
        safeStringify({
          index,
          entityId: validated.entityId,
          signerId: validated.signerId,
          txTypes: (validated.entityTxs || []).map(tx => tx.type),
        }),
      );
    }
    if (
      hasLocalSignerForEntitySigner(env, validated.entityId, validated.signerId) ||
      localSignerIds.some(signerId => signerId.toLowerCase() === validated.signerId.toLowerCase())
    ) return;
    const txTypes = (validated.entityTxs || []).map(tx => tx.type);
    if (localSignerIds.length === 1 && txTypes.length === 0) return;
    throw new Error(
      `RUNTIME_REPLICA_NOT_FOUND: Entity input target replica missing for exact signerId ` +
      safeStringify({
        index,
        entityId: validated.entityId,
        inputSignerId: validated.signerId,
        localSignerIds,
        txTypes,
      }),
    );
  });
};

function getRuntimeEntityRoutingDeps(): RuntimeEntityRoutingDeps {
  return {
    ensureRuntimeState,
    enqueueRuntimeInputs: (env, inputs, runtimeTxs, jInputs, ingressTimestamp, options) =>
      enqueueRuntimeInputs(
        env,
        inputs,
        runtimeTxs,
        jInputs,
        ingressTimestamp,
        undefined,
        options,
      ),
    extractEntityId,
    hasLocalSignerForEntity,
    hasLocalSignerForEntitySigner,
    resolveSoleLocalSignerForEntity,
    getP2P,
  };
}

function getRuntimeOutputRoutingDeps(): RuntimeOutputRoutingDeps {
  return createRuntimeOutputRoutingDeps(getRuntimeEntityRoutingDeps());
}

function getRuntimeP2PLifecycleDeps(): RuntimeP2PLifecycleDeps {
  return {
    ensureRuntimeState,
    notifyEnvChange,
    enqueueRuntimeInputs: (env, inputs) => enqueueRuntimeInputs(env, inputs),
    handleInboundP2PEntityInputs,
    handleInboundReliableReceipt,
  };
}

export const sendEntityInput = (
  env: Env,
  input: RoutedEntityInput,
): RuntimeEntityInputRoutingResult => {
  return sendEntityInputWithRouting(env, input, getRuntimeOutputRoutingDeps());
};

export const startP2P = (env: Env, config: P2PConfig = {}) =>
  startRuntimeP2P(env, config, getRuntimeP2PLifecycleDeps());

export const stopP2P = (env: Env): void =>
  stopRuntimeP2P(env, getRuntimeP2PLifecycleDeps());

export const stopP2PAndWait = (env: Env, timeoutMs?: number): Promise<void> =>
  stopRuntimeP2PAndWait(env, getRuntimeP2PLifecycleDeps(), timeoutMs);

export const getP2P = (env: Env) =>
  getRuntimeP2P(env, getRuntimeP2PLifecycleDeps());

export const getP2PState = (env: Env): P2PConnectionState =>
  getRuntimeP2PState(env, getRuntimeP2PLifecycleDeps());

export const refreshGossip = (env: Env): void =>
  refreshRuntimeGossip(env, getRuntimeP2PLifecycleDeps());

export const ensureGossipProfiles = async (env: Env, entityIds: string[]): Promise<boolean> =>
  ensureRuntimeGossipProfiles(env, getRuntimeP2PLifecycleDeps(), entityIds);

export const clearGossip = async (
  env: Env,
  options: { runtimeId?: string } = {},
): Promise<void> => {
  // Restoring infra gossip announces every loaded profile and queues its
  // LevelDB write. Drain those puts before deleting the relocated route or a
  // late put can resurrect the old signed endpoint after the clear completes.
  await drainInfraDbWrites(env);
  await clearInfraGossipProfiles(env, infraGossipDbAccess, options);
  const targetRuntimeId = String(options.runtimeId || '').trim().toLowerCase();
  if (!targetRuntimeId) {
    env.gossip?.profiles?.clear();
  } else {
    for (const [entityId, profile] of env.gossip?.profiles ?? []) {
      if (String(profile.runtimeId || '').trim().toLowerCase() === targetRuntimeId) {
        env.gossip.profiles.delete(entityId);
      }
    }
  }
  notifyEnvChange(env);
};

/**
 * Create a runtime environment for frontend initialization.
 */
export const initEnv = (seed?: string | null): Env => {
  return createEmptyEnv(seed ?? null);
};

const notifyEnvChange = (env: Env) => {
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

const notifyRuntimeFrameCommitted = (
  env: Env,
  runtimeInput: RuntimeInput,
): void => {
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

/**
 * Process any pending j-events after j-block finalization
 * Called automatically after each BrowserVM batch execution
 * This is the R-machine routing j-events from jReplicas to eReplicas
 */
export const processJBlockEvents = async (env: Env): Promise<void> => {
  if (!env) {
    runtimeLog.warn('jblock.env_missing');
    return;
  }

  const mempool = ensureRuntimeMempool(env);
  const pending = mempool.entityInputs.length;
  if (pending === 0) return;

  runtimeLog.debug('jblock.queued', { pending });
};

const crossJPairIndexesThatDidNotCommit = (
  env: Env,
  pairs: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'],
  outcomes: Awaited<ReturnType<typeof applyMergedEntityInputs>>['inputOutcomes'],
): Set<number> => {
  const committed = new Set(outcomes
    .filter(entry => entry.outcome.kind === 'committed' && entry.entityFrameCommitted)
    .map(entry => entry.inputIndex));
  return new Set(pairs
    .filter(pair =>
      !committed.has(pair.sourceInputIndex) ||
      !committed.has(pair.targetInputIndex) ||
      !crossJAccountFrameMatches(env, pair.sourceAccountFrame) ||
      !crossJAccountFrameMatches(env, pair.targetAccountFrame))
    .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]));
};

const crossJAccountFrameMatches = (
  env: Env,
  expected: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'][number]['sourceAccountFrame'],
): boolean => {
  const replica = [...env.eReplicas.values()].find(candidate =>
    candidate.entityId.toLowerCase() === expected.entityId.toLowerCase() &&
    candidate.signerId.toLowerCase() === expected.signerId.toLowerCase());
  const account = [...(replica?.state.accounts.entries() ?? [])].find(([counterpartyId]) =>
    counterpartyId.toLowerCase() === expected.counterpartyEntityId.toLowerCase())?.[1];
  return account?.currentFrame.height === expected.height &&
    String(account.currentFrame.stateHash || '').toLowerCase() === expected.stateHash.toLowerCase();
};

const markCommittedCrossJAtomicAckOutputs = (
  outputs: RoutedEntityInput[],
  pairs: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'],
): void => {
  for (const pair of pairs) {
    if (pair.phase !== 'proposal') continue;
    const expectedFrames = [pair.sourceAccountFrame, pair.targetAccountFrame];
    const matched = expectedFrames.map(expected => outputs.filter(output =>
      output.entityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
      getEffectiveEntityInputTxs(output).some(tx => {
        if (tx.type !== 'accountInput') return false;
        const ack = accountInputAck(tx.data);
        return Boolean(
          ack &&
          tx.data.fromEntityId.toLowerCase() === expected.entityId.toLowerCase() &&
          tx.data.toEntityId.toLowerCase() === expected.counterpartyEntityId.toLowerCase() &&
          ack.height === expected.height &&
          String(ack.frameHash || '').toLowerCase() === expected.stateHash.toLowerCase()
        );
      })));
    if (matched.some(candidates => candidates.length !== 1) || matched[0]![0] === matched[1]![0]) {
      throw new Error(`RUNTIME_CROSS_J_ATOMIC_ACK_OUTPUTS_INVALID:${pair.pairKey}`);
    }
    for (const output of [matched[0]![0]!, matched[1]![0]!]) {
      output.atomicCrossJurisdictionPair = { phase: 'ack', pairKey: pair.pairKey };
    }
  }
};

const summarizeCrossJAccountInput = (input: RoutedEntityInput, inputIndex: number) => ({
  inputIndex,
  entityId: input.entityId,
  signerId: input.signerId,
  fromRuntimeId: input.from ?? '',
  sourceRuntimeFrame: input.sourceRuntimeFrame ?? null,
  accountInputs: getEffectiveEntityInputTxs(input).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const ack = accountInputAck(tx.data);
    const proposal = accountInputProposal(tx.data);
    const crossPulls = proposal?.frame.accountTxs.flatMap(accountTx => {
      if (accountTx.type !== 'pull_lock' || !accountTx.data.crossJurisdiction) return [];
      return [{
        leg: accountTx.data.crossJurisdiction.leg,
        orderId: accountTx.data.crossJurisdiction.orderId,
        routeHash: accountTx.data.crossJurisdiction.routeHash,
      }];
    }) ?? [];
    return [{
      kind: tx.data.kind,
      fromEntityId: tx.data.fromEntityId,
      toEntityId: tx.data.toEntityId,
      ackHeight: ack?.height ?? null,
      proposalHeight: proposal?.frame.height ?? null,
      crossPulls,
    }];
  }),
});

export const prepareAtomicCrossJAccountInputs = async (
  env: Env,
  inputs: readonly RoutedEntityInput[],
  initialJOutbox: JInput[],
  isReplay: boolean,
  routingDeps: RuntimeEntityRoutingDeps,
): Promise<{
  inputs: RoutedEntityInput[];
  pairs: ReturnType<typeof selectMatchedCrossJAccountInputPairs>['pairs'];
}> => {
  let selectionEnv = env;
  let initial = selectMatchedCrossJAccountInputPairs(selectionEnv, inputs);
  if (initial.droppedInputIndexes.length > 0) {
    const potentialPairs = selectPotentialCrossJAccountInputPairs(inputs);
    const potentialIndexes = new Set(potentialPairs
      .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]));
    const causalPrefixInputs = inputs.filter((_input, inputIndex) => !potentialIndexes.has(inputIndex));
    if (potentialPairs.length > 0 && causalPrefixInputs.length > 0) {
      const causalPreviewEnv = cloneRuntimeFrameWorkingEnv(env);
      await applyMergedEntityInputs(causalPreviewEnv, causalPrefixInputs, initialJOutbox, {
        isReplay,
        routingDeps,
      });
      const staged = selectMatchedCrossJAccountInputPairs(causalPreviewEnv, inputs);
      if (staged.droppedInputIndexes.length < initial.droppedInputIndexes.length) {
        selectionEnv = causalPreviewEnv;
        initial = staged;
        env.info('network', 'CROSS_J_ACCOUNT_PAIR_CAUSAL_PREFIX_STAGED', {
          prefixInputCount: causalPrefixInputs.length,
          pairCount: staged.pairs.length,
        });
      }
    }
  }
  if (initial.pairs.length > 0) {
    runtimeLog.info('crossj.atomic_pair_preflight', {
      inputCount: inputs.length,
      pairCount: initial.pairs.length,
      pairs: initial.pairs.map(pair => ({
        sourceInputIndex: pair.sourceInputIndex,
        targetInputIndex: pair.targetInputIndex,
        sourceHeight: pair.sourceAccountFrame.height,
        targetHeight: pair.targetAccountFrame.height,
      })),
    });
  }
  if (initial.droppedInputIndexes.length > 0) {
    if (isReplay) throw new Error('RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_INVALID');
    const droppedInputs = initial.droppedInputIndexes.map(inputIndex =>
      summarizeCrossJAccountInput(inputs[inputIndex]!, inputIndex));
    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH', {
      received: inputs.length,
      droppedInputIndexes: initial.droppedInputIndexes,
      // Keep one flat canonical string: Bun's structured console formatter
      // collapses nested objects to `[Object ...]`, which destroyed the exact
      // ACK/proposal/frame evidence needed to diagnose a rejected money leg.
      inputSummary: safeStringify(inputs.map(summarizeCrossJAccountInput)),
    });
    for (const dropped of droppedInputs) {
      recordRuntimeSecurityIncident(env, {
        domain: 'cross-j',
        code: 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH',
        source: 'remote-ingress',
        severity: 'warning',
        summary: 'A cross-j Account leg arrived without its exact atomic sibling leg and was ignored',
        entityId: dropped.entityId,
      });
    }
  }
  let retained = initial.inputs;
  for (let attempt = 0; attempt <= initial.pairs.length; attempt += 1) {
    const selection = selectMatchedCrossJAccountInputPairs(selectionEnv, retained);
    if (selection.droppedInputIndexes.length > 0) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_SELECTION_UNSTABLE');
    }
    if (isReplay || selection.pairs.length === 0) return selection;
    const previewEnv = cloneRuntimeFrameWorkingEnv(env);
    let failedIndexes: Set<number>;
    try {
      const preview = await applyMergedEntityInputs(previewEnv, selection.inputs, initialJOutbox, {
        isReplay: false,
        routingDeps,
      });
      failedIndexes = crossJPairIndexesThatDidNotCommit(
        previewEnv,
        selection.pairs,
        preview.inputOutcomes,
      );
    } catch (error) {
      if (!(error instanceof RuntimeEntityInputApplyError) || !error.isRemoteIngress) throw error;
      const failedInputIndex = selection.inputs.findIndex(input =>
        input.entityId.toLowerCase() === error.entityId.toLowerCase() &&
        input.signerId.toLowerCase() === error.signerId.toLowerCase() &&
        String(input.from ?? '').trim().toLowerCase() === error.sourceRuntimeId.toLowerCase() &&
        input.sourceRuntimeFrame?.height === error.sourceRuntimeHeight &&
        input.sourceRuntimeFrame?.timestamp === error.sourceRuntimeTimestamp);
      const failedPair = selection.pairs.find(pair =>
        pair.sourceInputIndex === failedInputIndex || pair.targetInputIndex === failedInputIndex);
      // Only the exact two-leg remote cohort is soft-rejected. A tempting
      // catch-all here would hide an unrelated Runtime/Entity invariant failure.
      if (!failedPair) throw error;
      failedIndexes = new Set([failedPair.sourceInputIndex, failedPair.targetInputIndex]);
    }
    for (const pair of selection.pairs) {
      if (
        crossJAccountFrameMatches(env, pair.sourceAccountFrame) ||
        crossJAccountFrameMatches(env, pair.targetAccountFrame)
      ) {
        failedIndexes.add(pair.sourceInputIndex);
        failedIndexes.add(pair.targetInputIndex);
      }
    }
    if (failedIndexes.size === 0) return selection;
    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_PREVIEW_REJECTED', {
      attempt,
      pairCount: selection.pairs.length,
      droppedInputIndexes: [...failedIndexes].sort((left, right) => left - right),
    });
    for (const pair of selection.pairs) {
      const pairIndexes = [pair.sourceInputIndex, pair.targetInputIndex];
      if (!pairIndexes.some(inputIndex => failedIndexes.has(inputIndex))) continue;
      for (const inputIndex of pairIndexes) {
        const rejectedInput = selection.inputs[inputIndex]!;
        recordRuntimeSecurityIncident(env, {
          domain: 'cross-j',
          code: 'CROSS_J_ACCOUNT_PAIR_PREVIEW_REJECTED',
          source: 'remote-ingress',
          severity: 'warning',
          summary: 'A signed cross-j Account pair failed atomic scratch-state validation and was ignored',
          entityId: rejectedInput.entityId,
        });
      }
    }
    retained = selection.inputs.filter((_input, inputIndex) => !failedIndexes.has(inputIndex));
  }
  throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_PREFLIGHT_DID_NOT_CONVERGE');
};

const applyRuntimeInput = async (
  env: Env,
  runtimeInput: RuntimeInput,
): Promise<{
  entityOutbox: RoutedEntityInput[];
  mergedInputs: RoutedEntityInput[];
  jOutbox: JInput[];
  appliedRuntimeInput: RuntimeInput;
  reliableIngressCommits: ReliableIngressCommit[];
}> => {
  failfastAssert(
    env.scenarioMode === true || envRecord(env)[ENV_APPLY_ALLOWED_KEY] === true,
    'RUNTIME_APPLY_DIRECT_CALL',
    'applyRuntimeInput must be invoked via process()/WAL replay (non-scenario)',
    { runtimeId: env.runtimeId, height: env.height },
  );
  const startTime = getPerfMs();
  const applyProfileMarks: Record<string, number> = {};
  const markApplyProfile = (label: string): void => {
    applyProfileMarks[label] = Math.round(getPerfMs() - startTime);
  };

  // Ensure event emitters are attached (may be lost after store serialization)
  if (!env.emit) {
    attachEventEmitters(env);
  }

  try {
    const rejectRuntimeInput = (message: string): never => {
      log.error(`❌ ${message}`);
      throw new Error(message);
    };
    if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
      runtimeLog.debug('input.replay.apply', {
        runtimeTxs: runtimeInput.runtimeTxs.length,
        entityInputs: runtimeInput.entityInputs.length,
      });
    }
    // SECURITY: Validate runtime input
    if (!runtimeInput) {
      rejectRuntimeInput('Null runtime input provided');
    }
    if (!Array.isArray(runtimeInput.runtimeTxs)) {
      rejectRuntimeInput(`Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`);
    }
    if (!Array.isArray(runtimeInput.entityInputs)) {
      rejectRuntimeInput(`Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`);
    }
    if (runtimeInput.reliableReceipts !== undefined && !Array.isArray(runtimeInput.reliableReceipts)) {
      rejectRuntimeInput(
        `Invalid reliableReceipts: expected array, got ${typeof runtimeInput.reliableReceipts}`,
      );
    }

    validateRuntimeJIngressLimits(env, runtimeInput);

    // Collect incoming J-inputs into early jOutbox (will be merged with handler jOutputs later)
    // These are NOT pushed to jReplica.mempool — they go to jOutbox → JAdapter post-save
    const earlyJOutbox: JInput[] = [];
    if (runtimeInput.jInputs && Array.isArray(runtimeInput.jInputs)) {
      const validatedJInputs = validateJInputs(runtimeInput.jInputs, 'RUNTIME_INPUT_J');
      runtimeLog.debug('joutbox.incoming', { jInputs: runtimeInput.jInputs.length });
      for (const jInput of validatedJInputs) {
        const jReplica = env.jReplicas?.get(jInput.jurisdictionName);
        if (!jReplica) {
          rejectRuntimeInput(`Unknown J jurisdiction: ${jInput.jurisdictionName}`);
        }
        runtimeLog.debug('joutbox.collect', {
          jurisdictionName: jInput.jurisdictionName,
          jTxs: jInput.jTxs.length,
          types: jInput.jTxs.map(t => t.type),
        });
        earlyJOutbox.push(jInput);
      }
    }

    // SECURITY: Resource limits
    if (runtimeInput.runtimeTxs.length > 1000) {
      rejectRuntimeInput(`Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`);
    }
    if (runtimeInput.entityInputs.length > 10000) {
      rejectRuntimeInput(`Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`);
    }
    if ((runtimeInput.reliableReceipts?.length ?? 0) > 10000) {
      rejectRuntimeInput(
        `Too many reliable receipts: ${runtimeInput.reliableReceipts!.length} > 10000`,
      );
    }

    const validatedRuntimeTxs = [...runtimeInput.runtimeTxs];
    const validatedEntityInputs = runtimeInput.entityInputs.map((input, i) => {
      try {
        const isReplay = envRecord(env)[ENV_REPLAY_MODE_KEY] === true;
        for (const tx of input.entityTxs ?? []) assertScheduledWakeTxAuthorized(tx, isReplay);
        return normalizeRuntimeEntityInput(env, validateEntityInput(input), `runtimeInput[${i}]`);
      } catch (error) {
        logError('RUNTIME_TICK', `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput[${i}] before merge!`, {
          error: (error as Error).message,
          input,
        });
        throw error; // Fail fast
      }
    });

    const mergedRuntimeTxs = [...validatedRuntimeTxs];
    const mergedInputs = mergeEntityInputs(
      [...validatedEntityInputs],
      input => hasVerifiedEntityCommitPrecertificate(env, input),
    );
    markApplyProfile('validateMerge');

    const isReplay = envRecord(env)[ENV_REPLAY_MODE_KEY] === true;
    if (isReplay) {
      for (const input of validatedEntityInputs.flatMap(splitRoutedOutputByDeliveryLane)) {
        if (!getInputReliableIdentity(input)) continue;
        const sourceRuntimeId = normalizeRuntimeId(input.from);
        // Direct/local Entity inputs may carry a reliable identity without a
        // transport sender and therefore never owned a receiver frontier.
        // Receipt-only WAL inputs are materialized with `from` below.
        if (!sourceRuntimeId) continue;
        registerReliableIngress(env, sourceRuntimeId, input);
      }
    }
    if (runtimeInput.reliableReceipts && runtimeInput.reliableReceipts.length > 0) {
      applyReliableDeliveryReceipts(env, runtimeInput.reliableReceipts);
    }
    const runtimeTxJOutbox: JInput[] = [];
    // RuntimeTxs are replayable R-machine commands. Most are local metadata
    // transitions; retryJSubmit additionally materializes a sealed post-commit
    // J side effect whose attempt record is persisted before external I/O.
    for (const runtimeTx of mergedRuntimeTxs) {
      runtimeTxJOutbox.push(...await applyRuntimeTx(env, runtimeTx, {
        isReplay,
      }));
    }
    markApplyProfile('runtimeTxs');

    // Seal every certified H0 anchor before an Entity input can advance that
    // replica to H1. Storage is intentionally written from the post-state, so
    // attempting to reconstruct the anchor only at commit time would have
    // already lost the only authoritative H0 state. This also covers an entity
    // imported and advanced in the same Runtime frame.
    // Earlier certified Entity frames already live in the frame DB. Advance
    // the tiny local anchor to the exact finalized endpoint before applying
    // this R-frame; otherwise pruning RAM to the latest E-frame would leave an
    // old anchor and manufacture a gap on the next commit. This is metadata,
    // not a full-state snapshot or a replacement for historical replay.
    applyCertifiedEntityLineagePlan(env, buildRuntimeCheckpointLineagePlan(env));
    markApplyProfile('lineage');

    const routingDeps = getRuntimeEntityRoutingDeps();
    const initialJOutbox = [...earlyJOutbox, ...runtimeTxJOutbox];
    const preparedEntityInputs = await prepareAtomicCrossJAccountInputs(
      env,
      mergedInputs,
      initialJOutbox,
      isReplay,
      routingDeps,
    );
    markApplyProfile('atomicCrossJPreflight');
    const appliedEntityBatch = await applyMergedEntityInputs(
      env,
      preparedEntityInputs.inputs,
      initialJOutbox,
      { isReplay, routingDeps },
    );
    if (preparedEntityInputs.pairs.length > 0) {
      runtimeLog.info('crossj.atomic_pair_commit', {
        pairCount: preparedEntityInputs.pairs.length,
        outcomes: appliedEntityBatch.inputOutcomes.map(({ outcome }, inputIndex) => ({
          inputIndex,
          entityId: preparedEntityInputs.inputs[inputIndex]?.entityId ?? 'missing',
          kind: outcome.kind,
        })),
        outputSummary: safeStringify(appliedEntityBatch.entityOutbox.map((output, outputIndex) => ({
          outputIndex,
          ...summarizeCrossJAccountInput(output, outputIndex),
        }))),
      });
    }
    markApplyProfile('entityApply');
    const failedAtomicIndexes = crossJPairIndexesThatDidNotCommit(
      env,
      preparedEntityInputs.pairs,
      appliedEntityBatch.inputOutcomes,
    );
    if (failedAtomicIndexes.size > 0) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_COMMIT_DIVERGED_FROM_PREFLIGHT');
    }
    markCommittedCrossJAtomicAckOutputs(appliedEntityBatch.entityOutbox, preparedEntityInputs.pairs);
    const { entityOutbox, appliedEntityInputs, entityFrameCommitted, jOutbox } = appliedEntityBatch;

    // Reliable receiver authority is part of the R-machine post-state, not a
    // transport side effect. Plan it before deciding whether this tick owns a
    // WAL height. Otherwise a terminal receipt-only transition can ACK/GC an
    // input while no replayable frame records the new frontier.
    const reliableIngressCommits = commitReliableIngress(env, appliedEntityInputs);
    markApplyProfile('reliableCommit');
    applyCommittedLocalReliableReceipts(env, reliableIngressCommits, {
      isReplay,
      replayInputs: validatedEntityInputs,
    });
    markApplyProfile('reliableLocalReceipts');
    releaseUncommittedReliableIngress(env, validatedEntityInputs, appliedEntityInputs);
    markApplyProfile('reliableRelease');
    // Releasing a rejected/deferred ingress mutates only the live transport
    // waiter set. It is deliberately absent from snapshots and cannot own a
    // WAL height. Durable active/terminal frontier commits remain replayable.
    const reliableIngressStateChanged = reliableIngressCommits.length > 0;

    if (jOutbox.length > 0) {
      for (const jInput of jOutbox) {
        for (const jTx of jInput.jTxs) {
          const jTxBatchSize = (jTx.data as { batchSize?: number } | undefined)?.batchSize;
          env.emit('JBatchQueued', {
            entityId: jTx.entityId,
            batchSize: jTxBatchSize,
            jurisdictionName: jInput.jurisdictionName,
          });
        }
      }
    }

    const hasRuntimeTxs = mergedRuntimeTxs.length > 0;
    const meaningfulEntityInputCount = appliedEntityInputs.reduce((count, input) => {
      const hasEntityTxs = (input.entityTxs?.length || 0) > 0;
      const hasProposal = !!input.proposedFrame;
      const hasHashPrecommits = !!input.hashPrecommits && input.hashPrecommits.size > 0;
      const hasJPrefixAttestations = !!input.jPrefixAttestations && input.jPrefixAttestations.size > 0;
      const hasLeaderTimeoutVote = !!input.leaderTimeoutVote;
      return count + (
        hasEntityTxs || hasProposal || hasHashPrecommits || hasJPrefixAttestations || hasLeaderTimeoutVote ? 1 : 0
      );
    }, 0);
    // A local empty tick may commit work already held in the Entity/Account
    // mempools. Input shape cannot detect that transition. The authoritative
    // signal is the validated Entity height advancing exactly H -> H+1.
    const runtimeEntityInputCount = entityFrameCommitted
      ? Math.max(meaningfulEntityInputCount, appliedEntityInputs.length)
      : meaningfulEntityInputCount;
    const hasEntityInputs = runtimeEntityInputCount > 0;
    const hasReliableReceipts = (runtimeInput.reliableReceipts?.length ?? 0) > 0;
    const hasOutputs = entityOutbox.length > 0;
    const hasJOutputs = jOutbox.length > 0;

    if (
      hasRuntimeTxs ||
      hasEntityInputs ||
      hasReliableReceipts ||
      hasOutputs ||
      hasJOutputs ||
      reliableIngressStateChanged
    ) {
      // Emit runtime tick event
      env.emit('RuntimeTick', {
        height: env.height + 1,
        runtimeTxs: mergedRuntimeTxs.length,
        entityInputs: runtimeEntityInputCount,
        outputs: entityOutbox.length,
      });

      // Update env in-place first.
      // This is intentional blockchain-style execution semantics: we execute the
      // next frame against one mutable working state, then persist the resulting
      // post-state as the committed frame below. That is simpler and safer than
      // trying to keep a separate pre-commit shadow env in lockstep.
      env.height++;
      // IMPORTANT: Do NOT mutate env.timestamp here.
      // process() sets a single frame timestamp before applyRuntimeInput(),
      // and that exact value must be used both for frame hashing and WAL journal.
    } else {
      if (env.quietRuntimeLogs !== true) {
        runtimeLog.debug('frame.skip_empty');
      }
      // Clear env.extra even when skipping frame to prevent stale solvency expectations
      env.extra = undefined;
    }

    if (!env.gossip) {
      runtimeLog.warn('gossip.missing_recreate', { height: env.height });
      env.gossip = createGossipLayer();
      runtimeLog.info('gossip.recreated', { height: env.height });
    }
    markApplyProfile('finalize');

    const endTime = getPerfMs();
    const applyElapsedMs = Math.round(endTime - startTime);
    if (RUNTIME_APPLY_PROFILE || applyElapsedMs >= RUNTIME_APPLY_SLOW_MS) {
      runtimeLog.warn('apply.profile', {
        height: env.height,
        elapsedMs: applyElapsedMs,
        runtimeTxs: mergedRuntimeTxs.length,
        entityInputs: appliedEntityInputs.length,
        entityTxs: appliedEntityInputs.reduce((sum, input) => sum + Number(input.entityTxs?.length || 0), 0),
        outputs: entityOutbox.length,
        jOutputs: jOutbox.length,
        phases: cumulativeMarksToPhases(applyProfileMarks, applyElapsedMs),
      });
    }
    if (DEBUG) {
      runtimeLog.debug('tick.completed', {
        height: env.height - 1,
        elapsedMs: applyElapsedMs,
      });
    }

    const durableReliableIngressSources = new Map<string, Set<string>>();
    for (const commit of reliableIngressCommits) {
      if (!commit.key) continue;
      const sources = durableReliableIngressSources.get(commit.key) ?? new Set<string>();
      commit.targetRuntimeIds.forEach(source => sources.add(source));
      durableReliableIngressSources.set(commit.key, sources);
    }
    for (const ledger of [
      env.runtimeState?.reliableIngressReceiptLedger,
      env.runtimeState?.reliableIngressTerminalWatermarks,
    ]) {
      for (const [frontierKey, receipt] of ledger ?? []) {
        const parsed = JSON.parse(frontierKey) as { sourceRuntimeId?: unknown };
        const source = normalizeRuntimeId(parsed.sourceRuntimeId);
        if (!source) throw new Error('RELIABLE_INGRESS_FRONTIER_SOURCE_RUNTIME_INVALID');
        const key = reliableIdentityExactKey(receipt.body.identity);
        const sources = durableReliableIngressSources.get(key) ?? new Set<string>();
        sources.add(source);
        durableReliableIngressSources.set(key, sources);
      }
    }
    const durableReceiptOnlyInputs = validatedEntityInputs.flatMap(input =>
      splitRoutedOutputByDeliveryLane(input).flatMap(lane => {
        if (
          lane.leaderTimeoutVote?.signature === '' &&
          isLocalEntityLeaderTimeoutVote(lane.leaderTimeoutVote)
        ) {
          // This is a local scheduler command, not authenticated transport
          // ingress. Consensus replaces it with the signed canonical value in
          // appliedEntityInputs before WAL persistence.
          return [];
        }
        const identity = getInputReliableIdentity(lane);
        if (!identity) return [];
        const sources = durableReliableIngressSources.get(reliableIdentityExactKey(identity));
        if (!sources || sources.size === 0) return [];
        if (lane.from) return [lane];
        return [...sources].sort().map(source => ({ ...lane, from: source }));
      }));
    const persistedEntityInputs = [...appliedEntityInputs];
    for (const input of durableReceiptOnlyInputs) {
      const inputSourceRuntimeId = normalizeRuntimeId(input.from);
      if (!inputSourceRuntimeId) {
        throw new Error('RUNTIME_RELIABLE_DURABLE_INPUT_SOURCE_MISSING');
      }
      const persistedInput: RoutedEntityInput = { ...input, from: inputSourceRuntimeId };
      const inputIdentity = getInputReliableIdentity(input);
      const inputKey = inputIdentity ? reliableIdentityExactKey(inputIdentity) : null;
      const matchingIndex = inputKey === null ? -1 : persistedEntityInputs.findIndex(candidate =>
        splitRoutedOutputByDeliveryLane(candidate).some(lane => {
          const identity = getInputReliableIdentity(lane);
          return identity !== null && reliableIdentityExactKey(identity) === inputKey;
        }));
      if (matchingIndex < 0) {
        persistedEntityInputs.push(persistedInput);
        continue;
      }
      const existing = persistedEntityInputs[matchingIndex]!;
      if (!existing.from) {
        // `existing` may be the canonical merge of several independently
        // certified delivery lanes. Provenance annotates that applied batch;
        // replacing it with one receipt lane silently drops the other txs
        // from WAL and makes crash replay build a different Entity frame.
        persistedEntityInputs[matchingIndex] = { ...existing, from: inputSourceRuntimeId };
      } else if (normalizeRuntimeId(existing.from) !== inputSourceRuntimeId) {
        throw new Error(
          `RUNTIME_RELIABLE_APPLIED_INPUT_SOURCE_CONFLICT:` +
          `${normalizeRuntimeId(existing.from)}:${inputSourceRuntimeId}`,
        );
      }
    }
    const appliedRuntimeInput: RuntimeInput = {
      runtimeTxs: mergedRuntimeTxs,
      entityInputs: persistedEntityInputs,
      ...(runtimeInput.jInputs && runtimeInput.jInputs.length > 0 ? { jInputs: runtimeInput.jInputs } : {}),
      ...(runtimeInput.reliableReceipts && runtimeInput.reliableReceipts.length > 0
        ? { reliableReceipts: runtimeInput.reliableReceipts }
        : {}),
    };
    return {
      entityOutbox,
      mergedInputs: preparedEntityInputs.inputs,
      jOutbox,
      appliedRuntimeInput,
      reliableIngressCommits,
    };
  } catch (error) {
    // Strict scenarios already surface the thrown value at their outer boundary.
    // Logging directly to process stderr here would make the strict console trap throw a
    // second Error and erase the original stack, hiding the actual failing reducer.
    if (env.strictScenario) throw error;
    runtimeLog.error('apply_input.failed', {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
    throw error; // Don't swallow - fail fast and loud
  }
};

// Runtime bootstrap
export type RuntimeLocalSigner = Readonly<{
  label: string;
  seed?: Uint8Array | string;
}>;

export type RuntimeCreationOptions = Readonly<{
  trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  localSigners?: readonly RuntimeLocalSigner[];
}>;

const main = async (
  runtimeSeedOverride?: string | null,
  options?: RuntimeCreationOptions,
): Promise<Env> => {
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
      const loadedState = ensureRuntimeState(loaded);
      const baseState = ensureRuntimeState(baseEnv);
      if (runtimeIsBrowser) {
        loadedState.db = baseState.db;
        loadedState.dbOpenPromise = baseState.dbOpenPromise;
      }
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
const getHistory = (env: Env) => env.history || [];
const getSnapshot = (env: Env, index: number) => {
  const history = env.history || [];
  return index >= 0 && index < history.length ? history[index] : null;
};
const getCurrentHistoryIndex = (env: Env) => (env.history || []).length - 1;

// Clear database for a specific runtime and return a fresh env
const clearDatabaseAndHistory = async (env: Env): Promise<Env> => {
  runtimeLog.info('db.reset.start');
  const db = getRuntimeDb(env);
  await clearDatabase(db);
  try {
    const infraReady = await tryOpenInfraDb(env);
    if (infraReady) {
      await clearDatabase(getInfraDb(env));
    }
  } catch (error) {
    runtimeLog.warn('db.reset.infra_clear_failed', { error: error instanceof Error ? error.message : String(error) });
  }

  const seed = env.runtimeSeed ?? null;
  const freshEnv = createEmptyEnv(seed);
  if (env.runtimeId) {
    freshEnv.runtimeId = env.runtimeId;
    freshEnv.dbNamespace = normalizeDbNamespace(env.runtimeId);
  }
  attachEventEmitters(freshEnv);

  runtimeLog.info('db.reset.done');
  return freshEnv;
};

/**
 * Queue an entity transaction for processing (helper for UI components)
 * Wraps applyRuntimeInput with a single entity tx
 */
export const queueEntityInput = async (
  env: Env,
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
  assignNameOnChain,
  clearDatabase,
  classifyBilateralState,
  getAccountBarVisual,
  clearDatabaseAndHistory,
  // Clean logs: getCleanLogs, clearCleanLogs, copyCleanLogs - exported at definition
  // Entity creation functions
  createLazyEntity,
  createNumberedEntity,
  createNumberedEntitiesBatch,
  createProfileUpdateTx,
  detectEntityType,
  encodeBoard,
  // Display and avatar functions
  formatEntityDisplay,
  formatSignerDisplay,
  hashToAvatar,
  generateEntityAvatar,
  // Entity utility functions
  generateLazyEntityId,
  generateNamedEntityId,
  generateNumberedEntityId,
  generateSignerAvatar,
  getAvailableJurisdictions,
  getCurrentHistoryIndex,
  getEntityDisplayInfo,
  getEntityDisplayInfoFromProfile,
  getEntityInfoFromChain,
  getHistory,
  getJurisdictionByAddress,
  getSignerDisplayInfo,
  getSnapshot,
  hashBoard,
  isEntityRegistered,
  main,
  resolveEntityProposerId,
  requestNamedEntity,
  resolveEntityIdentifier,
  resolveEntityName,
  // Name resolution functions
  searchEntityNames,
  setBrowserVMJurisdiction,
  getBrowserVMInstance,
  // getEnv, initEnv, processJBlockEvents - already exported inline above
  submitProcessBatch,
  debugFundReserves,
  transferNameBetweenEntities,
  // Account utilities (destructured from AccountUtils)
  deriveDelta,
  isLeft,
  getTokenInfo,
  getKnownTokenIds,
  getTokenIdsForJurisdiction,
  isLiquidSwapToken,
  getSwapPairOrientation,
  getDefaultSwapTradingPairs,
  listOpenSwapOffers,
  computeSwapPriceTicks,
  getSwapLotScale,
  prepareSwapOrder,
  quantizeSwapOrder,
  requantizeRemainingSwapAtPrice,
  formatTokenAmount,
  createDemoDelta,
  getDefaultCreditLimit,

  // Entity utilities (from entity-helpers and serialization-utils)
  getEntityShortId,
  formatEntityId,
  safeStringify,

  // Financial utilities (ethers.js-based, precision-safe)
  formatTokenAmountEthers,
  parseTokenAmount,
  convertTokenPrecision,
  calculatePercentageEthers,
  formatAssetAmountEthers,
  BigIntMath,
  FINANCIAL_CONSTANTS,

  // Validation utilities (strict typing for financial data)
  validateDelta,
  validateAccountDeltas,
  createDefaultDelta,
  isDelta,

  // Snapshot utilities
  encode,
  decode,

  // System solvency (conservation of tokens)
  calculateSolvency,
  verifySolvency,

  // Identity system (from ids.ts) - replaces split(':') patterns
  parseReplicaKey,
  extractEntityId,
  extractSignerId,
  formatReplicaKey,
  createReplicaKey,
  formatReplicaDisplay,
  // Type guards
  isValidEntityId,
  isValidSignerId,
  isValidJId,
  isValidEpAddress,
  // Constructors
  toEntityId,
  toSignerId,
  toJId,
  toEpAddress,
  // Entity type detection
  isNumberedEntity,
  isLazyEntity,
  getEntityDisplayNumber,
  // URI operations (for future networking)
  formatReplicaUri,
  parseReplicaUri,
  createLocalUri,
  // Type-safe collections
  ReplicaMap,
  EntityMap,
  // Jurisdiction helpers
  jIdFromChainId,
  createLazyJId,
  // Tolerant parsing helpers
  safeParseReplicaKey,
  safeExtractEntityId,
  // Constants
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  XLN_COORDINATOR,
  CHAIN_IDS,
  MAX_NUMBERED_ENTITY,

  // Account messaging: Using bilateral frame-based consensus instead of direct messaging
  // (Old direct messaging functions removed - replaced with AccountInput flow)
};

// Re-export types from ids.ts for frontend use
export type {
  EntityId,
  SignerId,
  JId,
  EntityProviderAddress,
  ReplicaKey,
  FullReplicaAddress,
  ReplicaUri,
  JurisdictionInfo,
} from './ids';

// Runtime is a pure library - no auto-execution side effects.
// Browser and server entrypoints call xln.main() explicitly.

export const prewarmRuntimeSignerCache = (seedText: string, count = 20): string[] => {
  try {
    return prewarmSignerKeyCache(seedText, count);
  } catch (error) {
    runtimeLog.error('signer_cache.prewarm_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const createEmptyEnv = (seed?: Uint8Array | string | null): Env => {
  const normalizedSeed = Array.isArray(seed) ? new Uint8Array(seed) : seed;
  const seedText =
    normalizedSeed !== undefined && normalizedSeed !== null
      ? typeof normalizedSeed === 'string'
        ? normalizedSeed
        : new TextDecoder().decode(normalizedSeed)
      : '';
  const derivedRuntimeId = seedText ? deriveRuntimeIdFromSeed(seedText) : null;
  const resolvedRuntimeId = derivedRuntimeId ? derivedRuntimeId.toLowerCase() : null;
  const resolvedDbNamespace = resolvedRuntimeId ? normalizeDbNamespace(resolvedRuntimeId) : undefined;

  let env!: Env;
  const gossip = createGossipLayer({
    onAnnounce: (profile) => {
      if (!env) return;
      if (env.runtimeState?.infraDbClosing) return;
      const persist = persistGossipProfileToInfraDb(env, infraGossipDbAccess, profile).catch((error) => {
        runtimeLog.warn('infra_db.gossip_persist_failed', {
          entity: String(profile?.entityId || '').slice(-8),
          error: error instanceof Error ? error.message : String(error),
        });
      });
      trackInfraDbWrite(env, persist);
    },
    getLiveProfiles: () => {
      if (!env?.eReplicas || env.eReplicas.size === 0) return [];
      const profiles = new Map<string, Profile>();
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const entityId = extractEntityId(replicaKey);
        const signerId = extractSignerId(replicaKey);
        if (!entityId || !signerId) continue;
        if (getSignerPrivateKeyIfAvailable(env, signerId) === null) continue;
        if (profiles.has(entityId)) continue;
        const existingTs = env.gossip?.getProfiles?.().find((profile) => profile.entityId === entityId)?.lastUpdated ?? 0;
        const liveTimestamp = Math.max(existingTs + 1, env.timestamp || 1);
        profiles.set(entityId, buildLocalEntityProfile(env, replica.state, liveTimestamp));
      }
      return Array.from(profiles.values());
    },
  });

  env = {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
	    timestamp: 0,
	    ...(seedText !== undefined && seedText !== null ? { runtimeSeed: seedText } : {}),
	    ...(resolvedRuntimeId ? { runtimeId: resolvedRuntimeId } : {}),
    ...(resolvedDbNamespace ? { dbNamespace: resolvedDbNamespace } : {}),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeMempool: undefined,
    runtimeConfig: undefined,
    runtimeState: undefined,
    history: [],
    gossip,
    frameLogs: [],
    networkInbox: [],
    pendingNetworkOutputs: [],
    // Event emitters will be attached below
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    emit: () => {},
    // BrowserVM will be lazily initialized on first adapter use
    browserVM: null,
    // EVM instances (unified interface) - use createEVM() to add
    evms: new Map(),
  };

  // Attach event emission methods (EVM-style)
  attachEventEmitters(env);

  // Ensure runtime structures exist
  ensureRuntimeMempool(env);
  ensureRuntimeConfig(env);
  ensureRuntimeState(env);
  if (seedText) {
    prewarmRuntimeSignerCache(seedText, 20);
  }

  return env;
};

const normalizeCheckpointReplicaMap = (raw: unknown): Map<string, unknown> => {
  if (raw instanceof Map) return new Map(raw.entries());
  if (!Array.isArray(raw)) return new Map();
  return new Map(
    raw
      .filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length >= 2)
      .map(([key, value]) => [String(key), value]),
  );
};

// Recovery bundles deliberately reuse the canonical checkpoint snapshot. That keeps
// the restore path aligned with the storage replay oracle instead of inventing a
// second persistence format that would drift over time.
export const restoreEnvFromCheckpointSnapshot = async (
  snapshot: Record<string, unknown>,
  options?: {
    runtimeSeed?: string | null;
    runtimeId?: string | null;
    readOnly?: boolean;
  },
): Promise<Env> => {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('RECOVERY_CHECKPOINT_INVALID');
  }

  const normalizedSnapshot = cloneIsolatedRuntimeSnapshot(snapshot);
  normalizePersistedSnapshotInPlace(normalizedSnapshot, {
    normalizeReplicaMap: normalizeCheckpointReplicaMap,
    normalizeJReplicaMap: normalizeCheckpointReplicaMap,
  });

  const snapshotRuntimeSeed =
    typeof normalizedSnapshot['runtimeSeed'] === 'string' ? normalizedSnapshot['runtimeSeed'] : null;
  const runtimeSeed =
    options?.runtimeSeed !== undefined ? options.runtimeSeed : snapshotRuntimeSeed;
  const env = createEmptyEnv(runtimeSeed ?? null);

  const snapshotRuntimeId = normalizeRuntimeId(
    options?.runtimeId ?? String(normalizedSnapshot['runtimeId'] || env.runtimeId || ''),
  );
  if (!snapshotRuntimeId) {
    throw new Error('RECOVERY_CHECKPOINT_RUNTIME_ID_REQUIRED');
  }

  env.runtimeId = snapshotRuntimeId;
  env.dbNamespace = normalizeDbNamespace(snapshotRuntimeId);
  env.height = requireBoundaryInteger(
    normalizedSnapshot['height'],
    'RECOVERY_CHECKPOINT_HEIGHT_INVALID',
  );
  env.timestamp = requireBoundaryInteger(
    normalizedSnapshot['timestamp'],
    'RECOVERY_CHECKPOINT_TIMESTAMP_INVALID',
  );
  env.eReplicas = normalizedSnapshot['eReplicas'] instanceof Map
    ? new Map(Array.from(normalizedSnapshot['eReplicas'].entries()).map(([key, value]) => [String(key), value as never]))
    : new Map();
  env.jReplicas = normalizedSnapshot['jReplicas'] instanceof Map
    ? new Map(Array.from(normalizedSnapshot['jReplicas'].entries()).map(([key, value]) => [String(key), value as never]))
    : new Map();
  env.activeJurisdiction =
    typeof normalizedSnapshot['activeJurisdiction'] === 'string'
      ? String(normalizedSnapshot['activeJurisdiction'])
      : env.activeJurisdiction;
  const browserVMState = normalizedSnapshot['browserVMState'];
  if (browserVMState !== undefined) {
    Object.assign(env, {
      browserVMState: structuredClone(browserVMState) as Env['browserVMState'],
    });
  }
  const snapshotGossip = normalizedSnapshot['gossip'] && typeof normalizedSnapshot['gossip'] === 'object'
    ? normalizedSnapshot['gossip'] as { profiles?: unknown }
    : null;
  const snapshotGossipProfiles = Array.isArray(snapshotGossip?.profiles)
    ? snapshotGossip.profiles as Profile[]
    : [];
  env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
  env.frameLogs = [];
  env.networkInbox = [];
  env.pendingNetworkOutputs = [];
  env.overlay = [];
  restoreDurableRuntimeSnapshot(env, normalizedSnapshot);
  for (const replica of env.eReplicas.values()) {
    assertCertifiedJHistoryIntegrity(replica.state);
    assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
  }
  assertCertifiedBoardRootsAvailable(env);
  assertConsumptionRootsAvailable(env);
  assertAccountJClaimRootsAvailable(env);
  await assertCertifiedRegistrationEvidenceStore(env);

  if (!options?.readOnly) {
    await rehydrateRestoredRuntimeInfra(env, {
      isBrowser: runtimeIsBrowser,
      loadGossipProfiles: (targetEnv) => loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
      assertPersistedContractConfigReady,
      setBrowserVMJurisdiction,
    });
  }
  registerCommittedSingleSignerWallets(env);
  for (const profile of snapshotGossipProfiles) {
    env.gossip?.announce?.(profile);
  }

  return env;
};

const normalizeEmptyRecoveryIngressState = (
  machine: Record<string, unknown>,
): Record<string, unknown> => {
  const runtimeState = machine['runtimeState'];
  if (!runtimeState || typeof runtimeState !== 'object') return machine;
  const normalizedState = { ...(runtimeState as Record<string, unknown>) };
  for (const key of ['pendingReliableIngress', 'reliableIngressCommitting'] as const) {
    const value = normalizedState[key];
    if ((value instanceof Map || value instanceof Set) && value.size === 0) delete normalizedState[key];
  }
  const normalized = { ...machine };
  if (Object.keys(normalizedState).length > 0) normalized['runtimeState'] = normalizedState;
  else delete normalized['runtimeState'];
  return normalized;
};

const canonicalRecoveryMachine = (machine: Record<string, unknown>): string =>
  safeStringify(canonicalizeStorageAuditValue(normalizeEmptyRecoveryIngressState(machine)));

const recoveryMachineMismatchFields = (
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] => {
  const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches: string[] = [];
  for (const field of [...fields].sort()) {
    const expectedHasField = Object.prototype.hasOwnProperty.call(expected, field);
    const actualHasField = Object.prototype.hasOwnProperty.call(actual, field);
    if (expectedHasField !== actualHasField) {
      mismatches.push(field);
      continue;
    }
    if (canonicalRecoveryMachine({ value: expected[field] }) === canonicalRecoveryMachine({ value: actual[field] })) continue;
    if (field !== 'runtimeState') {
      mismatches.push(field);
      continue;
    }
    const expectedState = expected[field] && typeof expected[field] === 'object'
      ? expected[field] as Record<string, unknown>
      : {};
    const actualState = actual[field] && typeof actual[field] === 'object'
      ? actual[field] as Record<string, unknown>
      : {};
    const stateFields = new Set([...Object.keys(expectedState), ...Object.keys(actualState)]);
    for (const stateField of [...stateFields].sort()) {
      const expectedHasStateField = Object.prototype.hasOwnProperty.call(expectedState, stateField);
      const actualHasStateField = Object.prototype.hasOwnProperty.call(actualState, stateField);
      if (expectedHasStateField !== actualHasStateField) {
        mismatches.push(`runtimeState.${stateField}`);
        continue;
      }
      if (canonicalRecoveryMachine({ value: expectedState[stateField] }) !== canonicalRecoveryMachine({ value: actualState[stateField] })) {
        mismatches.push(`runtimeState.${stateField}`);
      }
    }
  }
  return mismatches;
};

const readRecoveryMachineField = (
  machine: Record<string, unknown>,
  field: string,
): unknown => {
  if (!field.startsWith('runtimeState.')) return machine[field];
  const runtimeState = machine['runtimeState'];
  if (!runtimeState || typeof runtimeState !== 'object') return undefined;
  return (runtimeState as Record<string, unknown>)[field.slice('runtimeState.'.length)];
};

const assertRecoveryRuntimeMachineMatches = (
  env: Env,
  expectedMachine: Record<string, unknown>,
  height: number,
  options?: { includeIngressWorkingState?: boolean },
): void => {
  const actualMachine = buildReplayVerifiableRuntimeMachineSnapshot(env, {
    includeIngressWorkingState: options?.includeIngressWorkingState === true,
  });
  const expectedReplayMachine = projectReplayVerifiableRuntimeMachine(expectedMachine);
  const actual = canonicalRecoveryMachine(actualMachine);
  const expected = canonicalRecoveryMachine(expectedReplayMachine);
  if (actual !== expected) {
    const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(expected));
    const actualHash = ethers.keccak256(ethers.toUtf8Bytes(actual));
    const mismatchFields = recoveryMachineMismatchFields(expectedReplayMachine, actualMachine);
    const firstField = mismatchFields[0] || 'unknown';
    const expectedValue = readRecoveryMachineField(expectedReplayMachine, firstField);
    const actualValue = readRecoveryMachineField(actualMachine, firstField);
    const detail = canonicalRecoveryMachine({
      actual: actualValue === undefined ? { present: false } : { present: true, value: actualValue },
      expected: expectedValue === undefined ? { present: false } : { present: true, value: expectedValue },
    }).slice(0, 5_000);
    throw new Error(
      `RECOVERY_JOURNAL_RUNTIME_MACHINE_MISMATCH:height=${height}:` +
      `fields=${mismatchFields.join(',') || 'unknown'}:` +
      `expected=${expectedHash}:actual=${actualHash}:detail=${detail}`,
    );
  }
};

const replayRecoveryFrameJournals = async (
  env: Env,
  frames: PersistedFrameJournal[],
): Promise<void> => {
  // Live process() normalizes operational defaults before every reducer pass;
  // replay must enter the reducer with the same deterministic configuration.
  ensureRuntimeConfig(env);
  const previousReplayMode = envRecord(env)[ENV_REPLAY_MODE_KEY];
  envRecord(env)[ENV_REPLAY_MODE_KEY] = true;
  try {
    let expectedHeight = requireBoundaryInteger(
      requireBoundaryInteger(env.height, 'RECOVERY_JOURNAL_BASE_HEIGHT_INVALID') + 1,
      'RECOVERY_JOURNAL_HEIGHT_OVERFLOW',
    );
    for (const frame of frames) {
      const frameHeight = requireBoundaryInteger(
        frame.height,
        'RECOVERY_JOURNAL_HEIGHT_INVALID',
      );
      if (frameHeight !== expectedHeight) {
        throw new Error(`RECOVERY_JOURNAL_REPLAY_GAP: expected=${expectedHeight} actual=${frameHeight}`);
      }
      if (!/^0x[0-9a-f]{64}$/i.test(String(frame.replicaMetaDigest ?? ''))) {
        throw new Error(`RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISSING:height=${frameHeight}`);
      }
      if (!/^0x[0-9a-f]{64}$/i.test(String(frame.postStateHash ?? ''))) {
        throw new Error(`RECOVERY_JOURNAL_POST_STATE_HASH_MISSING:height=${frameHeight}`);
      }
      env.timestamp = requireBoundaryInteger(
        frame.timestamp,
        `RECOVERY_JOURNAL_TIMESTAMP_INVALID:height=${frameHeight}`,
      );
      const outputSignerHints = new Map<string, string>();
      for (const output of frame.runtimeOutputs ?? []) {
        const carriesAccountInput = (output.entityTxs ?? []).some(tx => (
          tx.type === 'accountInput' ||
          (tx.type === 'consensusOutput' && tx.data.entityTxs.some(inner => inner.type === 'accountInput'))
        ));
        if (!carriesAccountInput) continue;
        const entityId = String(output.entityId || '').trim().toLowerCase();
        const signerId = String(output.signerId || '').trim().toLowerCase();
        if (!entityId || !signerId) {
          throw new Error(`RECOVERY_OUTPUT_SIGNER_HINT_INVALID:height=${frameHeight}`);
        }
        const existing = outputSignerHints.get(entityId);
        if (existing && existing !== signerId) {
          throw new Error(
            `RECOVERY_OUTPUT_SIGNER_HINT_CONFLICT:height=${frameHeight}:` +
              `entity=${entityId}:left=${existing}:right=${signerId}`,
          );
        }
        outputSignerHints.set(entityId, signerId);
      }
      installReplayOutputSignerHints(env, outputSignerHints);
      envRecord(env)[ENV_APPLY_ALLOWED_KEY] = true;
      try {
        if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
          runtimeLog.info('recovery.replica_meta.pre', {
            height: frameHeight,
            consumptionNodes: getConsumptionNodeStore(env).size,
            consumptionRoots: [...env.eReplicas.values()].map(replica => ({
              entityId: replica.entityId,
              root: replica.state.consumptionAccumulator?.root ?? null,
              count: replica.state.consumptionAccumulator?.count?.toString() ?? null,
              mempool: replica.mempool.map(tx => tx.type === 'consensusOutput'
                ? `consensusOutput:${tx.data.origin.sourceEntityId}:${tx.data.origin.sequence.toString()}`
                : tx.type),
            })),
          });
        }
        const replayResult = await applyRuntimeInput(
          env,
          frame.runtimeInput ?? { runtimeTxs: [], entityInputs: [] },
        );
        const splitJOutbox = splitJOutboxForDurableSubmit(replayResult.jOutbox);
        registerPendingCommittedJOutbox(env, splitJOutbox.durable);
        refreshScheduledWakeIndex(
          env,
          new Set(replayResult.appliedRuntimeInput.entityInputs.map(input => input.entityId.toLowerCase())),
        );
        applyDeterministicRuntimeOutputPlan(
          env,
          replayResult.entityOutbox,
          getRuntimeOutputRoutingDeps(),
        );
        generateHookPings(env);
        const replayFrameDbRecords = peekPendingFrameDbRecords(env, env.height, env.timestamp);
        finalizeReliableIngressCommit(env, replayResult.reliableIngressCommits);
        // Audit events are flushed only after the live WAL commit and are not
        // consensus/recovery state. Replay must neither retain nor re-emit them.
        clearPendingAuditEvents(env);
        env.runtimeMempool = frame.pendingRuntimeInput
          ? authorizeRestoredRuntimeInput(cloneIsolatedRuntimeInput(frame.pendingRuntimeInput))
          : undefined;
        env.runtimeInput = env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] };
        env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs ?? []);
        restoreDurableOutputRetryState(
          env,
          frame.runtimeOutputRetryState ?? [],
          frame.runtimeOutputs ?? [],
        );
        // These activity records were consumed by the same atomic storage
        // batch as the Runtime frame. Compare the committed post-state, not
        // the writer's pre-commit buffer.
        dropPendingFrameDbRecords(env, replayFrameDbRecords.length);
        // A sparse checkpoint gives a field-level diagnostic; use it before
        // the compact replica digest so recovery failures name the root cause.
        if (frame.runtimeMachine) {
          assertRecoveryRuntimeMachineMatches(env, frame.runtimeMachine, frameHeight);
        }
        // Rebuild the exact compact checkpoint shape used by the writer.
        // The generic rebase helper intentionally retains the latest lineage
        // link, while materialized Runtime checkpoints replace that link with
        // a local endpoint anchor. Mixing the two encodings makes identical
        // replay state fail its replica-meta digest at a checkpoint boundary.
        const replayCheckpointLineagePlan = frame.replicaMetaCheckpoint
          ? buildRuntimeCheckpointLineagePlan(env)
          : null;
        const actualReplicaMetaCommitment = replayCheckpointLineagePlan
          ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(
              env,
              replayCheckpointLineagePlan,
              { omitIntermediateSingleSignerState: frame.replicaMetaStateMode === 'shared-entity-state' },
            )
          : buildStorageLiveReplicaMetaCommitment(env);
        const actualReplicaMetaDigest = actualReplicaMetaCommitment.digest;
        if (actualReplicaMetaDigest !== frame.replicaMetaDigest) {
          const inputSummary = frame.runtimeInput.entityInputs.map(input => ({
            entityId: input.entityId,
            signerId: input.signerId,
            entityTxs: input.entityTxs?.map(tx => tx.type) ?? [],
            proposalHeight: input.proposedFrame?.height ?? null,
            hashPrecommits: input.hashPrecommits?.size ?? 0,
            hasSignerKey: input.signerId
              ? getCachedSignerPrivateKey(env, input.signerId) !== null
              : false,
          }));
          const appliedInputSummary = replayResult.appliedRuntimeInput.entityInputs.map(input => ({
            entityId: input.entityId,
            entityTxs: input.entityTxs?.map(tx => tx.type) ?? [],
            proposalHeight: input.proposedFrame?.height ?? null,
          }));
          throw new Error(
            `RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH:height=${frameHeight}:` +
            `expected=${frame.replicaMetaDigest}:actual=${actualReplicaMetaDigest}:` +
            `actualEntries=${safeStringify(summarizeStorageReplicaMetaEntries(actualReplicaMetaCommitment.entries))}:` +
            `actualFields=${safeStringify(summarizeStorageReplicaMetaFields(actualReplicaMetaCommitment.entries))}:` +
            `actualHeads=${safeStringify(summarizeStorageReplicaMetaHeads(actualReplicaMetaCommitment.entries))}:` +
            `runtimeInput=${safeStringify(inputSummary)}:` +
            `appliedInput=${safeStringify(appliedInputSummary)}:` +
            `entityOutbox=${safeStringify(replayResult.entityOutbox.map(output => ({ entityId: output.entityId, txs: output.entityTxs?.map(tx => tx.type) ?? [] })))}:` +
            `actualMeta=${safeStringify(inspectStorageReplicaMetaEntries(actualReplicaMetaCommitment.entries)).slice(0, 8_000)}`,
          );
        }
        const actualPostStateHash = computeStoragePostStateHash({
          height: frameHeight,
          timestamp: env.timestamp,
          replicaMetaDigest: actualReplicaMetaDigest,
          runtimeMachine: buildReplayVerifiableRuntimeMachineSnapshot(env, {
            pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
            excludePersistedFrameDbRecords: true,
          }),
        });
        if (actualPostStateHash !== frame.postStateHash) {
          throw new Error(
            `RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=${frameHeight}:` +
            `expected=${frame.postStateHash}:actual=${actualPostStateHash}`,
          );
        }
        if (frame.runtimeStateHash) {
          const actualStateHash = computeCanonicalStateHashFromEnv(env);
          if (actualStateHash !== frame.runtimeStateHash) {
            throw new Error(
              `RECOVERY_JOURNAL_STATE_HASH_MISMATCH:height=${frameHeight}:` +
              `expected=${frame.runtimeStateHash}:actual=${actualStateHash}`,
            );
          }
        }
        if (replayCheckpointLineagePlan) {
          applyCertifiedEntityLineagePlan(env, replayCheckpointLineagePlan);
        }
      } finally {
        clearReplayOutputSignerHints(env);
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
      }
      if (env.height !== frameHeight) {
        throw new Error(`RECOVERY_JOURNAL_REPLAY_HEIGHT_MISMATCH: expected=${frameHeight} actual=${env.height}`);
      }
      expectedHeight = requireBoundaryInteger(
        expectedHeight + 1,
        'RECOVERY_JOURNAL_HEIGHT_OVERFLOW',
      );
    }
  } finally {
    if (previousReplayMode === undefined) delete envRecord(env)[ENV_REPLAY_MODE_KEY];
    else envRecord(env)[ENV_REPLAY_MODE_KEY] = previousReplayMode;
    envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
  }
};

const failRecoveryRestoreAfterCleanup = async (env: Env, error: unknown): Promise<never> => {
  const originalError = error instanceof Error ? error : new Error(String(error));
  const cleanup = await Promise.allSettled([
    closeRuntimeDb(env),
    closeInfraDb(env),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      'RECOVERY_RESTORE_FAILED_WITH_CLEANUP_ERRORS',
    );
  }
  throw originalError;
};

export const restoreEnvFromRecoveryBundles = async (
  bundles: RuntimeRecoveryBundleV1[],
  options?: {
    runtimeSeed?: string | null;
    runtimeId?: string | null;
    targetHeight?: number;
    readOnly?: boolean;
  },
): Promise<Env> => {
  const trustedRuntimeSeed = options?.runtimeSeed;
  if (!trustedRuntimeSeed) throw new Error('RECOVERY_BUNDLE_TRUSTED_SEED_REQUIRED');
  const validated = (bundles || []).map(bundle => assertRuntimeRecoveryBundleAuthenticity(
    bundle,
    trustedRuntimeSeed,
    options?.runtimeId,
  ));
  const snapshots = validated.filter((bundle) => (bundle.kind ?? 'snapshot') === 'snapshot');
  if (snapshots.length === 0) {
    throw new Error('RECOVERY_BUNDLE_SNAPSHOT_REQUIRED');
  }
  const requestedTarget = options?.targetHeight;
  if (
    requestedTarget !== undefined
    && (!Number.isSafeInteger(requestedTarget) || requestedTarget < 0)
  ) {
    throw new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_INVALID:${String(requestedTarget)}`);
  }
  const candidates = snapshots.flatMap((snapshot) => {
    if (requestedTarget !== undefined && snapshot.runtimeHeight > requestedTarget) return [];
    const snapshotHash = String(snapshot.checkpointHash || '').toLowerCase();
    const tail = validated
      .filter((bundle) =>
        bundle.kind === 'journal_tail'
        && bundle.baseRuntimeHeight === snapshot.runtimeHeight
        && String(bundle.baseCheckpointHash || '').toLowerCase() === snapshotHash
        && bundle.runtimeHeight > snapshot.runtimeHeight,
      )
      .filter((bundle) => requestedTarget === undefined || bundle.runtimeHeight >= requestedTarget)
      .sort((left, right) => right.runtimeHeight - left.runtimeHeight)[0];
    if (requestedTarget !== undefined && snapshot.runtimeHeight < requestedTarget && !tail) return [];
    return {
      snapshot,
      tail,
      height: requestedTarget ?? tail?.runtimeHeight ?? snapshot.runtimeHeight,
    };
  }).sort((left, right) => {
    if (right.height !== left.height) return right.height - left.height;
    return right.snapshot.runtimeHeight - left.snapshot.runtimeHeight;
  });
  if (candidates.length === 0) {
    throw new Error(`RECOVERY_BUNDLE_TARGET_HEIGHT_UNAVAILABLE:${String(requestedTarget)}`);
  }
  const best = candidates[0]!;
  const env = await restoreEnvFromCheckpointSnapshot(best.snapshot.checkpoint!, options);
  if (best.tail && best.height > best.snapshot.runtimeHeight) {
    try {
      await replayRecoveryFrameJournals(
        env,
        (best.tail.frames || []).filter(frame => frame.height <= best.height),
      );
    } catch (error) {
      if (options?.readOnly) throw error;
      return failRecoveryRestoreAfterCleanup(env, error);
    }
  }
  if (env.height !== best.height) {
    const mismatch = new Error(
      `RECOVERY_BUNDLE_TARGET_HEIGHT_MISMATCH:expected=${best.height}:actual=${env.height}`,
    );
    if (options?.readOnly) throw mismatch;
    return failRecoveryRestoreAfterCleanup(
      env,
      mismatch,
    );
  }
  if (!options?.readOnly) markRestoredReliableOutputsDue(env);
  return env;
};

const collectCertifiedStorageDocs = (
  lineagePlan: ReturnType<typeof buildCertifiedEntityLineagePlan>,
): { docs: StorageDoc[]; canonicalEntityHashes: ReturnType<typeof computeCanonicalEntityHash>[] } => {
  const docs: StorageDoc[] = [];
  const canonicalEntityHashes: ReturnType<typeof computeCanonicalEntityHash>[] = [];

  for (const [entityId, selected] of lineagePlan.lookup.entries()) {
    const core = projectEntityCoreDoc(selected.state);
    const accounts = new Map(Array.from(selected.state.accounts.entries(), ([counterpartyId, account]) => (
      [String(counterpartyId || '').toLowerCase(), projectAccountDoc(account)] as const
    )));
    const books = new Map(Array.from(selected.state.orderbookExt?.books?.entries?.() ?? [], ([pairId, book]) => (
      [String(pairId || '').trim(), book] as const
    )));
    const projectedState = hydrateEntityStateFromStorage({ core, accounts, books });
    const expectedHash = computeCanonicalEntityHash(selected.replica);
    const projectedHash = computeCanonicalEntityHash({ ...selected.replica, state: projectedState });
    if (projectedHash.hash !== expectedHash.hash) {
      throw new Error(
        `RECOVERY_IMPORT_PROJECTED_ENTITY_HASH_MISMATCH:entity=${entityId}:` +
        `expected=${expectedHash.hash}:projected=${projectedHash.hash}`,
      );
    }
    canonicalEntityHashes.push(expectedHash);
    docs.push({ family: 'entity', entityId, value: core });

    for (const [counterpartyId, account] of accounts.entries()) {
      const normalizedCounterparty = String(counterpartyId || '').toLowerCase();
      if (!normalizedCounterparty || !account) continue;
      docs.push({
        family: 'account',
        entityId,
        counterpartyId: normalizedCounterparty,
        value: account,
      });
    }

    for (const [pairId, book] of books.entries()) {
      const normalizedPairId = String(pairId || '').trim();
      if (!normalizedPairId || !book) continue;
      docs.push({
        family: 'book',
        entityId,
        pairId: normalizedPairId,
        value: book,
      });
    }
  }

  return { docs, canonicalEntityHashes };
};

// Recovery checkpoint imports are not an append to the local WAL. They seed a new
// local persistence base at the recovered runtime height, anchored by a materialized
// snapshot and a synthetic frame at that same height.
const persistRestoredEnvToDBUnlocked = async (
  env: Env,
  options: { onPersistenceBoundary?: StoragePersistenceBoundaryHook } = {},
): Promise<void> => {
  const restoredHeight = Number(env.height);
  const restoredTimestamp = Number(env.timestamp);
  if (!Number.isSafeInteger(restoredHeight) || restoredHeight <= 0) {
    throw new Error('RECOVERY_PERSIST_HEIGHT_REQUIRED');
  }
  if (!Number.isSafeInteger(restoredTimestamp) || restoredTimestamp < 0) {
    throw new Error('RECOVERY_PERSIST_TIMESTAMP_INVALID');
  }
  for (const replica of env.eReplicas.values()) {
    assertCertifiedJHistoryIntegrity(replica.state);
    assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
  }
  const lineagePlan = buildCertifiedEntityLineagePlan(env);
  const materialized = collectCertifiedStorageDocs(lineagePlan);
  const certifiedBoardNodes = collectReachableCertifiedBoardNodes(
    getCertifiedBoardNodeStore(env),
    Array.from(env.eReplicas.values(), ({ state }) => state.certifiedBoardState?.boardRegistryRoot)
      .filter((root): root is string => Boolean(root)),
  );
  const consumptionNodes = collectReachableConsumptionNodes(
    getConsumptionNodeStore(env),
    getLiveConsumptionAccumulatorStates(env),
  );
  const accountJClaimNodes = collectReachableAccountJClaimNodes(
    getAccountJClaimNodeStore(env),
    getLiveAccountJClaimAccumulatorStates(env),
  );
  const runtimeMachine = buildDurableRuntimeMachineSnapshot(env);
  const canonicalStateHash = computeCanonicalRuntimeStateHash(
    restoredHeight,
    restoredTimestamp,
    materialized.canonicalEntityHashes,
    runtimeMachine,
  );

  if (!(await tryOpenStorageDb(env, 'current'))) {
    throw new Error('RECOVERY_PERSIST_STORAGE_OPEN_FAILED');
  }
  if (!(await tryOpenFrameDb(env))) {
    throw new Error('RECOVERY_PERSIST_FRAME_DB_OPEN_FAILED');
  }

  const currentDb = getStorageDb(env, 'current');
  const frameDb = getFrameDb(env);
  const puts = materialized.docs;
  const replicaMetas = buildStorageReplicaMetaCommitment(env, lineagePlan).entries;
  const replacement = await replaceRestoredStorageBase({
    currentDb,
    historyDb: frameDb,
    height: restoredHeight,
    timestamp: restoredTimestamp,
    docs: puts,
    replicaMetas,
    headConfig: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      snapshotPeriodFrames: Math.max(1, Number(env.runtimeConfig?.storage?.snapshotPeriodFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES)),
      retainSnapshots: Math.max(1, Number(env.runtimeConfig?.storage?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS)),
      epochMaxBytes: Math.max(1, Number(env.runtimeConfig?.storage?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES)),
      accountMerkleRadix: env.runtimeConfig?.storage?.accountMerkleRadix === 256 ? 256 : DEFAULT_ACCOUNT_MERKLE_RADIX,
    },
    canonicalEntityHashes: materialized.canonicalEntityHashes,
    canonicalStateHash,
    runtimeMachine,
    certifiedBoardNodes: Array.from(certifiedBoardNodes, ([hash, node]) => ({ hash, node })),
    consumptionNodes: Array.from(consumptionNodes, ([hash, node]) => ({ hash, node })),
    accountJClaimNodes: Array.from(accountJClaimNodes, ([hash, node]) => ({ hash, node })),
    ...(options.onPersistenceBoundary
      ? { onPersistenceBoundary: options.onPersistenceBoundary }
      : {}),
  });

  if (await tryOpenStorageDb(env, 'previous')) {
    await clearDatabase(getStorageDb(env, 'previous'));
  }

  const state = ensureRuntimeState(env);
  state.storageEntityHashDocs = replacement.entityHashDocs;
  state.currentStorageOverlayMarks = [];
};

export const persistRestoredEnvToDB = async (
  env: Env,
  options: { onPersistenceBoundary?: StoragePersistenceBoundaryHook } = {},
): Promise<void> => {
  if (!Number.isSafeInteger(Number(env.height)) || Number(env.height) <= 0) {
    throw new Error('RECOVERY_PERSIST_HEIGHT_REQUIRED');
  }
  if (!Number.isSafeInteger(Number(env.timestamp)) || Number(env.timestamp) < 0) {
    throw new Error('RECOVERY_PERSIST_TIMESTAMP_INVALID');
  }
  await withStorageWriterLock(env, () => persistRestoredEnvToDBUnlocked(env, options));
};

const assertPersistedContractConfigReady = (env: Env, label: string): void => {
  for (const [name, replica] of env.jReplicas.entries()) {
    try {
      requireDurableJurisdictionStack(replica);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}:${label}:${name}`, { cause: error });
    }
  }
};

const findJurisdictionEntryByName = (
  env: Env,
  name: string,
): [string, JReplica] | null => {
  const normalized = String(name || '').trim().toLowerCase();
  for (const entry of env.jReplicas.entries()) {
    if (String(entry[0] || '').trim().toLowerCase() === normalized) return entry;
  }
  return null;
};

const registerCommittedSingleSignerWallet = (
  env: Env,
  replica: EntityReplica,
): void => {
  const validators = replica.state.config.validators;
  if (validators.length !== 1 || replica.state.config.threshold !== 1n) return;
  const signerId = String(validators[0] || '').trim().toLowerCase();
  if (!signerId) throw new Error(`ENTITY_SINGLE_SIGNER_MISSING:${replica.entityId}`);
  if (String(replica.signerId || '').trim().toLowerCase() !== signerId) {
    throw new Error(
      `ENTITY_SINGLE_SIGNER_REPLICA_MISMATCH:${replica.entityId}:${replica.signerId}:${signerId}`,
    );
  }
  const privateKey = getLocalSignerPrivateKey(env, signerId);
  if (privateKey === null) return;
  const jurisdiction = replica.state.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress || !jurisdiction.chainId) {
    throw new Error(`ENTITY_JURISDICTION_BINDING_INCOMPLETE:${replica.entityId}`);
  }
  const jurisdictionReplica = findWatcherJurisdictionReplica(
    env,
    jurisdiction.depositoryAddress,
    jurisdiction.chainId,
  );
  if (!jurisdictionReplica) {
    throw new Error(
      `ENTITY_JURISDICTION_REPLICA_MISSING:${replica.entityId}:${jurisdiction.chainId}:${jurisdiction.depositoryAddress}`,
    );
  }
  const hasExternalRpc = (jurisdictionReplica.rpcs ?? []).some((rpc) => {
    const normalized = String(rpc || '').trim().toLowerCase();
    return normalized.length > 0 && !normalized.startsWith('browservm:');
  });
  const liveAdapter = jurisdictionReplica.jadapter;
  if (!liveAdapter) {
    if (hasExternalRpc) {
      // RPC submission carries an already assembled Hanko and is signed by the
      // jurisdiction transaction sender. Entity private keys never belong in
      // the RPC adapter, whose registerEntityWallet implementation is a no-op.
      return;
    }
    runtimeLog.debug('browservm.wallet_bind_deferred', {
      entityId: replica.entityId,
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    });
    return;
  }
  if (liveAdapter.mode !== 'browservm' && hasExternalRpc) return;
  const registerWallet = liveAdapter.registerEntityWallet;
  if (!registerWallet) {
    throw new Error(`ENTITY_JURISDICTION_WALLET_BINDER_MISSING:${replica.entityId}`);
  }
  registerWallet(replica.entityId, ethers.hexlify(privateKey));
};

const registerCommittedSingleSignerWallets = (
  env: Env,
  entityIds?: ReadonlySet<string>,
): void => {
  for (const replica of env.eReplicas.values()) {
    if (entityIds && !entityIds.has(replica.entityId.toLowerCase())) continue;
    registerCommittedSingleSignerWallet(env, replica);
  }
};

const reconcileCommittedRuntimeInfraEffects = async (
  env: Env,
  runtimeTxs: readonly RuntimeTx[],
): Promise<void> => {
  const jurisdictionNames = new Set<string>();
  const importedEntityIds = new Set<string>();
  for (const runtimeTx of runtimeTxs) {
    if (runtimeTx.type === 'completeImportJ') jurisdictionNames.add(runtimeTx.data.name);
    if (runtimeTx.type === 'importJ' && findJurisdictionEntryByName(env, runtimeTx.data.name)) {
      jurisdictionNames.add(runtimeTx.data.name);
    }
    if (runtimeTx.type === 'importReplica') {
      importedEntityIds.add(runtimeTx.entityId.toLowerCase());
    }
  }
  for (const name of jurisdictionNames) {
    const entry = findJurisdictionEntryByName(env, name);
    if (!entry) throw new Error(`COMMITTED_JURISDICTION_REPLICA_MISSING:${name}`);
    const adapter = await ensureLiveJAdapterForReplica(env, entry[0], {
      allowBrowserVm: true,
      context: `postcommit:${entry[0]}`,
      attempts: typeof window !== 'undefined' ? 5 : 3,
    });
    if (!adapter) throw new Error(`COMMITTED_JURISDICTION_ADAPTER_MISSING:${entry[0]}`);
    if (adapter.mode === 'browservm') {
      const browserVM = adapter.getBrowserVM();
      if (!browserVM) throw new Error(`COMMITTED_BROWSERVM_MISSING:${entry[0]}`);
      setBrowserVMJurisdiction(env, adapter.addresses.depository, adapter.chainId, browserVM);
    }
  }
  if (jurisdictionNames.size > 0) {
    assertPersistedContractConfigReady(env, 'postcommit jurisdiction import');
    registerCommittedSingleSignerWallets(env);
    startJurisdictionWatchers(env);
  } else if (importedEntityIds.size > 0) {
    registerCommittedSingleSignerWallets(env, importedEntityIds);
  }
};

const hasPendingLocalReliableOutput = (env: Env): boolean => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId) return false;
  return (env.pendingNetworkOutputs ?? []).some(output =>
    normalizeRuntimeId(output.runtimeId) === runtimeId && getReliableOutputIdentity(output) !== null);
};

const queueLocalOutputsWithReliability = (
  env: Env,
  localOutputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId && localOutputs.some(output => getReliableOutputIdentity(output) !== null)) {
    throw new Error('RELIABLE_LOCAL_RUNTIME_ID_MISSING');
  }
  const inputs: RoutedEntityInput[] = [];
  const receipts: ReliableDeliveryReceipt[] = [];
  const retained: RoutedEntityInput[] = [];
  for (const originatedOutput of localOutputs) {
    const { sourceRuntimeFrame: _sourceRuntimeFrame, ...output } = originatedOutput;
    if (!getReliableOutputIdentity(output)) {
      inputs.push(output);
      continue;
    }
    const deliverable = { ...output, runtimeId: runtimeId! };
    retained.push(deliverable);
    const registration = registerReliableIngress(env, runtimeId!, deliverable);
    if (registration.kind === 'enqueue') inputs.push(deliverable);
    if (registration.kind === 'receipt') {
      registerReliableReceiptIngress(env, registration.receipt);
      receipts.push(registration.receipt);
    }
  }
  enqueueRuntimeContinuation(
    env,
    inputs,
    undefined,
    undefined,
    env.timestamp,
    receipts,
  );
  return retained;
};

const applyDeterministicRuntimeOutputPlan = (
  env: Env,
  entityOutbox: readonly RoutedEntityInput[],
  outputRoutingDeps: RuntimeOutputRoutingDeps,
) => {
  const originatedEntityOutbox = entityOutbox.map(output => output.sourceRuntimeFrame
    ? output
    : {
        ...output,
        sourceRuntimeFrame: {
          height: env.height,
          timestamp: env.timestamp,
        },
      });
  const pendingBeforePlan = buildPendingNetworkOutputs(pruneReceiptedReliableOutputs(env, [
    ...(env.pendingNetworkOutputs ?? []),
    ...originatedEntityOutbox,
  ]));
  const { ready, waiting } = splitPendingOutputsByRetryWindow(
    env,
    pendingBeforePlan,
    outputRoutingDeps,
  );
  const plan = planEntityOutputs(env, ready, outputRoutingDeps);
  const retainedLocalReliableOutputs = queueLocalOutputsWithReliability(env, plan.localOutputs);
  env.pendingNetworkOutputs = buildPendingNetworkOutputs([
    ...waiting,
    ...plan.deferredOutputs,
    ...plan.remoteOutputs.map(({ output }) => output),
    ...retainedLocalReliableOutputs,
  ]);
  return { ...plan, readyPendingOutputs: ready, waitingPendingOutputs: waiting, retainedLocalReliableOutputs };
};

const applyCommittedLocalReliableReceipts = (
  env: Env,
  commits: ReliableIngressCommit[],
  options: {
    isReplay?: boolean;
    replayInputs?: readonly RoutedEntityInput[];
  } = {},
): void => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId) return;
  const localCommits: ReliableIngressCommit[] = [];
  for (const commit of commits) {
    if (!commit.receipt || !commit.targetRuntimeIds.includes(runtimeId)) continue;
    // Live execution proves sender ownership through the exact durable outbox
    // item. Sparse-WAL replay intentionally does not retain pre-frame state;
    // its authenticated `from === runtimeId` input is the equivalent proof and
    // the frame's post-state outputs are installed after reducer replay.
    localCommits.push(commit);
  }
  const pendingOutputs = env.pendingNetworkOutputs ?? [];
  const pendingMatches = matchReceiptsToOutputs(
    pendingOutputs,
    localCommits.flatMap(commit => commit.receipt ? [commit.receipt] : []),
  );
  const selected = new Map<ReliableDeliveryReceipt, RoutedEntityInput>(pendingMatches);
  if (options.isReplay) {
    const uncovered = localCommits
      .filter(commit => commit.receipt && !selected.has(commit.receipt));
    if (uncovered.length > 0) {
      const replayInputs = options.replayInputs?.flatMap(splitRoutedOutputByDeliveryLane) ?? [];
      const replayMatches = matchReceiptsToOutputs(
        replayInputs,
        uncovered.flatMap(commit => commit.receipt ? [commit.receipt] : []),
      );
      for (const commit of uncovered) {
        const receipt = commit.receipt!;
        const replayOutput = replayMatches.get(receipt);
        if (!replayOutput) {
          throw new Error(
            `RELIABLE_LOCAL_REPLAY_OUTPUT_PROOF_MISSING:` +
            `${receipt.body.identity.kind}:${receipt.body.identity.height}`,
          );
        }
        env.pendingNetworkOutputs = [...(env.pendingNetworkOutputs ?? []), replayOutput];
        selected.set(receipt, replayOutput);
      }
    }
  }
  const receipts = [...selected.keys()];
  const selectedSignatures = new Set(receipts.map(receipt => receipt.signature));
  for (const commit of localCommits) {
    if (!commit.receipt || !selectedSignatures.has(commit.receipt.signature)) continue;
    commit.targetRuntimeIds = commit.targetRuntimeIds.filter(target => target !== runtimeId);
  }
  if (receipts.length > 0) {
    const unique = [...new Map(receipts.map(receipt => [receipt.signature, receipt])).values()];
    applyReliableDeliveryReceipts(env, unique);
  }
};

const RUNTIME_FRAME_SHARED_STATE_KEYS = new Set<string>([
  'loopActive',
  'loopPromise',
  'stopLoop',
  'wakeLoop',
  'processingPromise',
  'p2p',
  'envChangeCallbacks',
  'runtimeFrameCommitCallbacks',
  'db',
  'dbOpenPromise',
  'storageDb',
  'storageDbOpenPromise',
  'storagePreviousDb',
  'storagePreviousDbOpenPromise',
  'storageEpochRotatePromise',
  'frameDb',
  'frameDbOpenPromise',
  'infraDb',
  'infraDbOpenPromise',
  'infraDbPendingWrites',
  'runtimeSyncChannel',
  'directEntityInputsDispatch',
  'directReliableReceiptDispatch',
  'canUseConnectedRelayFallback',
  'recoveryBackupBarrier',
  'watcherDedupCounter',
  'runtimeFrameIngressBuffer',
]);

const RUNTIME_FRAME_CONCURRENT_STATE_KEYS = new Set<string>([
  'lifecyclePhase',
  'halted',
  'fatalDebugPayload',
  'wakeRequested',
  'persistencePaused',
  'persistenceQuiescing',
  'pendingP2PConfig',
  'lastP2PConfig',
  'logState',
  'cleanLogs',
  'pendingAuditEvents',
  'recentJEvents',
  'recentReserveUpdatedEvents',
  'verifiedProfileRoutes',
  'externalWalletWatchOwners',
  'infraDbClosing',
  'inFlightEntityInputs',
]);

type RuntimeFrameTransaction = {
  liveEnv: Env;
  workingEnv: Env;
  ingressBuffer: RuntimeFrameIngressBuffer;
  liveFrameLogBaseLength: number;
  workingCleanLogBaseLength: number;
  liveAdapters: Set<JAdapter>;
  published: boolean;
};

const cloneRuntimeFrameState = (env: Env): NonNullable<Env['runtimeState']> => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env.runtimeState ?? {})) {
    if (key === 'scheduledWakeIndex') continue;
    if (RUNTIME_FRAME_SHARED_STATE_KEYS.has(key)) {
      cloned[key] = value;
      continue;
    }
    try {
      cloned[key] = structuredClone(value);
    } catch (error) {
      throw new Error(`RUNTIME_FRAME_STATE_CLONE_FAILED:${key}`, { cause: error });
    }
  }
  return cloned as NonNullable<Env['runtimeState']>;
};

export const cloneRuntimeFrameMempool = (input: RuntimeInput): RuntimeInput => {
  const cloned = cloneIsolatedRuntimeInput(input);
  input.runtimeTxs.forEach((source, index) => {
    const target = cloned.runtimeTxs[index];
    if (!target) throw new Error(`RUNTIME_FRAME_RUNTIME_TX_CLONE_MISSING:${index}`);
    copyLocalJAuthorityRuntimeTxAuthorization(source, target);
    copyLocalJSubmitRuntimeTxAuthorization(source, target);
    copyLocalJImportResultRuntimeTxAuthorization(source, target);
    copyLocalEntityProviderActionRuntimeTxAuthorization(source, target);
    copyLocalRuntimeAdapterCommandAuthorization(source, target);
  });
  input.entityInputs.forEach((source, inputIndex) => {
    const target = cloned.entityInputs[inputIndex];
    if (!target) throw new Error(`RUNTIME_FRAME_ENTITY_INPUT_CLONE_MISSING:${inputIndex}`);
    if ((target.entityTxs?.length ?? 0) !== (source.entityTxs?.length ?? 0)) {
      throw new Error(`RUNTIME_FRAME_ENTITY_TX_CLONE_SHAPE_MISMATCH:${inputIndex}`);
    }
    source.entityTxs?.forEach((sourceTx, txIndex) => {
      const targetTx = target.entityTxs?.[txIndex];
      if (!targetTx) throw new Error(`RUNTIME_FRAME_ENTITY_TX_CLONE_MISSING:${inputIndex}:${txIndex}`);
      copyLocalScheduledWakeAuthorization(sourceTx, targetTx);
      copyDeterministicHtlcTestSecretCapability(sourceTx, targetTx);
    });
    if (source.leaderTimeoutVote) {
      if (!target.leaderTimeoutVote) {
        throw new Error(`RUNTIME_FRAME_LEADER_VOTE_CLONE_MISSING:${inputIndex}`);
      }
      copyLocalEntityLeaderTimeoutVoteAuthorization(
        source.leaderTimeoutVote,
        target.leaderTimeoutVote,
      );
    }
  });
  return cloned;
};

const createRuntimeFrameGossipSnapshot = (env: Env): Env['gossip'] => {
  const gossip = createGossipLayer();
  // These profiles already passed parse/signature verification at external
  // ingress. Re-announcing every profile into the private frame transaction
  // verifies every signature again and made a user Runtime spend seconds in
  // secp256k1 recovery before it could receive the hub's Account ACK. Copy the
  // verified projection by value; untrusted profiles must still enter through
  // gossip.announce/setProfiles at the network/storage boundaries.
  for (const profile of env.gossip?.getProfiles?.() ?? []) {
    const cloned = structuredClone(profile);
    gossip.profiles.set(cloned.entityId, cloned);
  }
  return gossip;
};

const cloneRuntimeFrameWorkingEnv = (sourceEnv: Env): Env => {
  const workingMempool = cloneRuntimeFrameMempool(ensureRuntimeMempool(sourceEnv));
  const workingState = cloneRuntimeFrameState(sourceEnv);
  const workingEnv: Env = {
    ...sourceEnv,
    eReplicas: new Map(Array.from(sourceEnv.eReplicas.entries(), ([key, replica]) => [
      key,
      // Runtime-frame isolation is not a persistence boundary. Preserve the
      // hidden incremental Account commitment caches while cloning the live
      // replica; snapshot projection intentionally drops them and forced every
      // large hub Account back through a full cold trie rebuild per R-frame.
      cloneTrustedEntityReplica(replica),
    ])),
    jReplicas: new Map<string, JReplica>(Array.from(sourceEnv.jReplicas.entries(), ([key, replica]) => [
      key,
      {
        ...buildCanonicalJReplicaSnapshot(replica),
        ...(replica.jadapter ? { jadapter: replica.jadapter } : {}),
      },
    ])),
    runtimeState: workingState,
    runtimeMempool: workingMempool,
    runtimeInput: workingMempool,
    ...(sourceEnv.runtimeConfig ? { runtimeConfig: structuredClone(sourceEnv.runtimeConfig) } : {}),
    ...(sourceEnv.browserVMState ? { browserVMState: structuredClone(sourceEnv.browserVMState) } : {}),
    ...(sourceEnv.overlay ? { overlay: structuredClone(sourceEnv.overlay) } : {}),
    ...(sourceEnv.pendingOutputs
      ? { pendingOutputs: cloneIsolatedRoutedEntityInputs(sourceEnv.pendingOutputs) }
      : {}),
    ...(sourceEnv.networkInbox
      ? { networkInbox: cloneIsolatedRoutedEntityInputs(sourceEnv.networkInbox) }
      : {}),
    ...(sourceEnv.pendingNetworkOutputs
      ? { pendingNetworkOutputs: cloneIsolatedRoutedEntityInputs(sourceEnv.pendingNetworkOutputs) }
      : {}),
    frameLogs: structuredClone(sourceEnv.frameLogs),
    history: [...sourceEnv.history],
    gossip: createRuntimeFrameGossipSnapshot(sourceEnv),
    evms: new Map(sourceEnv.evms),
    ...(sourceEnv.extra ? { extra: structuredClone(sourceEnv.extra) } : {}),
  };
  attachEventEmitters(workingEnv);
  if (sourceEnv.runtimeState?.scheduledWakeIndex !== undefined) rebuildScheduledWakeIndex(workingEnv);
  return workingEnv;
};

const createRuntimeFrameTransaction = (liveEnv: Env): RuntimeFrameTransaction => {
  const workingEnv = cloneRuntimeFrameWorkingEnv(liveEnv);
  const workingMempool = ensureRuntimeMempool(workingEnv);
  const workingState = ensureRuntimeState(workingEnv);
  const concurrentMempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
  const ingressBuffer = beginRuntimeFrameIngressBuffer(liveEnv);
  // Operational producers read the live Env while this private working Env is
  // executing. Preserve the detached Entity count until publish or rollback;
  // processingPromise alone also covers harmless runtime-only bookkeeping.
  ensureRuntimeState(liveEnv).inFlightEntityInputs = workingMempool.entityInputs.length;
  liveEnv.runtimeMempool = concurrentMempool;
  liveEnv.runtimeInput = concurrentMempool;
  return {
    liveEnv,
    workingEnv,
    ingressBuffer,
    liveFrameLogBaseLength: liveEnv.frameLogs.length,
    workingCleanLogBaseLength: workingState.cleanLogs?.length ?? 0,
    liveAdapters: new Set(Array.from(liveEnv.jReplicas.values())
      .flatMap(replica => replica.jadapter ? [replica.jadapter] : [])),
    published: false,
  };
};

const closeUncommittedJAdapters = async (
  transaction: RuntimeFrameTransaction,
): Promise<Error[]> => {
  const uncommitted = new Set(Array.from(transaction.workingEnv.jReplicas.values())
    .flatMap(replica => replica.jadapter && !transaction.liveAdapters.has(replica.jadapter)
      ? [replica.jadapter]
      : []));
  const settled = await Promise.allSettled(Array.from(uncommitted, adapter => adapter.close()));
  return settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
};

const runtimeInputHasQueuedWork = (input: RuntimeInput): boolean =>
  input.runtimeTxs.length > 0 ||
  input.entityInputs.length > 0 ||
  (input.jInputs?.length ?? 0) > 0 ||
  (input.reliableReceipts?.length ?? 0) > 0;

const mergeRuntimeFrameMempools = (frame: RuntimeInput, concurrent: RuntimeInput): RuntimeInput => {
  const merged: RuntimeInput = {
    runtimeTxs: [...frame.runtimeTxs, ...concurrent.runtimeTxs],
    entityInputs: [...frame.entityInputs, ...concurrent.entityInputs],
    ...((frame.jInputs?.length ?? 0) + (concurrent.jInputs?.length ?? 0) > 0
      ? { jInputs: [...(frame.jInputs ?? []), ...(concurrent.jInputs ?? [])] }
      : {}),
    ...((frame.reliableReceipts?.length ?? 0) + (concurrent.reliableReceipts?.length ?? 0) > 0
      ? { reliableReceipts: [...(frame.reliableReceipts ?? []), ...(concurrent.reliableReceipts ?? [])] }
      : {}),
  };
  const queuedAt = [frame.queuedAt, concurrent.queuedAt]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .reduce<number | undefined>((latest, value) => latest === undefined ? value : Math.max(latest, value), undefined);
  if (runtimeInputHasQueuedWork(merged) && queuedAt !== undefined) merged.queuedAt = queuedAt;
  return merged;
};

const mergeRuntimeEntityHints = (
  working: NonNullable<Env['runtimeState']>['entityRuntimeHints'],
  live: NonNullable<Env['runtimeState']>['entityRuntimeHints'],
): NonNullable<Env['runtimeState']>['entityRuntimeHints'] => {
  const merged = new Map(working ?? []);
  for (const [entityId, candidate] of live ?? []) {
    const current = merged.get(entityId);
    if (!current || candidate.seenAt > current.seenAt) merged.set(entityId, candidate);
  }
  return merged;
};

const publishRuntimeFrameTransaction = (transaction: RuntimeFrameTransaction): Env => {
  if (transaction.published) return transaction.liveEnv;
  const { liveEnv, workingEnv } = transaction;
  const liveState = ensureRuntimeState(liveEnv);
  const workingState = ensureRuntimeState(workingEnv);
  const concurrentMempool = ensureRuntimeMempool(liveEnv);
  const workingMempool = ensureRuntimeMempool(workingEnv);
  const liveOnlyState = new Map<string, unknown>();
  for (const key of new Set([...RUNTIME_FRAME_SHARED_STATE_KEYS, ...RUNTIME_FRAME_CONCURRENT_STATE_KEYS])) {
    if (Object.prototype.hasOwnProperty.call(liveState, key)) {
      liveOnlyState.set(key, (liveState as Record<string, unknown>)[key]);
    }
  }
  const mergedHints = mergeRuntimeEntityHints(workingState.entityRuntimeHints, liveState.entityRuntimeHints);
  for (const key of Object.keys(liveState)) delete (liveState as Record<string, unknown>)[key];
  for (const [key, value] of Object.entries(workingState)) {
    if (!RUNTIME_FRAME_SHARED_STATE_KEYS.has(key) && !RUNTIME_FRAME_CONCURRENT_STATE_KEYS.has(key)) {
      (liveState as Record<string, unknown>)[key] = value;
    } else if (RUNTIME_FRAME_SHARED_STATE_KEYS.has(key) && !liveOnlyState.has(key)) {
      // Infra handles opened by this frame (notably LevelDB on the first
      // persisted frame) must remain attached after publish. Existing live
      // handles still win below so concurrent infra cannot be overwritten.
      (liveState as Record<string, unknown>)[key] = value;
    }
  }
  for (const [key, value] of liveOnlyState) (liveState as Record<string, unknown>)[key] = value;
  if (mergedHints) liveState.entityRuntimeHints = mergedHints;

  const workingCleanLogTail = (workingState.cleanLogs ?? []).slice(transaction.workingCleanLogBaseLength);
  if (workingCleanLogTail.length > 0) {
    liveState.cleanLogs = [...(liveState.cleanLogs ?? []), ...workingCleanLogTail].slice(-2_000);
  }
  liveState.logState ??= { nextId: 0, mirrorToConsole: true };
  liveState.logState.nextId = Math.max(
    liveState.logState.nextId,
    workingState.logState?.nextId ?? 0,
  );

  liveEnv.height = workingEnv.height;
  liveEnv.timestamp = workingEnv.timestamp;
  liveEnv.eReplicas = workingEnv.eReplicas;
  liveEnv.jReplicas = workingEnv.jReplicas;
  if (workingEnv.activeJurisdiction === undefined) delete liveEnv.activeJurisdiction;
  else liveEnv.activeJurisdiction = workingEnv.activeJurisdiction;
  if (workingEnv.browserVM === undefined) delete liveEnv.browserVM;
  else liveEnv.browserVM = workingEnv.browserVM;
  if (workingEnv.browserVMState === undefined) delete liveEnv.browserVMState;
  else liveEnv.browserVMState = workingEnv.browserVMState;
  if (workingEnv.jAdapter === undefined) delete liveEnv.jAdapter;
  else liveEnv.jAdapter = workingEnv.jAdapter;
  liveEnv.evms = workingEnv.evms;
  if (workingEnv.overlay === undefined) delete liveEnv.overlay;
  else liveEnv.overlay = workingEnv.overlay;
  if (workingEnv.pendingOutputs === undefined) delete liveEnv.pendingOutputs;
  else liveEnv.pendingOutputs = workingEnv.pendingOutputs;
  if (workingEnv.networkInbox === undefined) delete liveEnv.networkInbox;
  else liveEnv.networkInbox = workingEnv.networkInbox;
  if (workingEnv.pendingNetworkOutputs === undefined) delete liveEnv.pendingNetworkOutputs;
  else liveEnv.pendingNetworkOutputs = workingEnv.pendingNetworkOutputs;
  liveEnv.history = [];
  if (workingEnv.extra === undefined) delete liveEnv.extra;
  else liveEnv.extra = workingEnv.extra;
  liveEnv.frameLogs = liveEnv.frameLogs.slice(transaction.liveFrameLogBaseLength);
  const mergedMempool = mergeRuntimeFrameMempools(workingMempool, concurrentMempool);
  liveEnv.runtimeMempool = mergedMempool;
  liveEnv.runtimeInput = mergedMempool;
  liveState.wakeRequested =
    liveState.wakeRequested === true ||
    runtimeInputHasQueuedWork(mergedMempool) ||
    (liveState.pendingProfileCertificationEntityIds?.size ?? 0) > 0;
  rebuildScheduledWakeIndex(liveEnv);
  for (const jReplica of liveEnv.jReplicas.values()) jReplica.jadapter?.setBlockTimestamp(liveEnv.timestamp);
  transaction.published = true;
  return liveEnv;
};

const abortRuntimeFrameTransaction = async (
  transaction: RuntimeFrameTransaction,
): Promise<Error[]> => {
  const cleanupErrors = await closeUncommittedJAdapters(transaction);
  for (const jReplica of transaction.liveEnv.jReplicas.values()) {
    jReplica.jadapter?.setBlockTimestamp(transaction.liveEnv.timestamp);
  }
  return cleanupErrors;
};

// === CONSENSUS PROCESSING ===
// ONE TICK = ONE ITERATION. No cascade. E→E communication always requires new tick.

export const process = async (env: Env, inputs?: EntityInput[], runtimeDelay = 0) => {
  const liveEnv = env;
  const processState = ensureRuntimeState(env);
  while (processState.processingPromise) {
    await processState.processingPromise;
  }
  let releaseProcessLock: () => void = () => {};
  processState.processingPromise = new Promise<void>(resolve => {
    releaseProcessLock = resolve;
  });

  const processProfileStartMs = getPerfMs();
  const processProfileEnabled = runtimeProcessProfileEnabled();
  const processProfileCpuStart = processProfileEnabled && nodeProcess?.cpuUsage
    ? nodeProcess.cpuUsage()
    : undefined;
  const processProfileMarks: Record<string, number> = {};
  const processProfileMetrics = {
    triggerReason: processProfileEnabled ? getRuntimeWorkReason(env) : undefined,
    heightBefore: env.height,
    heightAfter: env.height,
    timestampBefore: env.timestamp,
    timestampAfter: env.timestamp,
    runtimeTxs: 0,
    entityInputs: 0,
    entityTxs: 0,
    jInputs: 0,
    reliableReceipts: 0,
    localOutputs: 0,
    remoteOutputs: 0,
    deferredOutputs: 0,
    pendingNetworkBefore: env.pendingNetworkOutputs?.length ?? 0,
    readyPendingOutputs: 0,
    waitingPendingOutputs: 0,
    pendingNetworkAfter: env.pendingNetworkOutputs?.length ?? 0,
    deferredNetworkMeta: env.runtimeState?.deferredNetworkMeta?.size ?? 0,
    jOutputs: 0,
    frameAdvanced: false,
    storageMs: undefined as Awaited<ReturnType<typeof saveRuntimeFrameToStorage>>['persistencePerfMs'],
    cpuMs: undefined as { user: number; system: number; total: number } | undefined,
    accountCausality: undefined as {
      ingress: EntityInputCausalTrace[];
      egress: EntityInputCausalTrace[];
    } | undefined,
  };
  let processProfileOutcome = 'unknown';
  let reliableIngressCommits: ReliableIngressCommit[] = [];
  let reliableReceiptSenderCheckpoint: ReliableReceiptSenderCheckpoint | undefined;
  let reliableReceiptDeliveries: Array<{
    runtimeId: string;
    receipt: ReliableDeliveryReceipt;
  }> = [];
  let reliableReceiptStateDurable = false;
  let frameCommitDisposition: 'undurable' | 'committed' | 'unknown' = 'undurable';
  let frameRollbackHandled = false;
  let frameTransaction: RuntimeFrameTransaction | undefined;
  let pendingRuntimeTraceSnapshot: EnvSnapshot | undefined;
  let rollbackUndurableFrame: ((
    error: unknown,
    options?: { quarantine?: boolean; requeue?: boolean },
  ) => Promise<Error>) | undefined;
  const markProcessProfile = (label: string): void => {
    processProfileMarks[label] = Math.round(getPerfMs() - processProfileStartMs);
    // Operational watchdog progress only. Keep this on the live Env so a
    // long private frame remains observable without contaminating RJEA state.
    liveEnv.activeProcessProgressAt = Date.now();
    liveEnv.activeProcessProgressStep = label;
  };
  const logProcessProfile = (): void => {
    processProfileMetrics.heightAfter = env.height;
    processProfileMetrics.timestampAfter = env.timestamp;
    const elapsedMs = Math.round(getPerfMs() - processProfileStartMs);
    if (processProfileCpuStart && nodeProcess?.cpuUsage) {
      const cpu = nodeProcess.cpuUsage(processProfileCpuStart);
      const user = cpu.user / 1_000;
      const system = cpu.system / 1_000;
      processProfileMetrics.cpuMs = { user, system, total: user + system };
    }
    const hasProfileWork =
      processProfileMetrics.runtimeTxs > 0 ||
      processProfileMetrics.entityInputs > 0 ||
      processProfileMetrics.jInputs > 0 ||
      processProfileMetrics.reliableReceipts > 0 ||
      processProfileMetrics.localOutputs > 0 ||
      processProfileMetrics.remoteOutputs > 0 ||
      processProfileMetrics.jOutputs > 0 ||
      processProfileMetrics.frameAdvanced;
    if ((!processProfileEnabled || !hasProfileWork) && elapsedMs < runtimeProcessSlowMs()) return;
    const profileFields = {
      outcome: processProfileOutcome,
      elapsedMs,
      ...processProfileMetrics,
      phases: cumulativeMarksToPhases(processProfileMarks, elapsedMs),
    };
    // Completed-frame timings are telemetry consumed by the perf analyzer, not
    // degraded operation. Preserve WARN for incomplete/failed frame outcomes.
    if (processProfileOutcome === 'completed') runtimeLog.info('process.profile', profileFields);
    else runtimeLog.warn('process.profile', profileFields);
  };

  try {
    // IMPORTANT: capture frame baseline only after acquiring the process lock.
    // If captured before waiting on an in-flight tick, we can mis-detect
    // frame advancement and overwrite WAL entries with empty runtime input.
    const frameHeightBeforeTick = env.height;
    const frameTimestampBeforeTick = env.timestamp;
    env.lastProcessEnteredAt = Date.now();
    env.activeProcessProgressAt = env.lastProcessEnteredAt;
    env.activeProcessProgressStep = 'entered';

    if (!env.emit) {
      attachEventEmitters(env);
    }

    if (env.stopAtFrame !== undefined && env.height >= env.stopAtFrame) {
      console.log(`\n⏸️  FRAME STEPPING: Stopped at frame ${env.height}`);
      console.log('═'.repeat(80));
      const { formatRuntime } = await import('./qa/runtime-ascii');
      console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, maxSwaps: 20 }));
      console.log('═'.repeat(80) + '\n');
      console.log('💾 State captured - use jq on /tmp/{scenario}-runtime.json for deep queries');
      throw new Error(`FRAME_STEP: Stopped at frame ${env.height} for debugging`);
    }

    const ingressNow = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    if (inputs && inputs.length > 0) {
      enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressNow);
    }
    if (env.pendingOutputs && env.pendingOutputs.length > 0) {
      enqueueRuntimeContinuation(env, env.pendingOutputs, undefined, undefined, ingressNow);
      env.pendingOutputs = [];
    }
    if (env.networkInbox && env.networkInbox.length > 0) {
      enqueueRuntimeContinuation(env, env.networkInbox, undefined, undefined, ingressNow);
      env.networkInbox = [];
    }
    markProcessProfile('ingressQueues');
    await materializePendingJurisdictionImportResults(env, (runtimeTx) => {
      enqueueRuntimeContinuation(
        env,
        undefined,
        [runtimeTx],
        undefined,
        env.scenarioMode ? env.timestamp : getWallClockMs(),
      );
    });
    markProcessProfile('jurisdictionImports');
    const pendingProfileCertificationEntityIds = processState.pendingProfileCertificationEntityIds;
    const profileCertificationInputs = collectDueLocalProfileCertificationInputs(
      env,
      pendingProfileCertificationEntityIds,
    );
    // Undefined means the first post-start scan covered every local Entity.
    // Later scans consume only Entities dirtied by the preceding committed
    // Runtime frame; a crash naturally restores the one-time full scan.
    processState.pendingProfileCertificationEntityIds = new Set();
    if (profileCertificationInputs.length > 0) {
      // Derived local work belongs to the already-open ingress boundary. Do
      // not replace an explicit queued timestamp with the wall clock observed
      // later by process(); that would make the same signed input hash
      // differently depending on scheduler latency.
      const profileIngressTimestamp = ensureRuntimeMempool(env).queuedAt ?? ingressNow;
      enqueueRuntimeContinuation(
        env,
        profileCertificationInputs,
        undefined,
        undefined,
        profileIngressTimestamp,
      );
    }
    markProcessProfile('profileCertification');
    markProcessProfile('enqueue');

    if (!hasRuntimeWork(env)) {
      processProfileOutcome = 'no-work';
      return env;
    }

    const frameGateNow = env.scenarioMode ? (env.timestamp ?? 0) : getWallClockMs();
    if (!isRuntimeFrameReady(env, frameGateNow, runtimeDelay)) {
      processProfileOutcome = 'not-ready';
      return env;
    }
    markProcessProfile('frameReady');

    const mempoolQueuedAt = ensureRuntimeMempool(env).queuedAt;
    const quietRuntimeLogs = env.quietRuntimeLogs === true;
    frameTransaction = createRuntimeFrameTransaction(env);
    env = frameTransaction.workingEnv;
    let state = ensureRuntimeState(env);
    const mempool = ensureRuntimeMempool(env);
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.setQuietLogs?.(quietRuntimeLogs);
    }

    if (env.scenarioMode) {
      env.timestamp = requireBoundaryInteger(
        requireBoundaryInteger(env.timestamp, 'RUNTIME_TIMESTAMP_INVALID') + 100,
        'RUNTIME_TIMESTAMP_OVERFLOW',
      );
    } else {
      const liveNow = getWallClockMs();
      const previousTimestamp = requireBoundaryInteger(
        env.timestamp,
        'RUNTIME_TIMESTAMP_INVALID',
      );
      if (previousTimestamp > liveNow + TIMING.TIMESTAMP_DRIFT_MS) {
        throw new Error(
          `RUNTIME_CLOCK_AHEAD: env.timestamp=${previousTimestamp} wall=${liveNow}`,
        );
      }
      const ingressTimestamp = requireBoundaryInteger(
        mempoolQueuedAt ?? liveNow,
        'RUNTIME_MEMPOOL_TIMESTAMP_INVALID',
      );
      const boundedIngressTimestamp = Math.min(ingressTimestamp, liveNow + TIMING.TIMESTAMP_DRIFT_MS);
      env.timestamp = Math.max(previousTimestamp, boundedIngressTimestamp);
    }
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.setBlockTimestamp(env.timestamp);
    }

    // Inject pings for entities with due scheduled hooks (setTimeout-like)
    generateHookPings(env);

    const automaticWakeInputs = [
      ...collectEntityMempoolWakeInputs(env),
      ...collectAccountMempoolWakeInputs(env),
    ];
    const explicitEntityInputKeys = new Set(
      mempool.entityInputs.map((input) =>
        `${String(input.entityId || '').toLowerCase()}:${String(input.signerId || '').toLowerCase()}`
      ),
    );
    const dedupedAutomaticWakeInputs = automaticWakeInputs.filter((input) => {
      const key = `${input.entityId.toLowerCase()}:${input.signerId.toLowerCase()}`;
      if (explicitEntityInputKeys.has(key)) return false;
      explicitEntityInputKeys.add(key);
      return true;
    });
    const runtimeInput: RuntimeInput = {
      runtimeTxs: [...mempool.runtimeTxs],
      entityInputs: [...mempool.entityInputs, ...dedupedAutomaticWakeInputs],
      ...(mempool.jInputs && mempool.jInputs.length > 0 ? { jInputs: [...mempool.jInputs] } : {}),
      ...(mempool.reliableReceipts && mempool.reliableReceipts.length > 0
        ? { reliableReceipts: [...mempool.reliableReceipts] }
        : {}),
    };
    // Automatic Entity/account wakes join after the live mempool is detached.
    // Publish their exact count before the first await in frame processing.
    processState.inFlightEntityInputs = runtimeInput.entityInputs.length;
    let runtimeInputDrained = false;
    let runtimeInputForRequeue: RuntimeInput | undefined;
    rollbackUndurableFrame = async (
      error: unknown,
      options: { quarantine?: boolean; requeue?: boolean } = {},
    ): Promise<Error> => {
      const originalError = error instanceof Error ? error : new Error(String(error));
      const workingMempoolAfterAttempt = frameTransaction
        ? ensureRuntimeMempool(frameTransaction.workingEnv)
        : ensureRuntimeMempool(env);
      const rollbackErrors = frameTransaction
        ? await abortRuntimeFrameTransaction(frameTransaction)
        : [];
      env = liveEnv;
      state = ensureRuntimeState(env);
      reliableIngressCommits = [];
      reliableReceiptSenderCheckpoint = undefined;
      const quarantineResult = options.quarantine === false
        ? null
        : quarantineLiveRuntimeInput(liveEnv, runtimeInput, originalError, quietRuntimeLogs);
      if (!quarantineResult && options.requeue !== false) {
        const retry = runtimeInputDrained
          ? (() => {
              const attempted = runtimeInputForRequeue ?? cloneRuntimeFrameMempool(runtimeInput);
              if (attempted.queuedAt === undefined) {
                attempted.queuedAt = mempoolQueuedAt ?? frameTimestampBeforeTick;
              }
              return mergeRuntimeFrameMempools(attempted, workingMempoolAfterAttempt);
            })()
          : workingMempoolAfterAttempt;
        const restoredMempool = mergeRuntimeFrameMempools(retry, ensureRuntimeMempool(liveEnv));
        liveEnv.runtimeMempool = restoredMempool;
        liveEnv.runtimeInput = restoredMempool;
      }
      try {
        if (!frameTransaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_ROLLBACK_DRAIN');
        drainRuntimeFrameIngressBuffer(frameTransaction);
      } catch (drainError) {
        rollbackErrors.push(drainError instanceof Error ? drainError : new Error(String(drainError)));
      }
      return rollbackErrors.length > 0
        ? new AggregateError([originalError, ...rollbackErrors], 'RUNTIME_APPLY_ROLLBACK_FAILED')
        : quarantineResult
          ? new RuntimeInputQuarantinedError(originalError)
          : originalError;
    };
    processProfileMetrics.runtimeTxs = runtimeInput.runtimeTxs.length;
    processProfileMetrics.entityInputs = runtimeInput.entityInputs.length;
    processProfileMetrics.entityTxs = runtimeInput.entityInputs.reduce(
      (sum, input) => sum + Number(input.entityTxs?.length || 0),
      0,
    );
    processProfileMetrics.jInputs = runtimeInput.jInputs?.length ?? 0;
    processProfileMetrics.reliableReceipts = runtimeInput.reliableReceipts?.length ?? 0;
    mempool.runtimeTxs = [];
    mempool.entityInputs = [];
    if (mempool.jInputs) mempool.jInputs = [];
    if (mempool.reliableReceipts) mempool.reliableReceipts = [];
    mempool.queuedAt = undefined;
    runtimeInputDrained = true;

    const jEventFramePrioritized = prioritizeJEventFrame(
      runtimeInput,
      mempool,
      mempoolQueuedAt ?? (env.timestamp ?? 0),
    );
    runtimeInput.entityInputs = prioritizeEntityConsensusInputs(
      runtimeInput.entityInputs,
      input => hasVerifiedEntityCommitPrecertificate(env, input),
    );
    runtimeInput.entityInputs = prioritizeProtocolEntityInputs(runtimeInput.entityInputs);
    applyEntityHeightDurabilityBarrier(
      env,
      runtimeInput,
      mempool,
      mempoolQueuedAt ?? (env.timestamp ?? 0),
    );
    applyEntityTxFrameCap(
      runtimeInput,
      mempool,
      state.maxEntityTxsPerFrame ?? 0,
      mempoolQueuedAt ?? (env.timestamp ?? 0),
    );
    applyEntityInputFrameCap(
      runtimeInput,
      mempool,
      state.maxEntityInputsPerFrame ?? 0,
      mempoolQueuedAt ?? (env.timestamp ?? 0),
    );
    runtimeInput.entityInputs = await prepareHtlcPaymentEntityInputs(env, runtimeInput.entityInputs);
    runtimeInputForRequeue = cloneRuntimeFrameMempool(runtimeInput);
    if (RUNTIME_ACCOUNT_CAUSAL_TRACE) {
      const ingress = summarizeRuntimeAccountCausality(runtimeInput.entityInputs);
      if (causalTraceContainsWork(ingress)) {
        processProfileMetrics.accountCausality = { ingress, egress: [] };
      }
    }
    processProfileMetrics.entityInputs = runtimeInput.entityInputs.length;
    processProfileMetrics.entityTxs = runtimeInput.entityInputs.reduce(
      (sum, input) => sum + Number(input.entityTxs?.length || 0),
      0,
    );
    markProcessProfile('mempoolFrame');
    const hasRuntimeInput =
      runtimeInput.runtimeTxs.length > 0 ||
      runtimeInput.entityInputs.length > 0 ||
      (runtimeInput.jInputs?.length ?? 0) > 0 ||
      (runtimeInput.reliableReceipts?.length ?? 0) > 0;
    let appliedRuntimeInputForPersistence: RuntimeInput | undefined;

    if (
      (runtimeInput.reliableReceipts?.length ?? 0) > 0 ||
      hasPendingLocalReliableOutput(env)
    ) {
      reliableReceiptSenderCheckpoint = captureReliableReceiptSenderCheckpoint(env);
    }

    let entityOutbox: RoutedEntityInput[] = [];
    let jOutbox: JInput[] = [];
    let queuedJSubmitRetries: RuntimeTx[] = [];
    const changedEntityIds = new Set<string>();
    const getLocallySignableEntityIds = (): Set<string> => {
      const localEntityIds = new Set<string>();
      for (const replicaKey of env.eReplicas.keys()) {
        const signerId = extractSignerId(replicaKey);
        const entityId = extractEntityId(replicaKey).toLowerCase();
        if (!signerId) continue;
        if (getSignerPrivateKeyIfAvailable(env, signerId) !== null) localEntityIds.add(entityId);
      }
      return localEntityIds;
    };
    if (hasRuntimeInput) {
      if (!quietRuntimeLogs) {
        runtimeLog.debug('tick.input.processing', {
          entityInputs: runtimeInput.entityInputs.length,
          entityIds: runtimeInput.entityInputs.map(o => o.entityId.slice(-4)),
        });
        if (jEventFramePrioritized) {
          runtimeLog.debug('tick.input.deferred_for_j_event');
        }
        if (runtimeInput.runtimeTxs.length > 0) {
          runtimeLog.debug('tick.runtime_txs.processing', { runtimeTxs: runtimeInput.runtimeTxs.length });
        }
      }
      try {
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = true;
        const result = await applyRuntimeInput(env, runtimeInput);
        markProcessProfile('apply');
        if (!quietRuntimeLogs && (result.entityOutbox.length > 0 || result.jOutbox.length > 0)) {
          runtimeLog.debug('process.apply.output', {
            entityOutbox: result.entityOutbox.length,
            jOutbox: result.jOutbox.length,
          });
        }
        entityOutbox = result.entityOutbox;
        if (RUNTIME_ACCOUNT_CAUSAL_TRACE) {
          const egress = summarizeRuntimeAccountCausality(entityOutbox);
          if (causalTraceContainsWork(egress)) {
            processProfileMetrics.accountCausality = {
              ingress: processProfileMetrics.accountCausality?.ingress ?? [],
              egress,
            };
          }
        }
        const splitJOutbox = splitJOutboxForDurableSubmit(result.jOutbox);
        registerPendingCommittedJOutbox(env, splitJOutbox.durable);
        queuedJSubmitRetries = splitJOutbox.retries;
        jOutbox = splitJOutbox.maintenance;
        // Local authorization symbols prove that a command entered through a
        // trusted in-process adapter. They are neither deterministic protocol
        // data nor needed on replay (replay is authorized by the committed
        // frame). Persisting them would make an otherwise valid frame depend
        // on process-local object metadata, so strip them at this boundary.
        appliedRuntimeInputForPersistence = cloneIsolatedRuntimeInput(result.appliedRuntimeInput);
        reliableIngressCommits = result.reliableIngressCommits;
        refreshScheduledWakeIndex(
          env,
          new Set(runtimeInput.entityInputs.map(input => input.entityId.toLowerCase())),
        );
        for (const runtimeTx of runtimeInput.runtimeTxs) {
          if (runtimeTx.type === 'importReplica') {
            changedEntityIds.add(runtimeTx.entityId.toLowerCase());
          }
        }
        // Every Entity state mutation is represented by the canonical applied
        // input, including sibling cross-j cascades. Re-announcing those exact
        // Entities is cheaper and safer than rebuilding every local public
        // profile twice per Runtime frame merely to detect a difference.
        for (const entityInput of result.appliedRuntimeInput.entityInputs) {
          if (entityInput.entityId) changedEntityIds.add(entityInput.entityId.toLowerCase());
        }
        const certificationCandidates = state.pendingProfileCertificationEntityIds ?? new Set<string>();
        for (const entityId of changedEntityIds) {
          const hasCertifiedManifest = [...env.eReplicas.values()].some((replica) => (
            replica.entityId.toLowerCase() === entityId && Boolean(replica.state.profileEncryptionManifest)
          ));
          if (!hasCertifiedManifest) certificationCandidates.add(entityId);
        }
        state.pendingProfileCertificationEntityIds = certificationCandidates;
        markProcessProfile('fingerprints');
      } finally {
        envRecord(env)[ENV_APPLY_ALLOWED_KEY] = false;
      }
    }

    jOutbox = [
      ...(state.pendingCommittedJOutbox ?? []),
      ...jOutbox,
    ];
    const jSideEffectIntentCount = jOutbox.length + queuedJSubmitRetries.length;
    const runtimeInfraEffectCount = (appliedRuntimeInputForPersistence?.runtimeTxs ?? [])
      .filter(runtimeTx =>
        runtimeTx.type === 'importJ' ||
        runtimeTx.type === 'completeImportJ' ||
        runtimeTx.type === 'importReplica')
      .length;

    const outputRoutingDeps = getRuntimeOutputRoutingDeps();
    const {
      localOutputs,
      remoteOutputs,
      deferredOutputs,
      readyPendingOutputs,
      waitingPendingOutputs,
      retainedLocalReliableOutputs,
    } = applyDeterministicRuntimeOutputPlan(
      env,
      entityOutbox,
      outputRoutingDeps,
    );
    processProfileMetrics.localOutputs = localOutputs.length;
    processProfileMetrics.remoteOutputs = remoteOutputs.length;
    processProfileMetrics.deferredOutputs = deferredOutputs.length;
    processProfileMetrics.readyPendingOutputs = readyPendingOutputs.length;
    processProfileMetrics.waitingPendingOutputs = waitingPendingOutputs.length;
    processProfileMetrics.jOutputs = jOutbox.length;
    markProcessProfile('planOutputs');
    if (localOutputs.length > 0 && !quietRuntimeLogs) {
      runtimeLog.debug('tick.local_outputs.queued', {
        localOutputs: localOutputs.length,
        reliableRetained: retainedLocalReliableOutputs.length,
        entityIds: localOutputs.map(o => o.entityId.slice(-4)),
      });
    }
    // Re-check due crontab work after apply. Hooks scheduled at the current
    // logical timestamp should run on the next tick without importing wall
    // clock time into runtime consensus.
    generateHookPings(env);
    // BrowserVM trie is NOT serialized per-frame — it's J-layer state.
    // Only serialized on shutdown/page-unload for reload recovery.

    const frameAdvanced = env.height !== frameHeightBeforeTick;
    processProfileMetrics.frameAdvanced = frameAdvanced;
    if (frameAdvanced) {
      if (hasRuntimeHistoryTraceForTesting(liveEnv)) {
        const committedFrameLogs = Array.isArray(env.frameLogs)
          ? env.frameLogs.map((entry): FrameLogEntry => ({ ...entry }))
          : [];
        pendingRuntimeTraceSnapshot = buildCanonicalEnvSnapshot(env, {
          runtimeInput: appliedRuntimeInputForPersistence ?? { runtimeTxs: [], entityInputs: [] },
          runtimeOutputs: env.pendingOutputs ?? [],
          description: env.extra?.description ?? `Frame ${env.height}`,
          meta: {
            title: env.extra?.subtitle?.title ?? `Frame ${env.height}`,
            ...(env.extra?.subtitle ? { subtitle: env.extra.subtitle } : {}),
            ...(env.frameDisplayMs !== undefined ? { displayMs: env.frameDisplayMs } : {}),
          },
          logs: committedFrameLogs,
          gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
        });

        // The collector owns this explicit debug lifetime. Production Env does
        // not retain a second full copy of finalized state.
      }
      env.history = [];
      markProcessProfile('snapshot');
    }
    env.extra = undefined;

    // === COMMIT POINT: persist finalized R-frame ===
    // Persist only when a new runtime frame was actually applied.
    // Side-effect-only ticks (e.g. deferred network retries) must never
    // overwrite WAL entries for the current height.
    //
    // Why this ordering exists:
    // 1. applyRuntimeInput() computes the post-state for frame N in memory
    // 2. saveEnvToDB() makes frame N durable / replayable
    // 3. only after that do we treat downstream effects as safe to emit
    //
    // That keeps execution, hashing, and recovery aligned around one exact
    // post-state. A crash before save loses only the uncommitted in-memory
    // tail, just like a block that executed locally but was never committed.
    if (frameAdvanced) {
      if (!quietRuntimeLogs) {
        runtimeLog.debug('storage.save.start', { height: env.height });
      }
      try {
        const saveOutcome = await saveEnvToDB(
          env,
          appliedRuntimeInputForPersistence,
          env.pendingNetworkOutputs,
        );
        processProfileMetrics.storageMs = saveOutcome.persistencePerfMs;
        if (saveOutcome.staleWriterStopped) {
          frameRollbackHandled = true;
          const rollbackError = await rollbackUndurableFrame(
            new Error('STALE_RUNTIME_WRITER_STOPPED'),
            { quarantine: false, requeue: false },
          );
          env = liveEnv;
          state = ensureRuntimeState(env);
          const haltedState = state;
          transitionRuntimeLifecycle(haltedState, 'halted');
          haltedState.fatalDebugPayload = {
            message:
              `STALE_RUNTIME_WRITER_STOPPED: frame=${frameHeightBeforeTick + 1} ` +
              `runtime=${String(env.runtimeId || '').slice(0, 12)}`,
            height: Math.max(0, env.height ?? 0),
            timestamp: Math.max(0, env.timestamp ?? 0),
          };
          haltedState.stopLoop?.();
          processProfileOutcome = 'stale-writer-stopped';
          if (rollbackError.message !== 'STALE_RUNTIME_WRITER_STOPPED') throw rollbackError;
          return env;
        }
        frameCommitDisposition = 'committed';
        reliableReceiptStateDurable = true;
        markProcessProfile('save');
        flushPendingAuditEvents(env);
        env.frameLogs = [];
        if (!frameTransaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_COMMIT');
        env = publishRuntimeFrameTransaction(frameTransaction);
        state = ensureRuntimeState(env);
        if (pendingRuntimeTraceSnapshot) {
          recordRuntimeHistoryTraceForTesting(env, pendingRuntimeTraceSnapshot);
        }
        drainRuntimeFrameIngressBuffer(frameTransaction);
        if (!quietRuntimeLogs) {
          runtimeLog.debug('storage.save.done', { height: env.height });
        }
        markProcessProfile('publish');
      } catch (error) {
        if (
          error instanceof RuntimeFrameStorageError &&
          error.commitStatus !== 'not-committed'
        ) {
          frameCommitDisposition = error.commitStatus === 'committed' ? 'committed' : 'unknown';
          reliableReceiptStateDurable = true;
          clearPendingAuditEvents(env);
          if (
            frameTransaction &&
            (error.commitStatus === 'committed' || error.commitStatus === 'unknown')
          ) {
            env = publishRuntimeFrameTransaction(frameTransaction);
          } else {
            env = liveEnv;
          }
          state = ensureRuntimeState(env);
          if (!frameTransaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_STORAGE_ERROR_DRAIN');
          drainRuntimeFrameIngressBuffer(frameTransaction);
          const haltedState = state;
          transitionRuntimeLifecycle(haltedState, 'halted');
          haltedState.fatalDebugPayload = {
            message: error.message,
            height: Math.max(0, env.height ?? 0),
            timestamp: Math.max(0, env.timestamp ?? 0),
          };
          haltedState.stopLoop?.();
        } else {
          clearPendingAuditEvents(env);
        }
        throw error;
      }
    } else {
      frameCommitDisposition = 'committed';
      clearPendingAuditEvents(env);
      if (!frameTransaction) throw new Error('RUNTIME_FRAME_TRANSACTION_MISSING_AT_EMPTY_COMMIT');
      env = publishRuntimeFrameTransaction(frameTransaction);
      state = ensureRuntimeState(env);
      drainRuntimeFrameIngressBuffer(frameTransaction);
    }

    if (frameAdvanced && appliedRuntimeInputForPersistence) {
      notifyRuntimeFrameCommitted(env, appliedRuntimeInputForPersistence);
    }

    const recoveryBarrier = state.recoveryBackupBarrier;
    const pendingReliableReceiptDeliveryCount = reliableIngressCommits.reduce(
      (count, commit) => count + commit.targetRuntimeIds.length,
      0,
    );
    const recoveryRemoteOutputCount = remoteOutputs.length + pendingReliableReceiptDeliveryCount;
    if (
      recoveryBarrier &&
      (recoveryRemoteOutputCount > 0 || jSideEffectIntentCount > 0 || runtimeInfraEffectCount > 0)
    ) {
      try {
        await recoveryBarrier(env, {
          height: env.height,
          remoteOutputCount: recoveryRemoteOutputCount,
          jInputCount: jSideEffectIntentCount + runtimeInfraEffectCount,
        });
      } catch (error) {
        env.error('system', 'RECOVERY_BACKUP_BARRIER_FAILED', {
          height: env.height,
          remoteOutputCount: recoveryRemoteOutputCount,
          jInputCount: jSideEffectIntentCount + runtimeInfraEffectCount,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    markProcessProfile('recoveryBackup');

    await reconcileCommittedRuntimeInfraEffects(
      env,
      appliedRuntimeInputForPersistence?.runtimeTxs ?? [],
    );
    await materializePendingJurisdictionImportResults(env, (runtimeTx) => {
      enqueueRuntimeContinuation(
        env,
        undefined,
        [runtimeTx],
        undefined,
        env.scenarioMode ? env.timestamp : getWallClockMs(),
      );
    });
    markProcessProfile('runtimeInfra');

    reliableReceiptDeliveries = finalizeReliableIngressCommit(env, reliableIngressCommits);
    if (reliableReceiptDeliveries.some(delivery => delivery.receipt.body.identity.kind === 'account-ack')) {
      runtimeLog.info('reliable.account_receipts.finalized', {
        receipts: reliableReceiptDeliveries
          .filter(delivery => delivery.receipt.body.identity.kind === 'account-ack')
          .map(delivery => ({
            targetRuntimeId: delivery.runtimeId,
            height: delivery.receipt.body.identity.height,
            coverage: delivery.receipt.body.coverage,
            entityId: delivery.receipt.body.identity.entityId,
          })),
      });
    }

    if (queuedJSubmitRetries.length > 0) {
      enqueueRuntimeContinuation(env, undefined, queuedJSubmitRetries, undefined, env.timestamp);
    }

    // === SIDE EFFECTS (safe to fail — bilateral consensus retries) ===

    // A fresh account frame can reference a brand-new user entity. Publish the
    // sender profile before remote delivery so the counterparty can enforce the
    // same-jurisdiction invariant without racing gossip.
    const p2p = getP2P(env);
    const localEntityIds = getLocallySignableEntityIds();
    const changedLocalEntityIds = [...changedEntityIds].filter(entityId => localEntityIds.has(entityId));
    const knownProfileIds = new Set(
      (env.gossip?.getProfiles?.() ?? []).map(profile => profile.entityId.toLowerCase()),
    );
    const newLocalEntityIds = changedLocalEntityIds.filter(entityId => !knownProfileIds.has(entityId));
    const refreshLocalEntityIds = changedLocalEntityIds.filter(entityId => knownProfileIds.has(entityId));
    if (
      p2p &&
      remoteOutputs.length > 0 &&
      newLocalEntityIds.length > 0 &&
      typeof p2p.announceProfilesForEntitiesNow === 'function'
    ) {
      // Only a previously unknown sender must precede its first remote output.
      // Existing route-capacity refreshes are metadata and are coalesced below.
      await p2p.announceProfilesForEntitiesNow(newLocalEntityIds, 'pre-output-profile-refresh', false);
    } else if (!p2p && changedLocalEntityIds.length > 0) {
      // The in-process gossip store is the only discovery surface in this
      // topology, so certified profile changes must be observable when the
      // frame promise resolves. Live P2P runtimes coalesce refreshes below.
      await announceCertifiedLocalProfiles(env, changedLocalEntityIds);
    }
    markProcessProfile('profileAnnounce');

    // 1. Broadcast entity outputs via P2P (fire-and-forget)
    if (remoteOutputs.length > 0 && env.quietRuntimeLogs !== true) {
      runtimeLog.debug('side_effect.remote_outputs.dispatch', { remoteOutputs: remoteOutputs.length });
    }
    const dispatchDeferred = dispatchEntityOutputs(env, remoteOutputs, outputRoutingDeps);

    if (refreshLocalEntityIds.length > 0) {
      p2p?.announceProfilesForEntities(refreshLocalEntityIds, 'routing-profile-refresh');
    }
    const deferredNewLocalEntityIds = p2p && remoteOutputs.length === 0 ? newLocalEntityIds : [];
    if (deferredNewLocalEntityIds.length > 0) {
      p2p?.announceProfilesForEntities(deferredNewLocalEntityIds, 'routing-profile-new');
    }

    const allDeferred = [...deferredOutputs, ...dispatchDeferred];
    const rescheduledNetworkOutputs = rescheduleDeferredOutputs(
      env,
      readyPendingOutputs,
      allDeferred,
      waitingPendingOutputs,
      outputRoutingDeps,
    );
    env.pendingNetworkOutputs = buildPendingNetworkOutputs([
      ...rescheduledNetworkOutputs,
      ...retainedLocalReliableOutputs,
    ]);
    processProfileMetrics.pendingNetworkAfter = env.pendingNetworkOutputs.length;
    processProfileMetrics.deferredNetworkMeta = env.runtimeState?.deferredNetworkMeta?.size ?? 0;
    markProcessProfile('dispatchOutputs');

    // A committed business response and its transport receipt share one
    // post-WAL boundary. Queue the useful Entity envelope first on the same
    // ordered connection; otherwise the sender spends a complete R-frame
    // persisting receipt GC before it can apply ACK+next Account proposal.
    if (reliableReceiptDeliveries.length > 0) {
      const receiptP2P = getP2P(env);
      for (const delivery of reliableReceiptDeliveries) {
        const directResult = state.directReliableReceiptDispatch?.(
          delivery.runtimeId,
          delivery.receipt,
        );
        const usedDirect = Boolean(directResult && isDeliveryDelivered(directResult));
        const result = usedDirect
          ? directResult
          : receiptP2P?.enqueueReliableReceiptDelivery(
              delivery.runtimeId,
              delivery.receipt,
            ) ?? directResult;
        if (delivery.receipt.body.identity.kind === 'account-ack') {
          runtimeLog.info('reliable.account_receipt.dispatch', {
            targetRuntimeId: delivery.runtimeId,
            height: delivery.receipt.body.identity.height,
            coverage: delivery.receipt.body.coverage,
            transport: usedDirect ? 'direct' : 'p2p',
            delivered: Boolean(result && isDeliveryDelivered(result)),
            code: result?.code ?? null,
          });
        }
        if (!result || !isDeliveryDelivered(result)) {
          env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
            targetRuntimeId: delivery.runtimeId,
            delivery: result ?? null,
          });
        }
      }
    }
    markProcessProfile('dispatchReceipts');

    // 2. Execute J-batches via JAdapter.submitTx (events arrive next frame via j-watcher)
    await submitRuntimeJOutbox(env, jOutbox, {
      enqueueRuntimeInputs: enqueueRuntimeContinuation,
    });
    markProcessProfile('jOutbox');

    state.lastFrameAt = getWallClockMs();

    if (env.strictScenario) {
      const { assertRuntimeStateStrict } = await import('./protocol/assertions');
      await assertRuntimeStateStrict(env);
      markProcessProfile('strict');
    }

    // CRITICAL: Notify frontend after snapshot is pushed to history
    // Without this, UI (TimeMachine, AccountPanel) never learns about new frames
    notifyEnvChange(env);
    markProcessProfile('notify');

    processProfileOutcome = 'completed';
    return env;
  } catch (error) {
    if (
      frameCommitDisposition === 'undurable' &&
      !frameRollbackHandled &&
      rollbackUndurableFrame
    ) {
      frameRollbackHandled = true;
      const rollbackError = await rollbackUndurableFrame(error, {
        quarantine: !(error instanceof RuntimeFrameStorageError),
      });
      if (rollbackError instanceof RuntimeInputQuarantinedError) {
        processProfileOutcome = 'input-dropped';
        return liveEnv;
      }
      throw rollbackError;
    }
    if (
      frameCommitDisposition === 'undurable' &&
      !frameRollbackHandled &&
      frameTransaction &&
      !frameTransaction.published
    ) {
      frameRollbackHandled = true;
      const workingMempool = ensureRuntimeMempool(frameTransaction.workingEnv);
      const cleanupErrors = await abortRuntimeFrameTransaction(frameTransaction);
      const restoredMempool = mergeRuntimeFrameMempools(
        workingMempool,
        ensureRuntimeMempool(liveEnv),
      );
      liveEnv.runtimeMempool = restoredMempool;
      liveEnv.runtimeInput = restoredMempool;
      env = liveEnv;
      try {
        drainRuntimeFrameIngressBuffer(frameTransaction);
      } catch (drainError) {
        cleanupErrors.push(drainError instanceof Error ? drainError : new Error(String(drainError)));
      }
      if (cleanupErrors.length > 0) {
        const originalError = error instanceof Error ? error : new Error(String(error));
        throw new AggregateError(
          [originalError, ...cleanupErrors],
          'RUNTIME_FRAME_TRANSACTION_ABORT_FAILED',
        );
      }
    }
    throw error;
  } finally {
    if (!reliableReceiptStateDurable) {
      rollbackReliableIngressCommit(env, reliableIngressCommits);
      if (reliableReceiptSenderCheckpoint) {
        rollbackReliableDeliveryReceipts(env, reliableReceiptSenderCheckpoint);
      }
    }
    if (processProfileOutcome === 'unknown') {
      processProfileOutcome = 'thrown';
    }
    logProcessProfile();
    processState.inFlightEntityInputs = 0;
    processState.processingPromise = null;
    delete liveEnv.activeProcessProgressAt;
    delete liveEnv.activeProcessProgressStep;
    releaseProcessLock();
  }
};

export const waitForRuntimeProcessingIdle = async (env: Env, timeoutMs = 5_000): Promise<boolean> => {
  const startedAt = Date.now();
  while (true) {
    const pending = env.runtimeState?.processingPromise;
    if (!pending) return true;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return false;
    const completed = await waitForPromiseBeforeTimeout(pending, remaining);
    if (!completed) return false;
  }
};

type RuntimeProcessGlobal = {
  env?: Record<string, string | undefined>;
  exit?: (code?: number) => never;
};

const getRuntimeProcessGlobal = (): RuntimeProcessGlobal | null => {
  const candidate = (globalThis as typeof globalThis & { process?: RuntimeProcessGlobal }).process;
  return candidate && typeof candidate === 'object' ? candidate : null;
};

const shouldExitOnRuntimeFatal = (runtimeProcess = getRuntimeProcessGlobal()): boolean =>
  typeof runtimeProcess?.exit === 'function' &&
  String(runtimeProcess.env?.['XLN_RUNTIME_EXIT_ON_FATAL'] || '').trim() === '1';

const shouldRequireCanonicalStorageAudit = (runtimeProcess = getRuntimeProcessGlobal()): boolean => {
  const raw = String(runtimeProcess?.env?.['XLN_STORAGE_VERIFY_CANONICAL'] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const resolveStorageWriteTimeoutMs = (): number => {
  const raw = String(getRuntimeProcessGlobal()?.env?.['XLN_STORAGE_WRITE_TIMEOUT_MS'] || '').trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

type RuntimeFrameCommitStatus = 'committed' | 'not-committed' | 'conflict' | 'unknown';

class RuntimeStorageWriteTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly frameHeight: number,
    readonly runtimeId: string,
    readonly step: string,
  ) {
    super(
      `STORAGE_WRITE_TIMEOUT:frame=${frameHeight}:runtime=${runtimeId}:` +
        `timeoutMs=${timeoutMs}:step=${step}`,
    );
    this.name = 'RuntimeStorageWriteTimeoutError';
  }
}

class RuntimeFrameStorageError extends Error {
  constructor(
    readonly commitStatus: RuntimeFrameCommitStatus,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`RUNTIME_FRAME_STORAGE_${commitStatus.toUpperCase()}:${message}`, { cause });
    this.name = 'RuntimeFrameStorageError';
  }
}

const withStorageWriteTimeout = async <T>(
  env: Env,
  operation: (markProgress: (step: string) => void) => Promise<T>,
): Promise<T> => {
  const timeoutMs = resolveStorageWriteTimeoutMs();
  const markRuntimeProgress = (step: string): void => {
    env.activeProcessProgressAt = Date.now();
    env.activeProcessProgressStep = `storage:${step}`;
  };
  if (timeoutMs <= 0) return await operation(markRuntimeProgress);

  return await new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let lastProgressAtMs = Date.now();
    let lastProgressStep = 'start';

    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delayMs: number): void => {
      clearTimer();
      timer = setTimeout(() => {
        if (settled) return;
        let deadline: ReturnType<typeof evaluateStorageProgressDeadline>;
        try {
          deadline = evaluateStorageProgressDeadline(
            lastProgressAtMs,
            Date.now(),
            timeoutMs,
          );
        } catch (error) {
          settled = true;
          reject(error);
          return;
        }
        if (!deadline.stalled) {
          schedule(deadline.remainingMs);
          return;
        }
        settled = true;
        reject(new RuntimeStorageWriteTimeoutError(
          timeoutMs,
          env.height,
          String(env.runtimeId || ''),
          lastProgressStep,
        ));
      }, delayMs);
    };
    const markProgress = (step: string): void => {
      if (settled) return;
      markRuntimeProgress(step);
      lastProgressAtMs = Date.now();
      lastProgressStep = step;
      schedule(timeoutMs);
    };

    schedule(timeoutMs);
    Promise.resolve().then(() => operation(markProgress)).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(error);
      },
    );
  });
};

const resolveAuthoritativeFrameCommitStatus = async (
  env: Env,
  expectedInput: RuntimeInput | undefined,
): Promise<RuntimeFrameCommitStatus> => {
  if (!(await tryOpenFrameDb(env))) return 'unknown';
  const historyDb = getFrameDb(env);
  const head = await readStorageHead(historyDb);
  const frame = await readStorageFrameRecord(historyDb, env.height);
  if (frame) {
    const expectedInputValue = expectedInput ?? { runtimeTxs: [], entityInputs: [] };
    const inputMatches = safeStringify(frame.runtimeInput) === safeStringify(expectedInputValue);
    const runtimeMachineMatches = !frame.runtimeMachine || safeStringify(frame.runtimeMachine) === safeStringify(
      buildDurableRuntimeMachineSnapshot(env, {
        pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
        excludePersistedFrameDbRecords: true,
      }),
    );
    const stateMatches = !frame.runtimeStateHash || frame.runtimeStateHash === computeCanonicalStateHashFromEnv(env);
    return inputMatches && runtimeMachineMatches && stateMatches ? 'committed' : 'conflict';
  }
  if (!head) return 'unknown';
  if (head.latestHeight >= env.height) return 'conflict';
  if (head.latestHeight === env.height - 1) return 'not-committed';
  return 'unknown';
};

// === LEVELDB PERSISTENCE ===
export const saveEnvToDB = async (
  env: Env,
  currentFrameInput?: RuntimeInput,
  currentFrameOutputs?: RoutedEntityInput[],
): Promise<{
  staleWriterStopped: boolean;
  persistencePerfMs?: Awaited<ReturnType<typeof saveRuntimeFrameToStorage>>['persistencePerfMs'];
}> => {
  if (envRecord(env)[ENV_REPLAY_MODE_KEY] === true) {
    throw new Error('REPLAY_INVARIANT_FAILED: saveEnvToDB called during replay');
  }
  const pendingFrameDbRecords = peekPendingFrameDbRecords(env, env.height, env.timestamp);
  let saveResult: Awaited<ReturnType<typeof saveRuntimeFrameToStorage>>;
  try {
    saveResult = await withStorageWriteTimeout(
      env,
      (markStorageProgress) => withStorageWriterLock(env, () => saveRuntimeFrameToStorage({
        env,
        tryOpenDb: (targetEnv) => tryOpenStorageDb(targetEnv, 'current'),
        getRuntimeDb: (targetEnv) => getStorageDb(targetEnv, 'current'),
        tryOpenFrameDb,
        getFrameDb,
        rotateEpochDb: rotateStorageEpochDb,
        getPerfMs,
        formatPerfMs,
        frameDbRecords: pendingFrameDbRecords,
        stopStaleWriterOnHeadAhead: runtimeIsBrowser && !env.scenarioMode,
        ...(currentFrameInput === undefined ? {} : { currentFrameInput }),
        ...(currentFrameOutputs === undefined ? {} : { currentFrameOutputs }),
        onPersistenceProgress: markStorageProgress,
        onPersistenceBoundary: (boundary) => markStorageProgress(`boundary:${boundary}`),
      })),
    );
  } catch (error) {
    let commitStatus: RuntimeFrameCommitStatus = 'unknown';
    if (!(error instanceof RuntimeStorageWriteTimeoutError)) {
      try {
        commitStatus = await resolveAuthoritativeFrameCommitStatus(env, currentFrameInput);
      } catch (probeError) {
        const writeFailure = error instanceof Error ? error : new Error(String(error));
        const probeFailure = probeError instanceof Error ? probeError : new Error(String(probeError));
        const combined = new AggregateError(
          [writeFailure, probeFailure],
          `STORAGE_WRITE_AND_AUTHORITATIVE_PROBE_FAILED:` +
            `write=${writeFailure.name}:${writeFailure.message}:` +
            `probe=${probeFailure.name}:${probeFailure.message}`,
        );
        throw new RuntimeFrameStorageError('unknown', combined);
      }
    }
    throw new RuntimeFrameStorageError(commitStatus, error);
  }
  if (!saveResult.frameDbCommitted && !saveResult.staleWriterStopped) {
    throw new RuntimeFrameStorageError(
      'not-committed',
      new Error(`STORAGE_AUTHORITATIVE_FRAME_NOT_COMMITTED:height=${env.height}`),
    );
  }
  if (saveResult.staleWriterStopped) {
    const state = ensureRuntimeState(env);
    transitionRuntimeLifecycle(state, 'halted');
    state.fatalDebugPayload = {
      message:
        `STALE_RUNTIME_WRITER_STOPPED: frame=${env.height} runtime=${String(env.runtimeId || '').slice(0, 12)}`,
      height: Math.max(0, env.height ?? 0),
      timestamp: Math.max(0, env.timestamp ?? 0),
    };
    state.stopLoop?.();
    return { staleWriterStopped: true };
  }
  if (saveResult.frameDbCommitted) {
    dropPendingFrameDbRecords(env, pendingFrameDbRecords.length);
  }
  if (saveResult.materialized) {
    dropOverlay(env, saveResult.materializedOverlayRecords);
  }
  if (runtimeIsBrowser && typeof BroadcastChannel !== 'undefined' && typeof env.runtimeId === 'string' && env.runtimeId.length > 0) {
    const state = ensureRuntimeState(env);
    state.runtimeSyncChannel ??= new BroadcastChannel('xln-runtime-sync');
    state.runtimeSyncChannel.postMessage({
      runtimeId: env.runtimeId,
      height: env.height,
    });
  }
  return {
    staleWriterStopped: false,
    ...(saveResult.persistencePerfMs ? { persistencePerfMs: saveResult.persistencePerfMs } : {}),
  };
};

type VerifyRuntimeChainResult = {
  ok: boolean;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
  restoredHeight: number;
  expectedStateHash: string;
  actualStateHash: string;
  expectedCanonicalStateHash?: string;
  actualCanonicalStateHash?: string;
};

type PersistedStorageHandle = {
  role: 'history';
  db: Level<Buffer, Buffer>;
  head: StorageHead;
  latestHeight: number;
  latestMaterializedHeight: number;
  latestSnapshotHeight: number;
  snapshotHeights: number[];
};

const createPersistedStorageEnv = (runtimeId?: string | null, runtimeSeed?: string | null): Env => {
  const env = createEmptyEnv(runtimeSeed ?? null);
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId ?? env.runtimeId ?? null);
  if (normalizedRuntimeId) {
    env.runtimeId = normalizedRuntimeId;
    env.dbNamespace = normalizeDbNamespace(normalizedRuntimeId);
  }
  return env;
};

const listPersistedStorageHandles = async (env: Env): Promise<PersistedStorageHandle[]> => {
  const opened = await tryOpenFrameDb(env);
  if (!opened) return [];
  const db = getFrameDb(env);
  const head = await readStorageHead(db);
  if (!head || head.latestHeight <= 0) return [];
  return [{
    role: 'history',
    db,
    head,
    latestHeight: head.latestHeight,
    latestMaterializedHeight: Math.max(
      0,
      Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
    ),
    latestSnapshotHeight: head.latestSnapshotHeight,
    snapshotHeights: (await listStorageSnapshotHeights(db))
      .filter((height) => height <= head.latestSnapshotHeight),
  }];
};

const restoreOverlayFromFrameLog = async (
  env: Env,
  targetHeight: number,
): Promise<void> => {
  for (const handle of await listPersistedStorageHandles(env)) {
    if (targetHeight > handle.latestHeight) continue;

    const targetFrame = await readStorageFrameRecord(handle.db, targetHeight);
    if (targetFrame?.materializedState !== false) {
      env.overlay = [];
      return;
    }

    const startHeight = Math.max(1, handle.latestMaterializedHeight + 1);
    if (startHeight > targetHeight) {
      env.overlay = [];
      return;
    }

    const records = new Map<string, RuntimeOverlayRecord>();
    for (const record of await readStorageOverlayRecordsFromDiffs(handle.db, startHeight, targetHeight)) {
      records.set(storageOverlayRecordKey(record), { ...record });
    }
    if (records.size === 0 && Array.isArray(targetFrame?.overlayRecords)) {
      for (const record of targetFrame.overlayRecords) {
        records.set(storageOverlayRecordKey(record), { ...record });
      }
    }
    env.overlay = Array.from(records.values());
    return;
  }
  env.overlay = [];
};

const resolvePersistedLatestHeight = async (env: Env): Promise<number> => {
  const handles = await listPersistedStorageHandles(env);
  return handles.reduce((max, handle) => Math.max(max, handle.latestHeight), 0);
};

const resolvePersistedCheckpointHeights = async (env: Env): Promise<number[]> => {
  const handles = await listPersistedStorageHandles(env);
  return Array.from(new Set(handles.flatMap((handle) => handle.snapshotHeights))).sort((left, right) => left - right);
};

export const readPersistedStorageFrameRecord = async (
  env: Env,
  height: number,
): Promise<ReturnType<typeof readStorageFrameRecord> extends Promise<infer T> ? T : never> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) return null;
  for (const handle of await listPersistedStorageHandles(env)) {
    if (targetHeight > handle.latestHeight) continue;
    const frame = await readStorageFrameRecord(handle.db, targetHeight);
    if (frame) return frame;
  }
  return null;
};

const readPersistedStorageReplicaMetas = async (
  env: Env,
  entityId: string,
  sharedState?: EntityState,
): Promise<Awaited<ReturnType<typeof listStorageReplicaMetas>>> => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  if (!normalizedEntityId) return [];
  if (!(await tryOpenFrameDb(env))) return [];
  const historyDb = getFrameDb(env);
  return listStorageReplicaMetas(historyDb, normalizedEntityId, sharedState);
};

const readPersistedStorageSnapshotReplicaMetas = async (
  env: Env,
  snapshotHeight: number,
  entityId: string,
): Promise<Awaited<ReturnType<typeof listStorageSnapshotReplicaMetas>>> => {
  const normalizedEntityId = String(entityId || '').toLowerCase();
  if (!normalizedEntityId || snapshotHeight <= 0) return [];
  if (!(await tryOpenFrameDb(env))) return [];
  return listStorageSnapshotReplicaMetas(
    getFrameDb(env),
    snapshotHeight,
    normalizedEntityId,
  );
};

const resolvePersistedSnapshotHeight = async (env: Env, targetHeight: number): Promise<number> => {
  let best = 0;
  for (const handle of await listPersistedStorageHandles(env)) {
    if (targetHeight > handle.latestHeight) continue;
    const candidate = await findStorageLatestSnapshotAtOrBelow(handle.db, targetHeight);
    if (candidate > best) best = candidate;
  }
  return best;
};

export const listPersistedEntityIdsAtHeight = async (env: Env, targetHeight: number): Promise<string[]> => {
  const entityIds = new Set<string>();
  for (const handle of await listPersistedStorageHandles(env)) {
    const snapshotHeight = await findStorageLatestSnapshotAtOrBelow(handle.db, targetHeight);
    if (snapshotHeight > 0) {
      for (const entityId of await listStorageSnapshotEntityIds(handle.db, snapshotHeight)) {
        entityIds.add(entityId);
      }
    }
    const replayStartHeight = Math.max(1, snapshotHeight + 1);
    const replayEndHeight = Math.min(targetHeight, handle.latestHeight);
    for (let height = replayStartHeight; height <= replayEndHeight; height += 1) {
      const frame = await readStorageFrameRecord(handle.db, height);
      for (const entityId of frame?.touchedEntities ?? []) {
        const normalized = String(entityId || '').toLowerCase();
        if (normalized) entityIds.add(normalized);
      }
      for (const account of frame?.touchedAccounts ?? []) {
        const entityId = String(account?.entityId || '').toLowerCase();
        if (entityId) entityIds.add(entityId);
        // An Account doc belongs to `entityId`; its counterparty is commonly a
        // remote Entity and therefore has no core doc in this Runtime. Graph
        // projection adds that endpoint as a placeholder after loading the
        // local Account. Treating it as local makes historical reads demand an
        // Entity core that cannot exist in this keyspace.
      }
      for (const entry of frame?.entityHashes ?? []) {
        const entityId = String(entry?.entityId || '').toLowerCase();
        if (entityId) entityIds.add(entityId);
      }
    }
  }
  return Array.from(entityIds).sort();
};

const listPersistedReplicaValidators = (state: EntityState): string[] => {
  if (!Array.isArray(state.config?.validators)) return [];
  return state.config.validators
    .map((validator) => String(validator || '').toLowerCase())
    .filter((validator) => validator.length > 0);
};

const resolvePersistedReplicaIdentity = (
  entityId: string,
  state: EntityState,
  meta: Awaited<ReturnType<typeof readPersistedStorageReplicaMetas>>[number] | null,
  targetHeight: number,
  latestHeight: number,
): { signerId: string; isProposer: boolean } => {
  const validators = listPersistedReplicaValidators(state);
  const metaSignerId = typeof meta?.signerId === 'string' && meta.signerId.trim().length > 0
    ? meta.signerId.trim().toLowerCase()
    : '';
  const isLatestRestore = targetHeight === latestHeight;
  if (isLatestRestore && !metaSignerId && validators.length > 1) {
    throw new Error(
      `STORAGE_RESTORE_REPLICA_META_REQUIRED: entity=${entityId} validators=${validators.length} height=${targetHeight}`,
    );
  }
  const signerId = metaSignerId || validators[0] || String(state.entityId || entityId).toLowerCase();
  const isProposer = typeof meta?.isProposer === 'boolean'
    ? meta.isProposer
    : isLatestRestore && validators.length === 1 && signerId === validators[0];
  return { signerId, isProposer };
};

const rebuildPersistedJurisdictions = (env: Env): void => {
  env.jReplicas = new Map();
  for (const replica of env.eReplicas.values()) {
    const jurisdiction = replica.state.config?.jurisdiction as Record<string, unknown> | undefined;
    const name = typeof jurisdiction?.['name'] === 'string' ? jurisdiction['name'] : '';
    if (!name || env.jReplicas.has(name)) continue;
    const depositoryAddress = String(jurisdiction?.['depositoryAddress'] || '').trim();
    const entityProviderAddress = String(jurisdiction?.['entityProviderAddress'] || '').trim();
    const deltaTransformerAddress = String(
      jurisdiction?.['deltaTransformerAddress'] ?? jurisdiction?.['deltaTransformer'] ?? '',
    ).trim();
    const chainId = Number.isFinite(Number(jurisdiction?.['chainId'])) ? Number(jurisdiction?.['chainId']) : 31337;
    env.jReplicas.set(name, {
      name,
      depositoryAddress,
      entityProviderAddress,
      chainId,
      contracts: {
        ...(depositoryAddress ? { depository: depositoryAddress } : {}),
        ...(entityProviderAddress ? { entityProvider: entityProviderAddress } : {}),
        ...(deltaTransformerAddress ? { deltaTransformer: deltaTransformerAddress } : {}),
      },
    } as never);
    if (!env.activeJurisdiction) env.activeJurisdiction = name;
  }
};

const loadEnvFromStorage = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
  options: { prunedTargetReturnsNull?: boolean } = {},
): Promise<{
  env: Env;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
} | null> => {
  /**
   * Authoritative daemon restore has three deliberately separate phases:
   *
   * 1. Read compact snapshot/frame records and decode every Runtime, Entity,
   *    Account, replica-meta and immutable DAG node through its strict schema.
   * 2. Rebuild Maps and reachable node stores in memory, then verify lineage,
   *    J-history roots and the canonical state hash before returning any Env.
   * 3. Only the caller may attach live RPC/network infrastructure and start the
   *    runtime loop. New J-events and durable outbox retries therefore cannot
   *    mutate state until the restored checkpoint has passed every check.
   *
   * Keep external I/O out of phases 1-2. A restore failure must close the probe
   * databases and fail loud; it must never expose a partially hydrated Env.
   */
  const env = createPersistedStorageEnv(runtimeId, runtimeSeed);
  assertStorageSafetyOverridesAllowed();
  let returningEnv = false;
  try {
    const persistedHandles = await listPersistedStorageHandles(env);
    const latestHeight = persistedHandles.reduce(
      (max, handle) => Math.max(max, handle.latestHeight),
      0,
    );
    if (latestHeight <= 0) return null;
    const targetHeight = Math.max(
      1,
      Math.min(
        latestHeight,
        Number.isFinite(Number(targetHeightOverride)) ? Math.floor(Number(targetHeightOverride)) : latestHeight,
      ),
    );
    const frame = await readPersistedStorageFrameRecord(env, targetHeight);
    if (!frame) {
      const latestSnapshotHeight = persistedHandles.reduce(
        (max, handle) => Math.max(max, handle.latestSnapshotHeight),
        0,
      );
      const retainedCheckpoint = persistedHandles.some(
        (handle) => handle.snapshotHeights.includes(targetHeight),
      );
      if (
        options.prunedTargetReturnsNull &&
        targetHeight < latestSnapshotHeight &&
        !retainedCheckpoint
      ) return null;
      throw new Error(`STORAGE_RESTORE_FRAME_MISSING: height=${targetHeight}`);
    }
    const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(env, targetHeight);
    if (selectedSnapshotHeight > 0) {
      const snapshotHandle = persistedHandles.find(
        (handle) => handle.snapshotHeights.includes(selectedSnapshotHeight),
      );
      if (!snapshotHandle) {
        throw new Error(`STORAGE_RESTORE_SNAPSHOT_HANDLE_MISSING:height=${selectedSnapshotHeight}`);
      }
      await verifyStorageSnapshotAtHeight(
        snapshotHandle.db,
        snapshotHandle.head,
        selectedSnapshotHeight,
      );
    }
    const restoredStates = await loadEntityStatesAtHeightFromStorage({
      env,
      tryOpenDb: tryOpenFrameDb,
      getRuntimeDb: getFrameDb,
      height: targetHeight,
    });
    for (const state of restoredStates.values()) assertCertifiedJHistoryIntegrity(state);

    if (frame.runtimeMachine) restoreDurableRuntimeSnapshot(env, frame.runtimeMachine);

    env.eReplicas = new Map();
    for (const [entityId, state] of restoredStates.entries()) {
      const persistedMetas = targetHeight === latestHeight
        ? await readPersistedStorageReplicaMetas(env, entityId, state)
        : targetHeight === selectedSnapshotHeight
          ? await readPersistedStorageSnapshotReplicaMetas(env, selectedSnapshotHeight, entityId)
          : [];
      const metas = persistedMetas.length > 0 ? persistedMetas : [null];
      for (const meta of metas) {
        const isLatestRestore = targetHeight === latestHeight;
        const isCheckpointRestore = targetHeight === selectedSnapshotHeight;
        const requiresExactReplica = isLatestRestore || isCheckpointRestore;
        if (requiresExactReplica && !meta) {
          throw new Error(
            `STORAGE_RESTORE_REPLICA_META_REQUIRED:entity=${entityId}:height=${targetHeight}:` +
            `source=${isLatestRestore ? 'head' : 'checkpoint'}`,
          );
        }
        const persistedReplicaState = requiresExactReplica ? (meta?.state ?? state) : state;
        if (String(persistedReplicaState.entityId || '').toLowerCase() !== entityId.toLowerCase()) {
          throw new Error(
            `STORAGE_RESTORE_REPLICA_STATE_ENTITY_MISMATCH: expected=${entityId.toLowerCase()} ` +
            `actual=${String(persistedReplicaState.entityId || '').toLowerCase()}`,
          );
        }
        assertCertifiedJHistoryIntegrity(persistedReplicaState);
        const { signerId, isProposer } = resolvePersistedReplicaIdentity(
          entityId,
          persistedReplicaState,
          meta,
          targetHeight,
          latestHeight,
        );
        const hankoWitness = meta?.hankoWitness ?? new Map();
        assertValidatorJHistoryIntegrity(persistedReplicaState, meta?.jHistory);
        const replicaState = cloneEntityState(persistedReplicaState, true);
        if (requiresExactReplica) {
          assertPersistedLocalEntityCryptoKeys(env, entityId, signerId, replicaState);
        }
        const restoredReplica: EntityReplica = {
          entityId,
          signerId,
          state: replicaState,
          mempool: requiresExactReplica ? meta!.mempool : [],
          isProposer,
          hankoWitness,
          ...(meta?.proposal ? { proposal: meta.proposal } : {}),
          ...(meta?.lockedFrame ? { lockedFrame: meta.lockedFrame } : {}),
          ...(meta?.validatorExecution ? { validatorExecution: meta.validatorExecution } : {}),
          ...(meta?.certifiedFrameLineage
            ? { certifiedFrameLineage: meta.certifiedFrameLineage }
            : {}),
          ...(meta?.certifiedFrameAnchor
            ? { certifiedFrameAnchor: meta.certifiedFrameAnchor }
            : {}),
          ...(meta?.position ? { position: meta.position } : {}),
          ...(meta?.jHistory ? { jHistory: meta.jHistory } : {}),
          ...(meta?.jSubmitState ? { jSubmitState: meta.jSubmitState } : {}),
          ...(meta?.entityProviderActionSubmitState
            ? { entityProviderActionSubmitState: meta.entityProviderActionSubmitState }
            : {}),
          ...(meta?.leaderVotes ? { leaderVotes: meta.leaderVotes } : {}),
          ...(meta?.pendingLeaderCertificate ? { pendingLeaderCertificate: meta.pendingLeaderCertificate } : {}),
          ...(meta?.lastConsensusProgressAt !== undefined
            ? { lastConsensusProgressAt: meta.lastConsensusProgressAt }
            : {}),
        };
        if (meta?.jPrefixRound) {
          restoredReplica.jPrefixRound = restoreJPrefixRound(env, replicaState, meta.jPrefixRound);
        }
        env.eReplicas.set(formatReplicaKey(createReplicaKey(entityId, signerId)), restoredReplica);
      }
    }

    const historyDb = getFrameDb(env);
    for (const root of new Set(Array.from(env.eReplicas.values(), (replica) => (
      replica.state.certifiedBoardState?.boardRegistryRoot
    )).filter((value): value is string => Boolean(value)))) {
      await hydrateCertifiedBoardRootNodesFromStorage(env, historyDb, root);
    }
    for (const state of getLiveConsumptionAccumulatorStates(env)) {
      await hydrateConsumptionRootNodesFromStorage(env, historyDb, state);
    }
    await hydrateAccountJClaimRootNodesFromStorage(
      env,
      historyDb,
      getLiveAccountJClaimAccumulatorStates(env),
    );

    if (env.jReplicas.size === 0) rebuildPersistedJurisdictions(env);
    await assertCertifiedRegistrationEvidenceStore(env);

    if (targetHeight === latestHeight) {
      const lineagePlan = buildCertifiedEntityLineagePlan(env);
      for (const [entityId, sharedState] of restoredStates) {
        const selected = lineagePlan.lookup.get(entityId.toLowerCase());
        if (!selected) {
          throw new Error(`STORAGE_RESTORE_LINEAGE_ENTITY_MISSING:${entityId}`);
        }
        const selectedHash = computeCanonicalEntityHash(selected.replica).hash;
        const sharedHash = computeCanonicalEntityHash({
          ...selected.replica,
          state: sharedState,
        }).hash;
        if (selectedHash !== sharedHash) {
          throw new Error(
            `STORAGE_RESTORE_SHARED_STATE_MISMATCH:entity=${entityId}:` +
            `selected=${selectedHash}:shared=${sharedHash}`,
          );
        }
      }
      applyCertifiedEntityLineagePlan(env, lineagePlan);
    }

    env.height = targetHeight;
    env.timestamp = requireBoundaryInteger(
      frame.timestamp,
      `STORAGE_RESTORE_TIMESTAMP_INVALID:height=${targetHeight}`,
    );
    env.runtimeMempool = frame.pendingRuntimeInput
      ? authorizeRestoredRuntimeInput(cloneIsolatedRuntimeInput(frame.pendingRuntimeInput))
      : undefined;
    env.runtimeInput = env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] };
    env.pendingNetworkOutputs = cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs ?? []);
    restoreDurableOutputRetryState(
      env,
      frame.runtimeOutputRetryState ?? [],
      frame.runtimeOutputs ?? [],
    );
    await restoreOverlayFromFrameLog(env, targetHeight);
    await hydrateAccountFrameHistoryViews(env);
    let restoredFrameLogs: FrameLogEntry[] = [];
    try {
      if (await tryOpenFrameDb(env)) {
        const activity = await readFrameDbRuntimeActivity(getFrameDb(env), targetHeight);
        if (activity?.logs) restoredFrameLogs = activity.logs.map((entry) => ({ ...entry }));
      }
    } catch (error) {
      // Activity logs are secondary; classify the failure without hiding it or
      // making authoritative state restore depend on an auxiliary index.
      runtimeLog.warn('storage.activity_restore_failed', {
        height: targetHeight,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    env.frameLogs = restoredFrameLogs;
    if (frame.runtimeMachine) {
      restoreDurableRuntimeSnapshot(env, frame.runtimeMachine);
      await assertCertifiedRegistrationEvidenceStore(env);
    }
    const shouldVerifyCanonicalAudit = Boolean(frame.canonicalStateHash) || shouldRequireCanonicalStorageAudit();
    if (shouldVerifyCanonicalAudit && !frame.canonicalStateHash) {
      throw new Error(`STORAGE_RESTORE_CANONICAL_HASH_MISSING: height=${targetHeight}`);
    }
    const restoredCanonicalStateHash = shouldVerifyCanonicalAudit ? computeCanonicalStateHashFromEnv(env) : '';
    if (shouldVerifyCanonicalAudit && restoredCanonicalStateHash !== frame.canonicalStateHash) {
      const expectedEntities = new Map((frame.canonicalEntityHashes || []).map((entry) => [entry.entityId, entry.hash]));
      const actualEntities = computeCanonicalEntityHashesFromEnv(env);
      const mismatch = actualEntities.find((entry) => expectedEntities.get(entry.entityId) !== entry.hash);
      const missing = (frame.canonicalEntityHashes || []).find(
        (entry) => !actualEntities.some((actual) => actual.entityId === entry.entityId),
      );
      const mismatchDetail = mismatch
        ? ` entity=${mismatch.entityId} expectedEntity=${expectedEntities.get(mismatch.entityId) || 'missing'} actualEntity=${mismatch.hash}`
        : missing
          ? ` entity=${missing.entityId} expectedEntity=${missing.hash} actualEntity=missing`
          : '';
      throw new Error(
        `STORAGE_RESTORE_CANONICAL_HASH_MISMATCH: height=${targetHeight} ` +
          `expected=${frame.canonicalStateHash} actual=${restoredCanonicalStateHash}${mismatchDetail}`,
      );
    }
    envRecord(env)['__replayMeta'] = {
      checkpointHeight: selectedSnapshotHeight,
      selectedSnapshotHeight,
      selectedSnapshotLabel:
        selectedSnapshotHeight <= 1
          ? 'genesis:1'
          : selectedSnapshotHeight === targetHeight
            ? `checkpoint:${selectedSnapshotHeight}`
            : `snapshot:${selectedSnapshotHeight}`,
      latestHeight,
    };
    env.history = [];

    returningEnv = true;
    return {
      env,
      latestHeight,
      checkpointHeight: selectedSnapshotHeight,
      selectedSnapshotHeight,
    };
  } finally {
    // loadEnvFromDB probes storage on fresh starts. If there is nothing to
    // restore, the probe env must release LevelDB locks before the real runtime
    // opens the same storage path for frame 1.
    if (!returningEnv) {
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    }
  }
};

const hydrateAccountFrameHistoryViews = async (env: Env, limit = 0): Promise<void> => {
  if (limit <= 0) return;
  try {
    if (!(await tryOpenFrameDb(env))) return;
    const db = getFrameDb(env);
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const entityId = String(replica?.entityId || String(replicaKey).split(':')[0] || '').toLowerCase();
      if (!entityId || !replica?.state?.accounts) continue;
      for (const [counterpartyId, account] of replica.state.accounts.entries()) {
        const accountCurrentHeight = Math.max(0, Math.floor(Number(account.currentHeight ?? 0)));
        const records = await readFrameDbAccountFrames(db, entityId, String(counterpartyId).toLowerCase(), {
          limit,
          maxRuntimeHeight: env.height,
          maxAccountHeight: accountCurrentHeight,
        });
        setAccountFrameHistoryView(account, records.map((record) => record.frame), limit);
      }
    }
  } catch (error) {
    runtimeLog.warn('account_frame_history.hydrate_failed', { error: error instanceof Error ? error.message : String(error) });
  }
};

export const getPersistedLatestHeight = async (env: Env): Promise<number> => {
  return resolvePersistedLatestHeight(env);
};

export const loadEntityStateFromStorageDb = async (
  env: Env,
  entityId: string,
  height?: number,
): Promise<EntityState | null> => {
  const state = await loadEntityStateFromStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
    entityId,
    ...(height === undefined ? {} : { height }),
    liveStateReadable: false,
  });
  if (state) assertCertifiedJHistoryIntegrity(state);
  return state;
};

export const loadEntityAccountDocFromStorageDb = async (
  env: Env,
  entityId: string,
  counterpartyId: string,
  height?: number,
) => {
  return loadEntityAccountDocFromStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
    entityId,
    counterpartyId,
    ...(height === undefined ? {} : { height }),
    liveStateReadable: false,
  });
};

export const loadEntityViewPageFromStorageDb = async (
  env: Env,
  entityId: string,
  height: number,
  query?: RuntimeAdapterReadQuery,
) => {
  const accountQuery = {
    ...(query?.cursor ? { cursor: query.cursor } : {}),
    ...(query?.accountsCursor ? { cursor: query.accountsCursor } : {}),
    ...(query?.accountsLimit !== undefined ? { limit: query.accountsLimit } : query?.limit !== undefined ? { limit: query.limit } : {}),
    ...(query?.sortDir ? { sortDir: query.sortDir } : {}),
  };
  const bookCursor = query?.booksCursor ?? (query?.accountsCursor ? undefined : query?.cursor);
  const bookQuery = {
    ...(bookCursor ? { cursor: bookCursor } : {}),
    ...(query?.booksLimit !== undefined ? { limit: query.booksLimit } : query?.limit !== undefined ? { limit: query.limit } : {}),
  };
  return loadEntityViewPageFromStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
    entityId,
    height,
    accountQuery,
    bookQuery,
    liveStateReadable: false,
  });
};

export const inspectStorageDb = async (env: Env) => {
  const current = await inspectStorage({
    env,
    tryOpenDb: (targetEnv) => tryOpenStorageDb(targetEnv, 'current'),
    getRuntimeDb: (targetEnv) => getStorageDb(targetEnv, 'current'),
  });
  const history = await inspectStorage({
    env,
    tryOpenDb: tryOpenFrameDb,
    getRuntimeDb: getFrameDb,
  });
  if (!current && !history) return null;

  const epochs = [
    current
      ? {
          role: 'current' as const,
          path: resolveStorageDbPath(env, 'current'),
          latestHeight: current.head?.latestHeight ?? 0,
          latestSnapshotHeight: current.head?.latestSnapshotHeight ?? 0,
          frameCount: current.frameCount,
          diffCount: current.diffCount,
          snapshotCount: current.snapshotHeights.length,
          liveBytes: current.liveBytes,
          historyBytes: current.historyBytes,
          totalBytes: current.totalBytes,
        }
      : null,
    history
      ? {
          role: 'history' as const,
          path: resolveFrameDbPath(env),
          latestHeight: history.head?.latestHeight ?? 0,
          latestSnapshotHeight: history.head?.latestSnapshotHeight ?? 0,
          frameCount: history.frameCount,
          diffCount: history.diffCount,
          snapshotCount: history.snapshotHeights.length,
          liveBytes: history.liveBytes,
          historyBytes: history.historyBytes,
          totalBytes: history.totalBytes,
        }
      : null,
  ].filter(Boolean);

  const snapshotHeights = Array.from(
    new Set([...(history?.snapshotHeights ?? [])]),
  ).sort((left, right) => left - right);

  return {
    head: history?.head ?? current?.head ?? null,
    frameCount: history?.frameCount ?? 0,
    diffCount: history?.diffCount ?? 0,
    snapshotHeights,
    liveEntityCount: current?.liveEntityCount ?? 0,
    liveAccountCount: current?.liveAccountCount ?? 0,
    liveBookCount: current?.liveBookCount ?? 0,
    frameBytes: history?.frameBytes ?? 0,
    diffBytes: history?.diffBytes ?? 0,
    snapshotBytes: history?.snapshotBytes ?? 0,
    liveBytes: current?.liveBytes ?? 0,
    historyBytes: history?.historyBytes ?? 0,
    totalBytes: (current?.liveBytes ?? 0) + (history?.historyBytes ?? 0),
    maxFrameBytes: history?.maxFrameBytes ?? 0,
    maxDiffBytes: history?.maxDiffBytes ?? 0,
    maxSnapshotBytes: history?.maxSnapshotBytes ?? 0,
    epochDbs: epochs,
  };
};

export const listPersistedCheckpointHeights = async (env: Env): Promise<number[]> => {
  return resolvePersistedCheckpointHeights(env);
};

export const readPersistedStorageHead = async (env: Env): Promise<StorageHead | null> => {
  if (!(await tryOpenFrameDb(env))) return null;
  return readStorageHead(getFrameDb(env));
};

const buildRecoveryJournalFromStorageFrame = (
  frame: StorageFrameRecord,
  logs: FrameLogEntry[] = [],
): PersistedFrameJournal => ({
  height: frame.height,
  timestamp: frame.timestamp,
  replicaMetaDigest: frame.replicaMetaDigest,
  postStateHash: frame.postStateHash,
  replicaMetaCheckpoint: frame.replicaMetaCheckpoint,
  replicaMetaStateMode: frame.replicaMetaStateMode,
  runtimeInput: frame.runtimeInput,
  ...(frame.pendingRuntimeInput
    ? { pendingRuntimeInput: cloneIsolatedRuntimeInput(frame.pendingRuntimeInput) }
    : {}),
  ...(frame.runtimeOutputs?.length
    ? { runtimeOutputs: cloneIsolatedRoutedEntityInputs(frame.runtimeOutputs) }
    : {}),
  ...(frame.runtimeOutputRetryState?.length
    ? { runtimeOutputRetryState: structuredClone(frame.runtimeOutputRetryState) }
    : {}),
  ...(frame.runtimeMachine
    ? { runtimeMachine: cloneIsolatedRuntimeSnapshot(frame.runtimeMachine) }
    : {}),
  ...(frame.runtimeStateHash ? { runtimeStateHash: frame.runtimeStateHash } : {}),
  logs,
});

const verifyPersistedFrameState = (
  env: Env,
  persistedFrame: StorageFrameRecord,
): {
  expectedStateHash: string;
  actualStateHash: string;
  expectedCanonicalStateHash: string;
  actualCanonicalStateHash: string;
  ok: boolean;
} => {
  const expectedStateHash = persistedFrame.postStateHash;
  const storageHashMode = persistedFrame.hashMode === 'storage-merkle-v1';
  const replayCheckpointLineagePlan = persistedFrame.replicaMetaCheckpoint
    ? buildRuntimeCheckpointLineagePlan(env)
    : null;
  const actualReplicaMetaDigest = replayCheckpointLineagePlan
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(
        env,
        replayCheckpointLineagePlan,
        { omitIntermediateSingleSignerState: persistedFrame.replicaMetaStateMode === 'shared-entity-state' },
      ).digest
    : buildStorageLiveReplicaMetaCommitment(env).digest;
  const actualStateHash = computeStoragePostStateHash({
    height: persistedFrame.height,
    timestamp: persistedFrame.timestamp,
    replicaMetaDigest: actualReplicaMetaDigest,
    runtimeMachine: buildReplayVerifiableRuntimeMachineSnapshot(env, {
      pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
      excludePersistedFrameDbRecords: true,
    }),
  });
  const expectedCanonicalStateHash = storageHashMode
    ? String(persistedFrame.canonicalStateHash || '')
    : expectedStateHash;
  const actualCanonicalStateHash = storageHashMode
    ? (expectedCanonicalStateHash ? computeCanonicalStateHashFromEnv(env) : '')
    : actualStateHash;
  return {
    expectedStateHash,
    actualStateHash,
    expectedCanonicalStateHash,
    actualCanonicalStateHash,
    ok: expectedStateHash === actualStateHash
      && expectedCanonicalStateHash === actualCanonicalStateHash,
  };
};

export const verifyRuntimeChain = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: { fromSnapshotHeight?: number },
): Promise<VerifyRuntimeChainResult> => {
  const bootstrapEnv = createPersistedStorageEnv(runtimeId, runtimeSeed);
  const latestHeight = await resolvePersistedLatestHeight(bootstrapEnv);
  if (latestHeight <= 0) {
    throw new Error('REPLAY_INVARIANT_FAILED: no persisted runtime state');
  }
  const requestedFromHeight = Number.isFinite(Number(options?.fromSnapshotHeight))
    ? Math.max(1, Math.floor(Number(options?.fromSnapshotHeight)))
    : latestHeight;
  if (requestedFromHeight > latestHeight) {
    throw new Error(
      `REPLAY_INVARIANT_FAILED: requested height ${requestedFromHeight} exceeds latest ${latestHeight}`,
    );
  }
  const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(bootstrapEnv, requestedFromHeight);
  const checkpointHeight = await resolvePersistedSnapshotHeight(bootstrapEnv, latestHeight);
  let expectedStateHash = '';
  let actualStateHash = '';
  let expectedCanonicalStateHash = '';
  let actualCanonicalStateHash = '';
  let restoredHeight = selectedSnapshotHeight;
  let replayed: Awaited<ReturnType<typeof loadEnvFromStorage>> = null;
  try {
    await closeRuntimeDb(bootstrapEnv);
    await closeInfraDb(bootstrapEnv);
    replayed = await loadEnvFromStorage(runtimeId, runtimeSeed, selectedSnapshotHeight);
    if (!replayed) {
      throw new Error(
        `REPLAY_INVARIANT_FAILED: failed to restore checkpoint at height ${selectedSnapshotHeight}`,
      );
    }
    for (let height = selectedSnapshotHeight; height <= latestHeight; height += 1) {
      const persistedFrame = await readPersistedStorageFrameRecord(replayed.env, height);
      if (!persistedFrame) {
        throw new Error(`REPLAY_INVARIANT_FAILED: missing persisted frame at height ${height}`);
      }
      if (height > selectedSnapshotHeight) {
        await replayRecoveryFrameJournals(
          replayed.env,
          [buildRecoveryJournalFromStorageFrame(persistedFrame)],
        );
      }
      if (height < requestedFromHeight) continue;
      const verification = verifyPersistedFrameState(replayed.env, persistedFrame);
      ({
        expectedStateHash,
        actualStateHash,
        expectedCanonicalStateHash,
        actualCanonicalStateHash,
      } = verification);
      restoredHeight = height;
      if (!verification.ok) {
        return {
          ok: false,
          latestHeight,
          checkpointHeight,
          selectedSnapshotHeight,
          restoredHeight,
          expectedStateHash,
          actualStateHash,
          expectedCanonicalStateHash,
          actualCanonicalStateHash,
        };
      }
    }
  } finally {
    if (replayed) {
      await closeRuntimeDb(replayed.env);
      await closeInfraDb(replayed.env);
    }
    await closeRuntimeDb(bootstrapEnv);
    await closeInfraDb(bootstrapEnv);
  }

  return {
    ok: true,
    latestHeight,
    checkpointHeight,
    selectedSnapshotHeight,
    restoredHeight,
    expectedStateHash,
    actualStateHash,
    expectedCanonicalStateHash,
    actualCanonicalStateHash,
  };
};

export const readPersistedFrameJournal = async (env: Env, height: number): Promise<PersistedFrameJournal | null> => {
  const frame = await readPersistedStorageFrameRecord(env, height);
  if (!frame) return null;
  let logs: FrameLogEntry[] = [];
  if (await tryOpenFrameDb(env)) {
    try {
      const activity = await readFrameDbRuntimeActivity(getFrameDb(env), height);
      if (activity?.logs) logs = activity.logs;
    } catch (error) {
      throw new Error(
        `STORAGE_ACTIVITY_JOURNAL_READ_FAILED:height=${height}:` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return buildRecoveryJournalFromStorageFrame(frame, logs);
};

/**
 * Read the bounded display/activity journal without depending on replay frames.
 * Snapshot publication intentionally prunes non-checkpoint replay frames; the
 * compact activity row is the authoritative source for user-facing receipts.
 */
type StoredPersistedActivityJournal = PersistedActivityJournal & {
  logs: FrameLogEntry[];
};

export const readPersistedRuntimeActivityJournal = async (
  env: Env,
  height: number,
): Promise<StoredPersistedActivityJournal | null> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) {
    throw new Error(`STORAGE_ACTIVITY_JOURNAL_HEIGHT_INVALID:${String(height)}`);
  }
  if (!(await tryOpenFrameDb(env))) {
    throw new Error(`STORAGE_ACTIVITY_JOURNAL_DB_OPEN_FAILED:height=${targetHeight}`);
  }
  try {
    const activity = await readFrameDbRuntimeActivity(getFrameDb(env), targetHeight);
    if (!activity) return null;
    return {
      height: targetHeight,
      timestamp: activity.timestamp,
      runtimeInput: {
        runtimeTxs: [],
        entityInputs: activity.runtimeInput.entityInputs.map(input =>
          cloneIsolatedEntityInput(input as EntityInput)),
        ...(activity.runtimeInput.jInputs
          ? { jInputs: activity.runtimeInput.jInputs.map(input => structuredClone(input)) }
          : {}),
      },
      logs: activity.logs.map((entry) => ({ ...entry })),
    };
  } catch (error) {
    throw new Error(
      `STORAGE_ACTIVITY_JOURNAL_READ_FAILED:height=${targetHeight}:` +
      `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

export const readPersistedAccountFrameHistory = async (
  env: Env,
  entityId: string,
  counterpartyId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxAccountHeight?: number },
): Promise<AccountFrame[]> => {
  if (!(await tryOpenFrameDb(env))) return [];
  const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
    : Number.POSITIVE_INFINITY;
  const maxAccountHeight = Number.isFinite(Number(opts?.maxAccountHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxAccountHeight)))
    : Number.POSITIVE_INFINITY;
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit || 50))));
  const records = await readFrameDbAccountFrames(getFrameDb(env), entityId, counterpartyId, {
    limit: boundedLimit,
    ...(Number.isSafeInteger(maxRuntimeHeight) ? { maxRuntimeHeight } : {}),
    ...(Number.isSafeInteger(maxAccountHeight) ? { maxAccountHeight } : {}),
  });
  return records.map((record) => structuredClone(record.frame));
};

export const readPersistedEntityFrameHistory = async (
  env: Env,
  entityId: string,
  limit = 50,
  opts?: { maxRuntimeHeight?: number; maxEntityHeight?: number },
): Promise<CertifiedEntityFrameLink[]> => {
  if (!(await tryOpenFrameDb(env))) return [];
  const maxRuntimeHeight = Number.isFinite(Number(opts?.maxRuntimeHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxRuntimeHeight)))
    : Number.POSITIVE_INFINITY;
  const maxEntityHeight = Number.isFinite(Number(opts?.maxEntityHeight))
    ? Math.max(0, Math.floor(Number(opts?.maxEntityHeight)))
    : Number.POSITIVE_INFINITY;
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit || 50))));
  const records = await readFrameDbEntityFrames(getFrameDb(env), entityId, {
    limit: boundedLimit,
    ...(Number.isSafeInteger(maxRuntimeHeight) ? { maxRuntimeHeight } : {}),
    ...(Number.isSafeInteger(maxEntityHeight) ? { maxEntityHeight } : {}),
  });
  return records.map((record) => structuredClone(record.link));
};

export const readPersistedFrameJournals = async (
  env: Env,
  opts?: {
    fromHeight?: number;
    toHeight?: number;
    limit?: number;
  },
): Promise<PersistedFrameJournal[]> => {
  const latestHeight = await resolvePersistedLatestHeight(env);
  if (latestHeight <= 0) return [];
  const fromHeight = Math.max(1, Math.floor(opts?.fromHeight ?? 1));
  const boundedToHeight = Math.max(fromHeight, Math.floor(opts?.toHeight ?? latestHeight));
  const toHeight = Math.min(latestHeight, boundedToHeight);
  const limit = Math.max(1, Math.min(10_000, Math.floor(opts?.limit ?? 200)));
  const pageToHeight = Math.min(toHeight, fromHeight + limit - 1);
  const receipts: PersistedFrameJournal[] = [];
  for (let height = fromHeight; height <= pageToHeight; height += 1) {
    const receipt = await readPersistedFrameJournal(env, height);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
};

type PersistedReplayTarget = {
  latestHeight: number;
  targetHeight: number;
  selectedSnapshotHeight: number;
};

const resolvePersistedReplayTarget = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
  options: { prunedTargetReturnsNull?: boolean } = {},
): Promise<PersistedReplayTarget | null> => {
  // Safety overrides are forbidden at the restore boundary even when the DB is
  // empty. Delaying this check until a snapshot is found lets a production
  // daemon silently boot fresh with an unsafe restore configuration.
  assertStorageSafetyOverridesAllowed();
  const probeEnv = createPersistedStorageEnv(runtimeId, runtimeSeed);
  try {
    const latestHeight = await resolvePersistedLatestHeight(probeEnv);
    if (latestHeight <= 0) return null;
    const targetHeight = Math.max(
      1,
      Math.min(
        latestHeight,
        Number.isFinite(Number(targetHeightOverride))
          ? Math.floor(Number(targetHeightOverride))
          : latestHeight,
      ),
    );
    const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(probeEnv, targetHeight);
    if (selectedSnapshotHeight <= 0) {
      const latestSnapshotHeight = await resolvePersistedSnapshotHeight(probeEnv, latestHeight);
      if (
        options.prunedTargetReturnsNull &&
        latestSnapshotHeight > targetHeight
      ) return null;
      throw new Error(`STORAGE_RESTORE_SNAPSHOT_MISSING:height=${targetHeight}`);
    }
    return { latestHeight, targetHeight, selectedSnapshotHeight };
  } finally {
    await closeRuntimeDb(probeEnv);
    await closeInfraDb(probeEnv);
  }
};

const restoreReplayedActivityViews = async (
  env: Env,
  targetHeight: number,
): Promise<void> => {
  // Activity/history hydration is a read-model concern. Never erase deferred
  // input state reconstructed from the latest WAL frame.
  env.runtimeInput = env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] };
  await restoreOverlayFromFrameLog(env, targetHeight);
  await hydrateAccountFrameHistoryViews(env);
  env.frameLogs = [];
  if (!(await tryOpenFrameDb(env))) return;
  try {
    const activity = await readFrameDbRuntimeActivity(getFrameDb(env), targetHeight);
    env.frameLogs = activity?.logs?.map((entry) => ({ ...entry })) ?? [];
  } catch (error) {
    runtimeLog.warn('storage.activity_restore_failed', {
      height: targetHeight,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
};

const assertReplayedStorageFrameMatches = (
  env: Env,
  frame: StorageFrameRecord,
): void => {
  const verification = verifyPersistedFrameState(env, frame);
  if (verification.ok) return;
  const expectedEntities = new Map(
    (frame.canonicalEntityHashes ?? []).map(entry => [entry.entityId, entry.hash]),
  );
  const actualEntities = computeCanonicalEntityHashesFromEnv(env);
  const entityMismatches = actualEntities
    .filter(entry => expectedEntities.get(entry.entityId) !== entry.hash)
    .map(entry => ({
      entityId: entry.entityId,
      expected: expectedEntities.get(entry.entityId) ?? 'missing',
      actual: entry.hash,
    }));
  throw new Error(
    `STORAGE_RESTORE_REPLAY_HASH_MISMATCH:height=${frame.height}:` +
    `expected=${verification.expectedStateHash}:actual=${verification.actualStateHash}:` +
    `expectedCanonical=${verification.expectedCanonicalStateHash}:` +
    `actualCanonical=${verification.actualCanonicalStateHash}:` +
    `entities=${safeStringify(entityMismatches)}`,
  );
};

const finalizeReplayedStorageRestore = async (
  restored: NonNullable<Awaited<ReturnType<typeof loadEnvFromStorage>>>,
  target: PersistedReplayTarget,
  frame: StorageFrameRecord,
): Promise<void> => {
  const { env } = restored;
  assertReplayedStorageFrameMatches(env, frame);
  await restoreReplayedActivityViews(env, target.targetHeight);
  await assertCertifiedRegistrationEvidenceStore(env);
  envRecord(env)['__replayMeta'] = {
    checkpointHeight: target.selectedSnapshotHeight,
    selectedSnapshotHeight: target.selectedSnapshotHeight,
    selectedSnapshotLabel:
      target.selectedSnapshotHeight <= 1
        ? 'genesis:1'
        : `checkpoint:${target.selectedSnapshotHeight}`,
    latestHeight: target.latestHeight,
  };
  env.history = [];
};

const loadEnvFromStorageByReplay = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  targetHeightOverride?: number,
  options: { prunedTargetReturnsNull?: boolean } = {},
): Promise<Awaited<ReturnType<typeof loadEnvFromStorage>>> => {
  const target = await resolvePersistedReplayTarget(runtimeId, runtimeSeed, targetHeightOverride, options);
  if (!target) return null;
  const restored = await loadEnvFromStorage(
    runtimeId,
    runtimeSeed,
    target.selectedSnapshotHeight,
    options,
  );
  if (!restored) return null;
  let returningEnv = false;
  try {
    let targetFrame: StorageFrameRecord | null = null;
    for (let height = target.selectedSnapshotHeight; height <= target.targetHeight; height += 1) {
      const frame = await readPersistedStorageFrameRecord(restored.env, height);
      if (!frame) throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${height}`);
      targetFrame = frame;
      if (height > target.selectedSnapshotHeight) {
        await replayRecoveryFrameJournals(
          restored.env,
          [buildRecoveryJournalFromStorageFrame(frame)],
        );
      }
    }
    if (!targetFrame) throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${target.targetHeight}`);
    await finalizeReplayedStorageRestore(restored, target, targetFrame);
    restored.latestHeight = target.latestHeight;
    restored.checkpointHeight = target.selectedSnapshotHeight;
    restored.selectedSnapshotHeight = target.selectedSnapshotHeight;
    returningEnv = true;
    return restored;
  } finally {
    if (!returningEnv) {
      await closeRuntimeDb(restored.env);
      await closeInfraDb(restored.env);
    }
  }
};

export type PersistedRuntimeActivityPage = {
  ok: true;
  runtimeId?: string | undefined;
  latestHeight: number;
  fromHeight: number;
  toHeight: number;
  scannedFrames: number;
  returned: number;
  limit: number;
  scanLimit: number;
  nextBeforeHeight: number | null;
  filters: RuntimeActivityFilters;
  events: RuntimeActivityEvent[];
};

export const readPersistedRuntimeActivityPage = async (
  env: Env,
  opts: RuntimeActivityFilters & {
    beforeHeight?: number | undefined;
    limit?: number | undefined;
    scanLimit?: number | undefined;
  } = {},
): Promise<PersistedRuntimeActivityPage> => {
  const latestHeight = await resolvePersistedLatestHeight(env);
  const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit ?? 100))));
  const scanLimit = Math.max(1, Math.min(1000, Math.floor(Number(opts.scanLimit ?? 100))));
  if (latestHeight <= 0) {
    return {
      ok: true,
      runtimeId: env.runtimeId,
      latestHeight: 0,
      fromHeight: 0,
      toHeight: 0,
      scannedFrames: 0,
      returned: 0,
      limit,
      scanLimit,
      nextBeforeHeight: null,
      filters: opts,
      events: [],
    };
  }

  const startHeight = Math.max(
    1,
    Math.min(
      latestHeight,
      Number.isFinite(Number(opts.beforeHeight)) ? Math.floor(Number(opts.beforeHeight)) : latestHeight,
    ),
  );
  const events: RuntimeActivityEvent[] = [];
  let scannedFrames = 0;
  let height = startHeight;
  let uniqueEventCount = 0;
  for (; height >= 1 && scannedFrames < scanLimit && uniqueEventCount < limit; height -= 1) {
    const activity = await readPersistedRuntimeActivityJournal(env, height);
    scannedFrames += 1;
    if (!activity) continue;
    events.push(...buildRuntimeActivityEvents(activity, opts));
    uniqueEventCount = dedupeRuntimeActivityEvents(events).length;
  }

  const returned = dedupeRuntimeActivityEvents(events).slice(0, limit).map((event) => ({
    ...event,
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
    id: env.runtimeId ? `${env.runtimeId}:${event.id}` : event.id,
  }));
  return {
    ok: true,
    runtimeId: env.runtimeId,
    latestHeight,
    fromHeight: Math.max(1, height + 1),
    toHeight: startHeight,
    scannedFrames,
    returned: returned.length,
    limit,
    scanLimit,
    nextBeforeHeight: height >= 1 ? height : null,
    filters: opts,
    events: returned,
  };
};

export const readPersistedCheckpointSnapshot = async (
  env: Env,
  height: number,
): Promise<Record<string, unknown> | null> => {
  const targetHeight = Number.isFinite(height) ? Math.floor(height) : 0;
  if (targetHeight <= 0) return null;
  return withStorageConsistentRead(env, async () => {
    const restored = await loadEnvFromStorageByReplay(
      env.runtimeId,
      env.runtimeSeed,
      targetHeight,
      { prunedTargetReturnsNull: true },
    );
    if (!restored || restored.env.height !== targetHeight) {
      if (restored?.env) await closeRuntimeDb(restored.env);
      return null;
    }
    try {
      return buildRuntimeCheckpointSnapshot(restored.env);
    } finally {
      await closeRuntimeDb(restored.env);
    }
  });
};

const MAX_RUNTIME_RECORDING_JOURNAL_FRAMES = 10_000;

export const buildPersistedRuntimeRecording = async (
  env: Env,
  options: {
    signers: RuntimeRecoverySignerV1[];
    meta?: RuntimeRecoveryMetaV1;
    createdAt?: number;
  },
): Promise<RuntimeRecording> => {
  const createdAt = Math.max(0, Math.floor(Number(options.createdAt ?? Date.now())));
  const latestHeight = await getPersistedLatestHeight(env);
  if (latestHeight !== env.height) {
    throw new Error(
      `RUNTIME_RECORDING_LIVE_HEAD_MISMATCH:persisted=${latestHeight}:env=${env.height}`,
    );
  }
  if (latestHeight <= 0) {
    return buildRuntimeRecording([
      buildRuntimeRecoveryBundle(env, { ...options, createdAt, kind: 'snapshot' }),
    ], createdAt);
  }

  const minimumBaseHeight = Math.max(1, latestHeight - MAX_RUNTIME_RECORDING_JOURNAL_FRAMES);
  const checkpointHeights = (await listPersistedCheckpointHeights(env))
    .filter(height => height >= minimumBaseHeight && height <= latestHeight)
    .sort((left, right) => left - right);
  let baseHeight = latestHeight;
  let checkpoint: Record<string, unknown> | null = null;
  for (const candidateHeight of checkpointHeights) {
    const candidate = await readPersistedCheckpointSnapshot(env, candidateHeight);
    if (!candidate) continue;
    baseHeight = candidateHeight;
    checkpoint = candidate;
    break;
  }
  if (!checkpoint) {
    return buildRuntimeRecording([
      buildRuntimeRecoveryBundle(env, { ...options, createdAt, kind: 'snapshot' }),
    ], createdAt);
  }
  const snapshotBundle = buildRuntimeRecoveryCheckpointBundle(env, {
    ...options,
    checkpoint,
    createdAt,
  });
  if (baseHeight === latestHeight) {
    return buildRuntimeRecording([snapshotBundle], createdAt);
  }

  const expectedFrameCount = latestHeight - baseHeight;
  const frames = await readPersistedFrameJournals(env, {
    fromHeight: baseHeight + 1,
    toHeight: latestHeight,
    limit: expectedFrameCount,
  });
  if (
    frames.length !== expectedFrameCount
    || frames[0]?.height !== baseHeight + 1
    || frames.at(-1)?.height !== latestHeight
  ) {
    throw new Error(
      `RUNTIME_RECORDING_JOURNAL_INCOMPLETE:base=${baseHeight}:target=${latestHeight}:` +
      `expected=${expectedFrameCount}:actual=${frames.length}`,
    );
  }
  const tailBundle = buildRuntimeRecoveryBundle(env, {
    ...options,
    createdAt,
    kind: 'journal_tail',
    baseCheckpoint: {
      height: baseHeight,
      hash: snapshotBundle.checkpointHash!,
    },
    frames,
  });
  return buildRuntimeRecording([snapshotBundle, tailBundle], createdAt);
};

export type DetachedRuntimeRecordingAdapter = {
  readonly runtimeId: string;
  readonly baseHeight: number;
  readonly targetHeight: number;
  readAtHeight(height: number): Promise<Env>;
  close(): Promise<void>;
};

export const openDetachedRuntimeRecording = (
  recording: RuntimeRecording,
  runtimeSeed: string,
): DetachedRuntimeRecordingAdapter => {
  const validated = validateRuntimeRecording(recording);
  let closed = false;
  let activeProjection: Env | null = null;
  return {
    runtimeId: validated.runtimeId,
    baseHeight: validated.baseHeight,
    targetHeight: validated.targetHeight,
    async readAtHeight(height: number): Promise<Env> {
      if (closed) throw new Error('RUNTIME_RECORDING_ADAPTER_CLOSED');
      if (!Number.isSafeInteger(height) || height < validated.baseHeight || height > validated.targetHeight) {
        throw new Error(
          `RUNTIME_RECORDING_HEIGHT_UNAVAILABLE:height=${height}:` +
          `range=${validated.baseHeight}-${validated.targetHeight}`,
        );
      }
      activeProjection = await restoreEnvFromRecoveryBundles(validated.bundles, {
        runtimeSeed,
        runtimeId: validated.runtimeId,
        targetHeight: height,
        readOnly: true,
      });
      return activeProjection;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      activeProjection = null;
    },
  };
};

export const loadEnvFromDB = async (
  runtimeId?: string | null,
  runtimeSeed?: string | null,
  options?: {
    fromSnapshotHeight?: number;
    trustedJurisdictionRpcBindings?: readonly TrustedJurisdictionRpcBinding[];
  },
): Promise<Env | null> => {
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
        loadGossipProfiles: (targetEnv) => loadGossipProfilesFromInfraDb(targetEnv, infraGossipDbAccess),
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

export const clearDB = async (env?: Env): Promise<void> => {
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
      runtimeLog.error('db.clear_root_failed', { path: dbRootPath, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return;
  }

  if (!runtimeIsBrowser) return;

  try {
    const dbReady = await tryOpenDb(targetEnv);
    const infraReady = await tryOpenInfraDb(targetEnv);
    const storageReady = await tryOpenStorageDb(targetEnv, 'current');
    const storagePreviousReady = await tryOpenStorageDb(targetEnv, 'previous');
    const frameReady = await tryOpenFrameDb(targetEnv);
    if (dbReady) {
      const db = getRuntimeDb(targetEnv);
      await db.clear();
    }
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

export { scenarios } from './machine/scenarios';
export { parseScenario, mergeAndSortEvents } from './scenarios/parser.js';
export { executeScenario } from './scenarios/executor.js';
export { SCENARIOS, getScenario, getScenariosByTag, type ScenarioMetadata } from './scenarios/index.js';

export {
  deriveSignerKey,
  deriveSignerKeySync,
  getCachedSignerPrivateKey,
  registerSignerKey,
  registerSignerPublicKey,
  registerTestKeys,
  clearSignerKeys,
  signAccountFrame,
  verifyAccountSignature,
  getSignerPublicKey,
} from './account/crypto.js';
export {
  canonicalJurisdictionEventsHash,
} from './jurisdiction/event-observation';
export type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecording,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerAppointmentOwnerProofV1,
  TowerAppointmentV1,
  TowerDiscoverResponseV1,
  TowerEncryptedPayloadV1,
  TowerReceiptV1,
  TowerRestoreRequestV1,
  TowerRestoreResponseV1,
} from './recovery/types';
export {
  buildRuntimeRecoveryBundle,
  buildRuntimeRecoveryCheckpointBundle,
  computeRuntimeRecoveryBundleHash,
  computeRuntimeRecoveryCheckpointHash,
  validateRuntimeRecoveryBundle,
} from './recovery/bundle';
export {
  buildRuntimeRecording,
  validateRuntimeRecording,
} from './recovery/recording';
export {
  buildTowerAppointmentOwnerMessage,
  computeWatchtowerCounterDisputeAuthorizationHash,
  decryptRuntimeRecoveryBundle,
  decryptTowerPayloadWithWatchSeed,
  deriveRuntimeRecoveryActionLookupKey,
  deriveRuntimeRecoveryLookupKey,
  encryptTowerPayloadForWatchSeed,
  encryptRuntimeRecoveryBundle,
} from './recovery/crypto';
export { buildSingleSignerHanko } from './hanko/batch';
export {
  buildCrossJurisdictionPullReveal,
  getCrossJurisdictionPrivateSeed,
} from './extensions/cross-j/index';
export { buildDisputeArgumentsForSnapshot } from './protocol/dispute/arguments';
export {
  buildMppChallengeHeader,
  buildMppCredentialHeader,
  buildMppReceiptHeader,
  canonicalizeMppJson,
  computeMppChallengeId,
  decodeMppJson,
  encodeMppJson,
  parseMppChallengeHeader,
  parseMppCredentialHeader,
  parseMppReceiptHeader,
} from './agent-payments/mpp';
export type {
  MppChallenge,
  MppChallengeBindingInput,
  MppCredential,
  MppJsonRecord,
  MppJsonValue,
  MppReceipt,
} from './agent-payments/mpp';

// === NAME RESOLUTION WRAPPERS (override imports) ===
// Runtime no longer keeps a module-global env/db; these pure wrappers expose
// deterministic name formatting for callers that do not own an Env.
const searchEntityNames = (query: string, limit?: number) => searchEntityNamesOriginal(null, query, limit);
const resolveEntityName = (entityId: string) => resolveEntityNameOriginal(null, entityId);
const getEntityDisplayInfoFromProfile = (entityId: string) => getEntityDisplayInfoFromProfileOriginal(null, entityId);

// Avatar functions are already imported and exported above

// JAdapter - Unified J-Machine interface (replaces old evms/ and jurisdiction/)
export { createJAdapter } from './jadapter';
export type { JAdapter, JAdapterConfig, JAdapterMode, JEvent } from './jadapter';
export { applyJEventsToEnv, buildJEventsRuntimeInput } from './jadapter/watcher';
export {
  getActiveJAdapter,
  getEntityJAdapter,
  buildDebtEnforcementRuntimeInputFromProjection,
  buildDebtEnforcementRuntimeInput,
} from './machine/jurisdiction-api';
export type {
  CrossJurisdictionSwapSubmitParams,
  CrossJurisdictionSwapSubmitResult,
  DebtEnforcementProjectionRuntimeInputParams,
  DebtEnforcementRuntimeInputParams,
} from './machine/jurisdiction-api';

export async function submitCrossJurisdictionIntent(
  env: Env,
  route: CrossJurisdictionSwapRoute,
): Promise<CrossJurisdictionSwapSubmitResult> {
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash(route);
  if (canonicalRoute.status !== 'intent' || canonicalRoute.sourcePull || canonicalRoute.targetPull) {
    throw new Error(`CROSS_J_INTENT_STATE_INVALID:${canonicalRoute.orderId}`);
  }
  const routing = getRuntimeOutputRoutingDeps();
  const targetRuntimeId = routing.resolveRuntimeIdForCrossJurisdictionEntity(
    env,
    canonicalRoute.source.counterpartyEntityId,
  );
  if (!targetRuntimeId) {
    throw new Error(`CROSS_J_INTENT_HUB_RUNTIME_UNKNOWN:${canonicalRoute.source.counterpartyEntityId}`);
  }
  const sourceRuntimeId = normalizeRuntimeId(env.runtimeId);
  if (!sourceRuntimeId) throw new Error('CROSS_J_INTENT_SOURCE_RUNTIME_INVALID');
  const envelope: RuntimeEntityInputsEnvelope = {
    sourceRuntimeId,
    sourceRuntimeHeight: Math.max(0, Math.floor(Number(env.height || 0))),
    sourceRuntimeTimestamp: Math.max(0, Math.floor(Number(env.timestamp || 0))),
    entityInputs: [],
    crossJurisdictionIntent: structuredClone(canonicalRoute),
  };
  const state = ensureRuntimeState(env);
  const direct = state.directEntityInputsDispatch;
  let delivery = direct
    ? requireDeliveryResult(
        direct(targetRuntimeId, envelope, envelope.sourceRuntimeTimestamp),
        'CROSS_J_INTENT_DIRECT_DELIVERY_INVALID',
      )
    : null;
  if (!delivery || !isDeliveryDelivered(delivery)) {
    const p2p = getP2P(env);
    if (p2p) {
      delivery = requireDeliveryResult(
        p2p.enqueueEntityInputsDelivery(
          targetRuntimeId,
          envelope,
          envelope.sourceRuntimeTimestamp,
        ),
        'CROSS_J_INTENT_P2P_DELIVERY_INVALID',
      );
    }
  }
  if (!delivery) {
    throw new Error('CROSS_J_INTENT_NOT_DELIVERED:NO_TRANSPORT');
  }
  if (!isDeliveryDelivered(delivery)) {
    // M1 is intentionally best-effort: no durable outbox and no automatic
    // retry. The caller may resubmit the same orderId after the Hub reconnects.
    throw new Error(`CROSS_J_INTENT_NOT_DELIVERED:${delivery.code}`);
  }
  return { route: canonicalRoute };
}

export async function submitCrossJurisdictionSwap(
  env: Env,
  params: CrossJurisdictionSwapSubmitParams,
): Promise<CrossJurisdictionSwapSubmitResult> {
  const { route } = buildCrossJurisdictionSwapSubmission(env, params);
  return submitCrossJurisdictionIntent(env, route);
}

// Entity ID utilities - universal parsing, provider-scoping, comparison
export {
  normalizeEntityId,
  compareEntityIds,
  isLeftEntity,
  parseUniversalEntityId,
  createProviderScopedEntityId,
  getShortId,
  formatEntityIdDisplay,
  entityIdsEqual,
  extractProvider,
} from './entity/id';
export type { ParsedEntityId } from './entity/id';

// ASCII visualization exports
export { formatRuntime, formatEntity, formatAccount, formatOrderbook, formatSummary } from './qa/runtime-ascii';
