import { createExternalStore } from '../../../packages/client-core/external-store';
import {
  lockVaultRuntime,
  protectVaultRuntime,
  replaceVaultRuntime,
  unlockVaultRuntime,
} from '../../../packages/runtime-client/vault-lifecycle';
import {
  derived as derived,
  get as get,
  toReadableStore,
} from './storeBindings';

import { Wallet } from 'ethers';

import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeReplica,
  JurisdictionConfig,
  PersistedFrameJournal,
  RuntimeInput,
  RuntimeRecoveryBundleV1,
  TowerAppointmentV1,
  TowerCounterDisputeRemedy,
  TowerLastResortPayloadV1,
  TowerReceiptV1,
  XLNModule,
} from '@xln/runtime/api/public/runtime-module';

import {
  activeRuntimeId,
  coordinateRuntimeSelection,
  runtimeOperations,
  runtimes,
  type RuntimeSelectionLease,
} from './runtimeStore';

import {
  dispatchRuntimeInputToRuntimeEnv,
  getXLN,
  resolveRelayUrls,
  resumeRemoteRuntimeCommandIntents,
  setXlnEnvironment,
  submitEntityInputs as submitXlnEntityInputs,
  xlnInstance,
} from './xlnStore';

import { settings } from './settingsStore';

import { toasts } from './toastStore';

import { errorLog } from './errorLogStore';

import { writeHubJoinPreference, writeSavedCollateralPolicy } from '../utils/onboardingPreferences';

import { writeOnboardingCompleteForEntities } from '../utils/onboardingState';

import { tabOperations } from './tabStore';

import { isInactiveTabStandby } from '../utils/activeTabLock';

import { unwrapLiveRuntimeEnv } from '../utils/liveRuntimeEnv';

import { registerDebugSurface } from '../utils/debugSurface';

import { generateLazyEntityIdPreview } from '../utils/lazyEntityId';

import { parseStorageSchemaMismatch } from '../utils/storageSchemaRecovery';

import { VAULT_STORAGE_KEY } from '../contracts/browserPersistence';

import {
  deleteVaultDeviceKey,
  sameVaultProtectionLease,
  type ProtectedVaultSecrets,
  type VaultUnlockDurationMs,
} from '../security/vaultProtection';

import { lockRuntimeCommandJournal } from './runtimeCommandJournalKeyring';

import { deriveJurisdictionSignerIndex } from '../../../../runtime/jurisdiction/machine/signer-derivation';

import {
  findRuntimeByIdCaseInsensitive,
  hasConnectedJurisdictionAdapter,
  hasRuntimeJurisdictionAddresses,
  listDefaultJurisdictionImports,
  resolveJurisdictionConfig,
  resolveJurisdictionRpc,
  resolveRpcUrl,
  waitForCondition,
} from './vault-helpers';

import {
  RECOVERY_SNAPSHOT_INTERVAL_FRAMES,
  RECOVERY_TOWER_STATUS_LIMIT,
  RECOVERY_UPLOAD_DEBOUNCE_MS,
  RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS,
  WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
  WATCHTOWER_SAFETY_MARGIN_BLOCKS,
  applyRecoveryBundleMetadata,
  buildDefaultRuntimeRecoveryConfig,
  buildRuntimeRecoveryMeta,
  buildRuntimeRecoverySigners,
  buildSignerEntityConfig,
  buildTowerRequestUrl,
  deriveAddress,
  derivePrivateKey,
  discoverRuntimeRecoveryCandidates,
  fetchTowerServerInfo,
  findEntityReplicaByEntityAndSigner,
  findEntityReplicaByEntityId,
  findJReplicaByName,
  getConfiguredRecoveryTowers,
  getEntityReplicaJurisdictionName,
  getJReplicaContractAddress,
  getJReplicaJurisdictionName,
  getReplayMeta,
  getRuntimeP2PHandle,
  getSignerDerivationIndex,
  installVaultRuntimeCommandJournalKeys,
  mergeRuntimeRecoveryTowerReceipts,
  normalizeEntityId,
  normalizeJurisdictionKey,
  normalizeRecoveryTowerConfigs,
  normalizeRuntimeId,
  requireEntityProviderDeploymentBlock,
  requireJurisdictionBlockTimeMs,
  runtimeCreationInFlight,
  schemaMismatchRecoveryRuntimeIds,
  serializeVaultState,
  shouldSkipRuntimeRecoveryUploadAtHeight,
  signerCreationInFlight,
  summarizeRuntimeRecoveryTowerFailure,
  summarizeRuntimeRecoveryTowerReceipt,
  type CreateRuntimeOptions,
  type FaucetResult,
  type HealthMachine,
  type HealthPayload,
  type ImportedJMachineConfig,
  type JurisdictionsPayload,
  type RecoveryTowerConfig,
  type Runtime,
  type RuntimeRecoveryCandidate,
  type RuntimeRecoveryConfig,
  type RuntimeRecoveryTowerFailureSummary,
  type RuntimeRecoveryTowerReceiptSummary,
  type RuntimesState,
  type Signer,
  type TowerServerInfo,
} from './vault-recovery';
import { buildDelayedLastResortAppointmentsForTower } from './vault-watchtower';
import {
  summarizeHealth,
  resolveJurisdictionChainId,
  fetchJurisdictions,
  fundSignerWalletViaFaucet,
  fundRuntimeSignersInBrowserVM,
} from './vault-bootstrap';
import {
  getRuntimeFatalDiagnostics,
  runtimeInputWorkSummary,
  runtimeQuiesceWorkSummary,
} from './vault-lifecycle-helpers';
import {
  createVaultLockScheduler,
  protectRuntimeForDevice,
  restoreRuntimeFromDevice,
} from './vaultLifecycleController';
export { buildDelayedLastResortAppointmentsForTower } from './vault-watchtower';

export type {
  RecoveryTowerConfig,
  RecoveryTowerSetupMode,
  Runtime,
  RuntimeRecoveryCandidate,
  RuntimeRecoveryCandidateSource,
  RuntimeRecoveryConfig,
  RuntimeRecoveryDiscoveryFailure,
  RuntimeRecoveryDiscoveryResult,
  RuntimeRecoveryFailureCategory,
  RuntimeRecoveryPeerRequest,
  RuntimeRecoveryPeerSource,
  RuntimeRecoveryTowerFailureSummary,
  RuntimeRecoveryTowerReceiptSummary,
  RuntimesState,
  Signer,
} from './vault-recovery';

export type { VaultUnlockDurationMs } from '../security/vaultProtection';

export {
  buildRuntimeRecoveryConfigForMode,
  classifyRuntimeRecoveryDiscoveryFailure,
  discoverRuntimeRecoveryCandidates,
  fetchTowerServerInfo,
  mergeRuntimeRecoveryTowerReceipts,
  parseRuntimeRecoveryCandidateFile,
  resolveDefaultRecoveryTowerUrls,
  shouldSkipRuntimeRecoveryUploadAtHeight,
  summarizeRuntimeRecoveryTowerFailure,
  summarizeRuntimeRecoveryTowerReceipt,
} from './vault-recovery';

// Default state
const defaultState: RuntimesState = {
  runtimes: {},
  activeRuntimeId: null,
};

/**
 * Installs a verified recovery candidate only after the previous environment
 * has stopped producing inputs and closed its persistence handles.
 */
export async function restoreRuntimeEnvFromRecoveryCandidate(
  runtime: Runtime,
  xln: XLNModule,
  candidate: RuntimeRecoveryCandidate,
): Promise<{ env: RuntimeReplica; bundle: RuntimeRecoveryBundleV1 }> {
  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId) throw new Error('RECOVERY_RESTORE_RUNTIME_ID_INVALID');
  if (normalizeRuntimeId(candidate.runtimeId) !== runtimeId) {
    throw new Error(
      `RECOVERY_RESTORE_CANDIDATE_RUNTIME_ID_MISMATCH: runtime=${runtimeId} candidate=${candidate.runtimeId}`,
    );
  }
  applyRecoveryBundleMetadata(runtime, candidate.metadataBundle);
  await registerRuntimeSignerKeys(runtime, xln);
  const existingEntry = get(runtimes).get(runtimeId);
  const existingEnv = existingEntry?.env ? (unwrapLiveRuntimeEnv(existingEntry.env) ?? existingEntry.env) : null;
  if (existingEnv) {
    unregisterRuntimeEnvChange(runtimeId);
    await suspendRuntimeEnvActivity(existingEnv, xln);
    if (typeof xln.closeRuntimeDb === 'function') await xln.closeRuntimeDb(existingEnv);
    if (typeof xln.closeInfraDb === 'function') await xln.closeInfraDb(existingEnv);
  }
  const restoredEnv = await xln.restoreEnvFromRecoveryBundles(candidate.bundles, {
    runtimeSeed: runtime.seed,
    runtimeId,
  });
  applyRuntimeLogPreference(restoredEnv);
  await xln.persistRestoredEnvToDB(restoredEnv);
  return { env: restoredEnv, bundle: candidate.tipBundle };
}

export const DEFAULT_VAULT_UNLOCK_DURATION_MS: VaultUnlockDurationMs = 600_000;

const vaultLockScheduler = createVaultLockScheduler({
  now: () => Date.now(),
  schedule: (task, delayMs) => setTimeout(task, delayMs),
  cancel: timer => clearTimeout(timer),
});

const BROWSER_GOSSIP_POLL_MS = 250;

const loggedLiveJAdapterReimports = new Set<string>();

// Main store. The framework-neutral bindings are the sole writers; UI and
// React consume the same readonly snapshots through their respective adapters.
const runtimesStateBinding = createExternalStore<RuntimesState>(defaultState);
const vaultStorageLoadedBinding = createExternalStore(false);

export const runtimesStateExternalStore = runtimesStateBinding.store;
export const vaultStorageLoadedExternalStore = vaultStorageLoadedBinding.store;
export const runtimesState = toReadableStore(runtimesStateBinding.store);
export const vaultStorageLoaded = toReadableStore(vaultStorageLoadedBinding.store);

// Derived stores
export const activeRuntime = derived(runtimesState, $state => {
  if (!$state.activeRuntimeId) return null;
  return $state.runtimes[$state.activeRuntimeId] || null;
});

export const activeSigner = derived(activeRuntime, $runtime => {
  if (!$runtime) return null;
  return $runtime.signers[$runtime.activeSignerIndex] || null;
});

export const allRuntimes = derived(runtimesState, $state => {
  return Object.values($state.runtimes).sort((a, b) => b.createdAt - a.createdAt);
});

let initializePromise: Promise<void> | null = null;

let initialized = false;

let resumeListenerRegistered = false;

let resumeRefreshPromise: Promise<boolean> | null = null;

let runtimeSyncChannel: BroadcastChannel | null = null;

let runtimeResumeTrigger: (() => void) | null = null;

const runtimeEnvChangeUnsubscribers = new Map<string, () => void>();

const runtimeRecoveryBarrierUnsubscribers = new Map<string, () => void>();

const runtimeRecoveryUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();

const runtimeRecoveryUploads = new Map<string, Set<Promise<void>>>();

const runtimeRecoveryUploadMeta = new Map<
  string,
  {
    lastUploadedHeight: number;
    lastBundleHash: string | null;
    lastSnapshotHeight: number;
    lastSnapshotHash: string | null;
  }
>();

const recoveryTowerInfoCache = new Map<string, { fetchedAt: number; info: TowerServerInfo }>();

const persistRuntimeMetadataSnapshot = (): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VAULT_STORAGE_KEY, serializeVaultState(get(runtimesState)));
  } catch (error) {
    errorLog.log('Runtime metadata snapshot persistence failed', 'Runtime Recovery', error);
  }
};

const persistVaultStateOrThrow = (): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(VAULT_STORAGE_KEY, serializeVaultState(get(runtimesState)));
};

const readPersistedVaultProtection = (runtimeId: string): ProtectedVaultSecrets | undefined => {
  if (typeof localStorage === 'undefined') return undefined;
  const serialized = localStorage.getItem(VAULT_STORAGE_KEY);
  if (!serialized) return undefined;
  const parsed = JSON.parse(serialized) as Partial<RuntimesState>;
  for (const [storedId, runtime] of Object.entries(parsed.runtimes || {})) {
    if (normalizeRuntimeId(runtime?.id || storedId) !== runtimeId) continue;
    return runtime?.protectedSecrets;
  }
  return undefined;
};

const scheduleVaultLock = (runtime: Runtime): void => {
  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId) return;
  const expectedProtection = runtime.protectedSecrets;
  const unlockUntil = expectedProtection?.unlockUntil;
  vaultLockScheduler.schedule(
    runtimeId,
    unlockUntil ?? null,
    () => {
      void vaultOperations.lockRuntime(runtimeId, expectedProtection).catch(error => {
        errorLog.log('Timed wallet lock failed', 'Runtime Security', { runtimeId, error });
      });
    },
  );
};

const vaultLifecycleEffects = Object.freeze({
  scheduleLock: scheduleVaultLock,
  reportCleanupError: (runtimeId: string, error: unknown) =>
    errorLog.log('Previous wallet key cleanup failed', 'Runtime Security', { runtimeId, error }),
});

const updateRuntimeRecoveryMetadata = (
  runtimeId: string,
  update: (previous: RuntimeRecoveryConfig) => RuntimeRecoveryConfig,
): Runtime | null => {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return null;
  let updatedRuntime: Runtime | null = null;
  runtimesStateBinding.controller.update(state => {
    const runtime = state.runtimes[normalizedRuntimeId];
    if (!runtime) return state;
    const nextRecovery = update(runtime.recovery || {});
    updatedRuntime = {
      ...runtime,
      recovery: {
        ...nextRecovery,
        towers: normalizeRecoveryTowerConfigs(nextRecovery.towers),
        useDefaultTowers: nextRecovery.useDefaultTowers === true,
      },
    };
    return {
      ...state,
      runtimes: {
        ...state.runtimes,
        [normalizedRuntimeId]: updatedRuntime,
      },
    };
  });
  if (!updatedRuntime) return null;
  persistRuntimeMetadataSnapshot();
  const runtimeEntry = get(runtimes).get(normalizedRuntimeId);
  const entryEnv = runtimeEntry?.env || null;
  if (entryEnv) {
    runtimes.update(currentRuntimes => {
      const updated = new Map(currentRuntimes);
      updated.set(normalizedRuntimeId, runtimeToEntry(updatedRuntime!, entryEnv));
      return updated;
    });
  }
  return updatedRuntime;
};

export async function tryRestoreRuntimeEnvFromTower(
  runtime: Runtime,
  xln: XLNModule,
): Promise<{ env: RuntimeReplica; bundle: RuntimeRecoveryBundleV1 } | null> {
  if (
    typeof xln.restoreEnvFromRecoveryBundles !== 'function' ||
    typeof xln.decryptRuntimeRecoveryBundle !== 'function' ||
    typeof xln.deriveRuntimeRecoveryLookupKey !== 'function' ||
    typeof xln.persistRestoredEnvToDB !== 'function'
  ) {
    return null;
  }

  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId || !runtime.seed) return null;

  const discovery = await discoverRuntimeRecoveryCandidates(
    runtime.seed,
    runtime.recovery ? { recovery: runtime.recovery, xln } : { xln },
  );
  if (discovery.candidates.length === 0) {
    if (discovery.errors.length > 0) {
      throw new Error(
        `[VaultStore] Tower restore failed for ${runtimeId.slice(0, 12)}: ${discovery.errors.join(' | ')}`,
      );
    }
    return null;
  }

  const best = discovery.candidates[0]!;
  if (discovery.candidates.length > 1) {
    const conflictingSameHeight = discovery.candidates.some(
      candidate =>
        candidate !== best &&
        candidate.runtimeHeight === best.runtimeHeight &&
        candidate.checkpointHash !== best.checkpointHash,
    );
    if (conflictingSameHeight) {
      errorLog.log(
        `Tower restore conflict detected for ${runtimeId.slice(0, 12)}; choosing highest valid bundle from ${best.sourceLabel}`,
        'Runtime Recovery',
        { runtimeId, sourceLabel: best.sourceLabel, candidateCount: discovery.candidates.length },
      );
    }
  }
  return restoreRuntimeEnvFromRecoveryCandidate(runtime, xln, best);
}

async function uploadRuntimeRecoverySnapshot(runtimeId: string, env: RuntimeReplica, xln: XLNModule): Promise<void> {
  if (
    typeof xln.buildRuntimeRecoveryBundle !== 'function' ||
    typeof xln.encryptRuntimeRecoveryBundle !== 'function' ||
    typeof xln.buildTowerAppointmentOwnerMessage !== 'function'
  ) {
    return;
  }

  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  const runtime = get(runtimesState).runtimes[normalizedRuntimeId];
  if (!runtime?.seed) return;
  if (Number(env.state.height || 0) <= 0) return;
  if (!(env.state.eReplicas instanceof Map) || env.state.eReplicas.size === 0) return;
  const towers = getConfiguredRecoveryTowers(runtime);
  if (towers.length === 0) return;

  const previous = runtimeRecoveryUploadMeta.get(normalizedRuntimeId);
  if (previous && Number(env.state.height || 0) < previous.lastUploadedHeight) return;

  const height = Math.max(0, Math.floor(Number(env.state.height || 0)));
  if (shouldSkipRuntimeRecoveryUploadAtHeight(previous, height)) return;
  const signers = buildRuntimeRecoverySigners(runtime);
  const meta = buildRuntimeRecoveryMeta(runtime);
  const shouldUploadSnapshot =
    !previous ||
    !previous.lastSnapshotHash ||
    previous.lastSnapshotHeight <= 0 ||
    height - previous.lastSnapshotHeight >= RECOVERY_SNAPSHOT_INTERVAL_FRAMES ||
    typeof xln.readPersistedFrameJournals !== 'function';

  let backupSlot = 0;
  let bundle: RuntimeRecoveryBundleV1;
  if (shouldUploadSnapshot) {
    bundle = xln.buildRuntimeRecoveryBundle(env, { signers, meta, kind: 'snapshot' });
  } else {
    const baseSnapshotHeight = previous.lastSnapshotHeight;
    const baseSnapshotHash = previous.lastSnapshotHash;
    if (!baseSnapshotHash) throw new Error('RECOVERY_UPLOAD_SNAPSHOT_HASH_MISSING');
    const fromHeight = baseSnapshotHeight + 1;
    const frames = await xln.readPersistedFrameJournals(env, {
      fromHeight,
      toHeight: height,
      limit: RECOVERY_SNAPSHOT_INTERVAL_FRAMES,
    });
    const expectedFrames = height - baseSnapshotHeight;
    const contiguous =
      frames.length === expectedFrames &&
      frames.every((frame, index) => Math.max(0, Math.floor(Number(frame.height || 0))) === fromHeight + index);
    if (contiguous) {
      backupSlot = 1;
      bundle = xln.buildRuntimeRecoveryBundle(env, {
        signers,
        meta,
        kind: 'journal_tail',
        baseCheckpoint: {
          height: baseSnapshotHeight,
          hash: baseSnapshotHash,
        },
        frames,
      });
    } else {
      bundle = xln.buildRuntimeRecoveryBundle(env, { signers, meta, kind: 'snapshot' });
    }
  }
  const encrypted = await xln.encryptRuntimeRecoveryBundle(bundle, runtime.seed);
  if (
    previous &&
    previous.lastBundleHash === encrypted.bundleHash &&
    previous.lastUploadedHeight === encrypted.height
  ) {
    return;
  }

  const signedAt = Date.now();
  const message = xln.buildTowerAppointmentOwnerMessage(
    normalizedRuntimeId,
    'blind_backup',
    encrypted.lookupKey,
    backupSlot,
    encrypted.bundleHash,
    encrypted.height,
    signedAt,
    undefined,
  );
  const signature = await new Wallet(derivePrivateKey(runtime.seed, 0)).signMessage(message);
  const appointment: TowerAppointmentV1 = {
    type: 'tower_appointment',
    version: 1,
    towerMode: 'blind_backup',
    lookupKey: encrypted.lookupKey,
    slot: backupSlot,
    bundle: encrypted,
    ownerProof: {
      runtimeId: normalizedRuntimeId,
      signedAt,
      signature,
    },
  };

  const minSuccessfulTowers = Math.max(1, Math.floor(Number(runtime.recovery?.minSuccessfulTowers ?? 1)));
  let successfulTowers = 0;
  const errors: string[] = [];
  let maxObservedStoredBytes = runtime.recovery?.lastKnownStoredBytes ?? 0;
  const delayedTowers = towers.filter(tower => tower.towerMode === 'delayed_last_resort');
  const activeTowerErrors: string[] = [];
  const uploadCheckedAt = Date.now();
  const receiptSummaries: RuntimeRecoveryTowerReceiptSummary[] = [];
  const failureSummaries: RuntimeRecoveryTowerFailureSummary[] = [];

  for (const tower of towers) {
    try {
      const appointmentUrl = buildTowerRequestUrl(tower.url, '/api/tower/appointment');
      const response = await fetch(appointmentUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(appointment),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string; receipt?: TowerReceiptV1 };
      if (!response.ok || !payload.ok) {
        const errorText = String(payload.error || `HTTP_${response.status}`);
        errors.push(`${tower.url}:${errorText}`);
        failureSummaries.push(summarizeRuntimeRecoveryTowerFailure(tower, errorText, uploadCheckedAt));
        if (errorText.startsWith('TOWER_QUOTA_EXCEEDED')) {
          updateRuntimeRecoveryMetadata(normalizedRuntimeId, previousRecovery => ({
            ...previousRecovery,
            lastQuotaWarningAt: Date.now(),
          }));
          toasts.warning(
            'Recovery backup quota exceeded. Runtime state is larger than the free tower allowance.',
            8_000,
          );
        }
        continue;
      }
      if (!payload.receipt) {
        const errorText = 'TOWER_RECEIPT_MISSING';
        errors.push(`${tower.url}:${errorText}`);
        failureSummaries.push(summarizeRuntimeRecoveryTowerFailure(tower, errorText, uploadCheckedAt));
        continue;
      }
      const receiptSummary = summarizeRuntimeRecoveryTowerReceipt(tower, payload.receipt);
      receiptSummaries.push(receiptSummary);
      successfulTowers += 1;
      maxObservedStoredBytes = Math.max(maxObservedStoredBytes, Number(payload.receipt.storedBytes || 0));
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      errors.push(`${tower.url}:${errorText}`);
      failureSummaries.push(summarizeRuntimeRecoveryTowerFailure(tower, errorText, uploadCheckedAt));
    }
  }

  for (const tower of delayedTowers) {
    try {
      const info = await fetchTowerServerInfo(tower.url);
      const towerSignerAddress = normalizeRuntimeId(info.signerAddress || '');
      if (!towerSignerAddress) {
        throw new Error('TOWER_SIGNER_ADDRESS_MISSING');
      }
      const lastResortAppointments = await buildDelayedLastResortAppointmentsForTower(
        runtime,
        env,
        xln,
        tower,
        towerSignerAddress,
        encrypted,
      );
      for (const upload of lastResortAppointments) {
        const appointmentUrl = buildTowerRequestUrl(tower.url, '/api/tower/appointment');
        const response = await fetch(appointmentUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(upload.appointment),
        });
        const payload = (await response.json()) as { ok: boolean; error?: string; receipt?: TowerReceiptV1 };
        if (!response.ok || !payload.ok) {
          const errorText = String(payload.error || `HTTP_${response.status}`);
          if (errorText.startsWith('TOWER_QUOTA_EXCEEDED')) {
            updateRuntimeRecoveryMetadata(normalizedRuntimeId, previousRecovery => ({
              ...previousRecovery,
              lastQuotaWarningAt: Date.now(),
            }));
            toasts.warning(
              'Watchtower dispute backup quota exceeded. Last-resort coverage is incomplete until the runtime state shrinks or quota is raised.',
              8_000,
            );
          }
          throw new Error(`${upload.triggerHint}:${errorText}`);
        }
        if (!payload.receipt) {
          throw new Error(`${upload.triggerHint}:TOWER_RECEIPT_MISSING`);
        }
        receiptSummaries.push(summarizeRuntimeRecoveryTowerReceipt(tower, payload.receipt));
        maxObservedStoredBytes = Math.max(maxObservedStoredBytes, Number(payload.receipt.storedBytes || 0));
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      activeTowerErrors.push(`${tower.url}:${errorText}`);
      failureSummaries.push(summarizeRuntimeRecoveryTowerFailure(tower, errorText, uploadCheckedAt));
    }
  }

  updateRuntimeRecoveryMetadata(normalizedRuntimeId, previousRecovery => ({
    ...previousRecovery,
    towers,
    lastKnownStoredBytes: maxObservedStoredBytes,
    lastTowerUploadAttemptAt: uploadCheckedAt,
    lastTowerUploadAttemptHeight: encrypted.height,
    lastTowerReceipts: mergeRuntimeRecoveryTowerReceipts(previousRecovery.lastTowerReceipts, receiptSummaries),
    lastTowerFailures: failureSummaries.slice(0, RECOVERY_TOWER_STATUS_LIMIT),
  }));
  if (successfulTowers < minSuccessfulTowers) {
    throw new Error(
      `[VaultStore] Tower appointment failed for ${normalizedRuntimeId.slice(0, 12)}: ${errors.join(' | ') || 'no tower accepted backup'}`,
    );
  }
  if (activeTowerErrors.length > 0) {
    throw new Error(
      `[VaultStore] Tower last-resort appointment failed for ${normalizedRuntimeId.slice(0, 12)}: ${activeTowerErrors.join(' | ')}`,
    );
  }
  runtimeRecoveryUploadMeta.set(normalizedRuntimeId, {
    lastUploadedHeight: encrypted.height,
    lastBundleHash: encrypted.bundleHash,
    lastSnapshotHeight:
      (bundle.kind ?? 'snapshot') === 'snapshot' ? encrypted.height : (previous?.lastSnapshotHeight ?? 0),
    lastSnapshotHash:
      (bundle.kind ?? 'snapshot') === 'snapshot'
        ? String(bundle.checkpointHash || '').toLowerCase()
        : (previous?.lastSnapshotHash ?? null),
  });
  persistRuntimeMetadataSnapshot();
}

function trackRuntimeRecoveryUpload(runtimeId: string, upload: Promise<void>): Promise<void> {
  const active = runtimeRecoveryUploads.get(runtimeId) ?? new Set<Promise<void>>();
  runtimeRecoveryUploads.set(runtimeId, active);
  const tracked = upload.finally(() => {
    active.delete(tracked);
    if (active.size === 0) runtimeRecoveryUploads.delete(runtimeId);
  });
  active.add(tracked);
  return tracked;
}

async function drainRuntimeRecoveryUploads(runtimeId: string): Promise<void> {
  // A debounced upload may already own a socket when shutdown begins. Keep the
  // tower alive until every such request settles; otherwise clean shutdown can
  // manufacture a connection failure after all application work has completed.
  while (runtimeRecoveryUploads.has(runtimeId)) {
    await Promise.allSettled(Array.from(runtimeRecoveryUploads.get(runtimeId) ?? []));
  }
}

function scheduleRuntimeRecoveryUpload(runtimeId: string, env: RuntimeReplica, xln: XLNModule): void {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const existingTimer = runtimeRecoveryUploadTimers.get(normalizedRuntimeId);
  if (existingTimer) clearTimeout(existingTimer);
  runtimeRecoveryUploadTimers.set(
    normalizedRuntimeId,
    setTimeout(() => {
      runtimeRecoveryUploadTimers.delete(normalizedRuntimeId);
      void trackRuntimeRecoveryUpload(
        normalizedRuntimeId,
        uploadRuntimeRecoverySnapshot(normalizedRuntimeId, unwrapLiveRuntimeEnv(env) ?? env, xln),
      ).catch(error => {
        errorLog.log(`Tower recovery upload failed for ${normalizedRuntimeId.slice(0, 12)}`, 'Runtime Recovery', {
          runtimeId: normalizedRuntimeId,
          error,
        });
      });
    }, RECOVERY_UPLOAD_DEBOUNCE_MS),
  );
}

const getLiveRuntimeEnvForId = (runtimeId: string, fallback?: RuntimeReplica | null): RuntimeReplica | null => {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  const latest = normalizedRuntimeId ? get(runtimes).get(normalizedRuntimeId)?.env : null;
  return unwrapLiveRuntimeEnv(latest) ?? unwrapLiveRuntimeEnv(fallback) ?? fallback ?? null;
};

async function enqueueAndAwait(
  _xln: XLNModule,
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  ready: () => boolean,
  label: string,
  timeoutMs = 30_000,
  describeTimeout?: () => string,
): Promise<void> {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  await dispatchRuntimeInputToRuntimeEnv(runtimeEnv, runtimeInput);
  await waitForCondition(ready, label, timeoutMs, 50, describeTimeout);
}

async function ensureRuntimePipelineAlive(runtime: Runtime | null, xln: XLNModule): Promise<void> {
  if (!runtime?.env) return;
  const resolvedRuntimeId = normalizeRuntimeId(runtime.id);
  if (!resolvedRuntimeId) return;
  const env = unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env;
  registerRuntimeEnvChange(resolvedRuntimeId, env, xln);
  const envRuntimeId = normalizeRuntimeId(env.runtimeId || '');
  if (envRuntimeId !== resolvedRuntimeId) {
    throw new Error(
      `[VaultStore.ensureRuntimePipelineAlive] Runtime isolation mismatch: selected=${resolvedRuntimeId} env.runtimeId=${String(env.runtimeId || 'none')}`,
    );
  }
  ensureRuntimeLoopRunning(env, xln, `pipeline:${resolvedRuntimeId.slice(0, 12)}`);

  let p2p = getRuntimeP2PHandle(xln, env);
  if (!p2p) {
    xln.startP2P(env, {
      signerId: resolvedRuntimeId,
      relayUrls: resolveRelayUrls(),
      gossipPollMs: BROWSER_GOSSIP_POLL_MS,
    });
    p2p = getRuntimeP2PHandle(xln, env);
  } else if (typeof p2p.isConnected === 'function' && !p2p.isConnected()) {
    const waitDeadline = Date.now() + 2_000;
    while (Date.now() < waitDeadline) {
      if (p2p.isConnected() || p2p.isConnecting?.()) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (p2p.isConnected()) {
      // no-op
    } else if (p2p.isConnecting?.()) {
      // Existing P2P bootstrap owns the websocket handshake.
    } else {
      const reconnectState = typeof p2p.getReconnectState === 'function' ? p2p.getReconnectState() : null;
      if (!reconnectState && typeof p2p.connect === 'function') {
        p2p.connect();
      }
    }
  }

  if (p2p && typeof p2p.refreshGossip === 'function') {
    p2p.refreshGossip();
  }
}

async function cleanupRuntimeEnv(runtimeId: string): Promise<void> {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) {
    throw new Error(`RUNTIME_CLEANUP_INVALID_ID:${runtimeId}`);
  }

  try {
    const runtimeEntry = get(runtimes).get(normalizedRuntimeId);
    const env = runtimeEntry?.env;
    const xln = await getXLN();
    const runtimeEnv = env ? (unwrapLiveRuntimeEnv(env) ?? env) : xln.createEmptyEnv(null);
    runtimeEnv.runtimeId = normalizedRuntimeId;
    runtimeEnv.dbNamespace = normalizedRuntimeId;

    if (env) {
      await suspendRuntimeEnvActivity(runtimeEnv, xln);
    }

    const cleanupFailures: unknown[] = [];
    try {
      await xln.clearDB(runtimeEnv);
    } catch (dbErr) {
      cleanupFailures.push(dbErr);
    }
    for (const closeDb of [xln.closeRuntimeDb, xln.closeInfraDb]) {
      if (typeof closeDb !== 'function') continue;
      try {
        await closeDb(runtimeEnv);
      } catch (closeErr) {
        cleanupFailures.push(closeErr);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, `RUNTIME_CLEANUP_STORAGE_FAILED:${normalizedRuntimeId}`);
    }

    unregisterRuntimeEnvChange(normalizedRuntimeId);
    runtimeRecoveryUploadMeta.delete(normalizedRuntimeId);
  } catch (err) {
    errorLog.log(`Failed to cleanup runtime ${runtimeId.slice(0, 12)}`, 'Runtime Cleanup', { runtimeId, error: err });
    throw err;
  }
}

async function stopRuntimeEnv(env: RuntimeReplica): Promise<void> {
  await suspendRuntimeEnvActivity(env);
  const xln = await getXLN();

  if (typeof xln.closeRuntimeDb === 'function') {
    await xln.closeRuntimeDb(env);
  }
  if (typeof xln.closeInfraDb === 'function') {
    await xln.closeInfraDb(env);
  }
}

async function suspendRuntimeEnvActivity(env: RuntimeReplica, loadedXln?: XLNModule): Promise<void> {
  const xln = loadedXln ?? (await getXLN());
  const failures: string[] = [];

  // Fence new P2P/J ingress before draining work that was already accepted.
  // The loop remains alive for the drain, but cannot resurrect a watcher after
  // stopJurisdictionWatchersAndWait has returned.
  if (env.infrastructure) env.infrastructure.persistenceQuiescing = true;

  try {
    await xln.stopJurisdictionWatchersAndWait(env);
  } catch (error) {
    failures.push(`watchers:${error instanceof Error ? error.message : String(error)}`);
  }

  // Scheduled hooks remain durable and resume with the runtime; they are not
  // shutdown work and must not make repeated quiesce calls time out.
  try {
    const drained = await xln.waitForRuntimeWorkDrained(env, 30_000);
    if (!drained) {
      failures.push(`runtime_work:drain_timeout:${JSON.stringify(runtimeQuiesceWorkSummary(env))}`);
    }
  } catch (error) {
    failures.push(
      `runtime_work:${error instanceof Error ? error.message : String(error)}` +
        `:${JSON.stringify(runtimeQuiesceWorkSummary(env))}`,
    );
  }

  if (env.infrastructure) {
    env.infrastructure.persistencePaused = true;
  }

  const idle = await xln.stopRuntimeLoopAndWait(env, 30_000);
  if (!idle) failures.push('runtime_loop:drain_timeout');

  // Keep transport alive until every accepted output has drained. Reliable
  // consensus lanes can emit their final delivery/receipt while the runtime
  // becomes idle; stopping P2P earlier strands that durable output locally.
  try {
    await xln.stopP2PAndWait(env, RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS);
  } catch (error) {
    failures.push(`p2p:${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`RUNTIME_QUIESCE_FAILED:${failures.join('|')}`);
  }
}

async function suspendInactiveRuntimeActivity(activeRuntimeId: string): Promise<void> {
  const normalizedActiveRuntimeId = normalizeRuntimeId(activeRuntimeId);
  if (!normalizedActiveRuntimeId) return;
  const entries = Array.from(get(runtimes).entries());
  await Promise.all(
    entries.map(async ([runtimeId, entry]) => {
      if (normalizeRuntimeId(runtimeId) === normalizedActiveRuntimeId) return;
      if (entry?.type !== 'local' || !entry.env) return;
      const env = unwrapLiveRuntimeEnv(entry.env) ?? entry.env;
      await suspendRuntimeEnvActivity(env);
    }),
  );
}

function unregisterRuntimeEnvChange(runtimeId: string): void {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const unsubscribe = runtimeEnvChangeUnsubscribers.get(normalizedRuntimeId);
  if (unsubscribe) {
    runtimeEnvChangeUnsubscribers.delete(normalizedRuntimeId);
    unsubscribe();
  }
  const recoveryBarrierUnsub = runtimeRecoveryBarrierUnsubscribers.get(normalizedRuntimeId);
  if (recoveryBarrierUnsub) {
    runtimeRecoveryBarrierUnsubscribers.delete(normalizedRuntimeId);
    recoveryBarrierUnsub();
  }
  const uploadTimer = runtimeRecoveryUploadTimers.get(normalizedRuntimeId);
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    runtimeRecoveryUploadTimers.delete(normalizedRuntimeId);
  }
}

function registerRuntimeEnvChange(runtimeId: string, env: RuntimeReplica, xln: XLNModule): void {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId || runtimeEnv.runtimeId);
  if (!normalizedRuntimeId) {
    throw new Error('[VaultStore] Cannot register env change callback without runtimeId');
  }
  unregisterRuntimeEnvChange(normalizedRuntimeId);
  if (typeof xln.registerRuntimePublishedCallback !== 'function') return;
  const recovery = get(runtimesState).runtimes[normalizedRuntimeId]?.recovery;
  if (recovery?.waitForTowerReceipts === true && typeof xln.registerRecoveryBackupBarrier === 'function') {
    runtimeRecoveryBarrierUnsubscribers.set(
      normalizedRuntimeId,
      xln.registerRecoveryBackupBarrier(runtimeEnv, async backupEnv => {
        await uploadRuntimeRecoverySnapshot(normalizedRuntimeId, unwrapLiveRuntimeEnv(backupEnv) ?? backupEnv, xln);
      }),
    );
  }

  const onPublished = (): void => {
    runtimeOperations.updateRuntimeEnv(normalizedRuntimeId, runtimeEnv);
    if (normalizeRuntimeId(get(activeRuntimeId) || '') === normalizedRuntimeId) {
      setXlnEnvironment(runtimeEnv);
    }
    scheduleRuntimeRecoveryUpload(normalizedRuntimeId, runtimeEnv, xln);
  };

  runtimeEnvChangeUnsubscribers.set(
    normalizedRuntimeId,
    xln.registerRuntimePublishedCallback(runtimeEnv, onPublished),
  );
  onPublished();
}

function runtimeToEntry(runtime: Runtime, env: RuntimeReplica) {
  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId) {
    throw new Error(`[VaultStore] Invalid runtime.id: ${String(runtime.id)}`);
  }
  const viewEnv = runtimeOperations.createRuntimeEnvView(env);
  return {
    id: runtimeId,
    type: 'local' as const,
    label: runtime.label,
    env: viewEnv,
    seed: runtime.seed,
    vaultId: runtimeId,
    permissions: 'write' as const,
    status: 'connected' as const,
  };
}

async function registerRuntimeSignerKeys(runtime: Runtime, xln: XLNModule): Promise<void> {
  for (const signer of runtime.signers) {
    const privateKey = derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));
    const privateKeyBytes = new Uint8Array(
      privateKey
        .slice(2)
        .match(/.{2}/g)!
        .map(byte => parseInt(byte, 16)),
    );
    xln.registerSignerKey(runtime.seed, signer.address, privateKeyBytes);
  }
}

function applyRuntimeLogPreference(env: RuntimeReplica): void {
  if (!env) return;
  const verbose = !!get(settings).verboseLogging;
  env.quietRuntimeLogs = !verbose;
}

async function resetRuntimePersistence(runtime: Runtime, xln: XLNModule): Promise<void> {
  const runtimeIdLower = normalizeRuntimeId(runtime.id);
  if (!runtimeIdLower) throw new Error('Invalid runtime id for reset');
  const liveRuntimeEntry = get(runtimes).get(runtimeIdLower);
  if (liveRuntimeEntry?.env) {
    await stopRuntimeEnv(unwrapLiveRuntimeEnv(liveRuntimeEntry.env) ?? liveRuntimeEntry.env);
  }
  runtimes.update(currentRuntimes => {
    const runtimeEntry = currentRuntimes.get(runtimeIdLower);
    if (!runtimeEntry) return currentRuntimes;
    const updated = new Map(currentRuntimes);
    updated.set(runtimeIdLower, {
      ...runtimeEntry,
      env: null,
      status: 'disconnected',
      lastSynced: Date.now(),
    });
    return updated;
  });
  if (normalizeRuntimeId(get(activeRuntimeId) || '') === runtimeIdLower) {
    setXlnEnvironment(null);
    tabOperations.clearAllTabs();
  }
  const resetEnv = xln.createEmptyEnv(runtime.seed);
  applyRuntimeLogPreference(resetEnv);
  resetEnv.runtimeId = runtimeIdLower;
  resetEnv.dbNamespace = runtimeIdLower;
  await xln.clearDB(resetEnv);
  toasts.warning('This runtime storage was reset', 8000);
}

function ensureRuntimeLoopRunning(env: RuntimeReplica, xln: XLNModule, reason: string): void {
  const state = env.infrastructure;
  if (state?.loopActive && !state.persistencePaused && !state.persistenceQuiescing) return;
  xln.resumeRuntimeAfterPersistenceQuiesce(env);
}

async function buildOrRestoreRuntimeEnv(runtime: Runtime, xln: XLNModule, strictRestore = false): Promise<RuntimeReplica> {
  const runtimeIdLower = normalizeRuntimeId(runtime.id);
  if (!runtimeIdLower) {
    throw new Error(`[VaultStore] Invalid runtime.id for env restore: ${String(runtime.id)}`);
  }
  await registerRuntimeSignerKeys(runtime, xln);
  const runtimeSeed = runtime.seed;
  let env: RuntimeReplica | null = null;
  let signerMetadataChanged = false;
  let restoredFromTower = false;

  const persistRuntimeMetadataIfChanged = (): void => {
    if (!signerMetadataChanged) return;
    const currentState = get(runtimesState);
    if (!findRuntimeByIdCaseInsensitive(currentState.runtimes, runtime.id)?.runtime) return;
    runtimesStateBinding.controller.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: runtime,
      },
    }));
    persistRuntimeMetadataSnapshot();
  };

  const restoreFromTower = async (reason: 'missing_local_env' | 'invalid_local_env'): Promise<boolean> => {
    try {
      const towerRestored = await tryRestoreRuntimeEnvFromTower(runtime, xln);
      if (!towerRestored) return false;
      env = towerRestored.env;
      restoredFromTower = true;
      signerMetadataChanged = true;
      errorLog.log(`Restored runtime ${runtime.id.slice(0, 12)} from tower after ${reason}`, 'Runtime Restore', {
        runtimeId: runtime.id,
        reason,
      });
      return true;
    } catch (error) {
      if (strictRestore) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[VaultStore] Tower restore failed for ${runtime.id.slice(0, 12)}: ${message}`);
      }
      errorLog.log('Failed to restore env from tower; continuing with local recovery path', 'Runtime Restore', {
        runtimeId: runtime.id,
        reason,
        error,
      });
      return false;
    }
  };

  for (const signer of runtime.signers || []) {
    if (!signer?.address) continue;
    const canonicalEntityId = String(xln.generateLazyEntityId([signer.address], 1n)).toLowerCase();
    if (normalizeEntityId(signer.entityId) === canonicalEntityId) continue;
    signer.entityId = canonicalEntityId;
    signerMetadataChanged = true;
    errorLog.log(
      `[VaultStore] Canonical signer/entity mismatch detected for ${signer.address.slice(0, 10)}; forcing lazy entity ${canonicalEntityId.slice(0, 12)} without deleting persisted runtime`,
      'Runtime Restore',
      { runtimeId: runtime.id, signerAddress: signer.address, canonicalEntityId },
    );
  }

  try {
    if (xln.loadEnvFromDB) {
      env = await xln.loadEnvFromDB(runtimeIdLower, runtimeSeed);
    }
  } catch (error) {
    if (parseStorageSchemaMismatch(error)) {
      schemaMismatchRecoveryRuntimeIds.add(runtimeIdLower);
    }
    // A thrown durable-read error means storage exists but cannot be trusted.
    // Treating it like "no local data" would silently replace financial state
    // with a fresh Runtime. Missing storage is already represented by `null`;
    // corruption, schema mismatch, and I/O failure must stop initialization.
    const message = error instanceof Error ? error.message : String(error);
    errorLog.log(
      `Runtime restore failed for ${runtime.id.slice(0, 12)}; refusing to replace persisted state`,
      'Runtime Restore',
      { runtimeId: runtime.id, strictRestore, error },
    );
    throw new Error(`[VaultStore] Runtime restore failed for ${runtime.id.slice(0, 12)}: ${message}`, {
      cause: error,
    });
  }

  if (!env) {
    await restoreFromTower('missing_local_env');
  }

  persistRuntimeMetadataIfChanged();

  if (!env && strictRestore) {
    throw new Error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: persisted env missing`);
  }

  if (env && (!env.state.jReplicas || env.state.jReplicas.size === 0)) {
    if (strictRestore && !restoredFromTower) {
      throw new Error(
        `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: restored env missing jReplicas`,
      );
    }
    errorLog.log('Restored env missing J-replicas; retrying tower restore before local re-import', 'Runtime Restore', {
      runtimeId: runtime.id,
    });
    env = null;
    if (!restoredFromTower) {
      await restoreFromTower('invalid_local_env');
      persistRuntimeMetadataIfChanged();
    }
  }

  const hasLiveJAdapter = (targetEnv: RuntimeReplica | null): boolean => {
    if (!targetEnv?.state.jReplicas || targetEnv.state.jReplicas.size === 0) return false;
    for (const [name] of targetEnv.state.jReplicas.entries()) {
      if (hasConnectedJurisdictionAdapter(targetEnv, name)) return true;
    }
    return false;
  };

  const hasEntityReplica = (targetEntityId: string): boolean => {
    if (!env?.state.eReplicas) return false;
    const target = String(targetEntityId).toLowerCase();
    for (const key of env.state.eReplicas.keys()) {
      const [entityId] = String(key).split(':');
      if (String(entityId || '').toLowerCase() === target) return true;
    }
    return false;
  };

  if (env && strictRestore && !restoredFromTower) {
    for (const signer of runtime.signers || []) {
      if (!signer?.entityId) continue;
      if (!hasEntityReplica(signer.entityId)) {
        const restoredEntityKeys = env.state.eReplicas ? Array.from(env.state.eReplicas.keys()).map(key => String(key)) : [];
        errorLog.log(
          `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: missing restored entity ${signer.entityId.slice(0, 12)}`,
          'Runtime Restore',
          {
            runtimeId: runtime.id,
            signerEntityId: signer.entityId,
            restoredEntityKeys,
            replayMeta: getReplayMeta(env),
          },
        );
        throw new Error(
          `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: missing restored entity ${signer.entityId.slice(0, 12)}`,
        );
      }
    }
  }

  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
  const jurisdictions = await fetchJurisdictions(baseOrigin);
  const primaryConfig = resolveJurisdictionConfig(jurisdictions);
  const primaryBlockTimeMs = requireJurisdictionBlockTimeMs(primaryConfig.blockTimeMs, 'VaultStore.restore.primary');
  const defaultJurisdictionImports = listDefaultJurisdictionImports(jurisdictions);
  const primaryJurisdictionName =
    defaultJurisdictionImports[0]?.name || String(primaryConfig.name || 'primary').trim() || 'primary';
  const rpcUrl = resolveRpcUrl(resolveJurisdictionRpc(primaryConfig), baseOrigin);
  const chainId = resolveJurisdictionChainId(primaryConfig, 'VaultStore.restore');

  if (!env) {
    env = xln.createEmptyEnv(runtimeSeed);
    applyRuntimeLogPreference(env);
    env.runtimeId = runtimeIdLower;
    env.dbNamespace = runtimeIdLower;
    ensureRuntimeLoopRunning(env, xln, `fresh-env:${runtimeIdLower.slice(0, 12)}`);
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [
          {
            type: 'importJ',
            data: {
              name: primaryJurisdictionName,
              chainId,
              ticker: 'USDC',
              rpcs: [rpcUrl],
              entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
                primaryConfig.entityProviderDeploymentBlock,
                'VaultStore.restore.importJ',
              ),
              blockTimeMs: primaryBlockTimeMs,
              contracts: primaryConfig.contracts,
            },
          },
        ],
        entityInputs: [],
      },
      () => hasRuntimeJurisdictionAddresses(findJReplicaByName(env!, primaryJurisdictionName)),
      `importJ(${primaryJurisdictionName})`,
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(findJReplicaByName(env!, primaryJurisdictionName)),
      `importJ(${primaryJurisdictionName}).addresses`,
      45_000,
    );
  } else {
    applyRuntimeLogPreference(env);
    env.runtimeSeed = runtimeSeed;
    env.runtimeId = runtimeIdLower;
    env.dbNamespace = runtimeIdLower;
    for (const [name, jReplica] of env.state.jReplicas.entries()) {
      if (!hasRuntimeJurisdictionAddresses(jReplica)) {
        throw new Error(`RUNTIME_RESTORE_JURISDICTION_CONTRACTS_INCOMPLETE:${name}`);
      }
    }
  }

  if (!hasLiveJAdapter(env)) {
    ensureRuntimeLoopRunning(env, xln, `repair-import-j:${runtimeIdLower.slice(0, 12)}`);
    const logKey = `${runtimeIdLower}:${primaryJurisdictionName}:${chainId}`;
    if (!loggedLiveJAdapterReimports.has(logKey)) {
      loggedLiveJAdapterReimports.add(logKey);
      errorLog.log(
        `Restored env has no live J-adapter; re-importing ${primaryJurisdictionName} jurisdiction`,
        'Runtime Restore',
        { runtimeId: runtime.id, jurisdiction: primaryJurisdictionName, chainId },
      );
    }
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [
          {
            type: 'importJ',
            data: {
              name: primaryJurisdictionName,
              chainId,
              ticker: 'USDC',
              rpcs: [rpcUrl],
              entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
                primaryConfig.entityProviderDeploymentBlock,
                'VaultStore.restore.repairImportJ',
              ),
              blockTimeMs: primaryBlockTimeMs,
              contracts: primaryConfig.contracts,
            },
          },
        ],
        entityInputs: [],
      },
      () => hasRuntimeJurisdictionAddresses(findJReplicaByName(env!, primaryJurisdictionName)),
      `repairImportJ(${primaryJurisdictionName})`,
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(findJReplicaByName(env!, primaryJurisdictionName)),
      `repairImportJ(${primaryJurisdictionName}).addresses`,
      45_000,
    );
  }

  ensureRuntimeLoopRunning(env, xln, `post-restore:${runtimeIdLower.slice(0, 12)}`);

  for (const signer of runtime.signers || []) {
    const entityId = normalizeEntityId(signer?.entityId);
    const signerAddress = normalizeRuntimeId(signer?.address);
    if (!entityId || !signerAddress) continue;

    const preferredJurisdictionName = String(signer.jurisdiction || primaryJurisdictionName).trim();
    const jReplica = findJReplicaByName(env, preferredJurisdictionName);
    if (!jReplica) {
      const message = `[VaultStore] Missing signer jurisdiction ${preferredJurisdictionName} for entity ${entityId.slice(0, 12)}`;
      if (normalizeJurisdictionKey(preferredJurisdictionName) === normalizeJurisdictionKey(primaryJurisdictionName)) {
        throw new Error(message);
      }
      errorLog.log(`${message}; waiting for jurisdiction import`, 'Runtime Restore', {
        runtimeId: runtime.id,
        entityId,
        preferredJurisdictionName,
      });
      continue;
    }

    const targetJurisdictionName = getJReplicaJurisdictionName(jReplica, preferredJurisdictionName);
    const targetJurisdictionKey = normalizeJurisdictionKey(targetJurisdictionName);
    const exactReplica = findEntityReplicaByEntityAndSigner(env, entityId, signerAddress);
    const anyEntityReplica = exactReplica || findEntityReplicaByEntityId(env, entityId);
    const existingJurisdictionName = getEntityReplicaJurisdictionName(anyEntityReplica);
    if (existingJurisdictionName && normalizeJurisdictionKey(existingJurisdictionName) !== targetJurisdictionKey) {
      throw new Error(
        `ENTITY_JURISDICTION_CONFLICT: entity=${entityId} existing=${existingJurisdictionName} incoming=${targetJurisdictionName}`,
      );
    }

    if (
      exactReplica &&
      normalizeJurisdictionKey(getEntityReplicaJurisdictionName(exactReplica)) === targetJurisdictionKey
    ) {
      continue;
    }

    if (strictRestore && !anyEntityReplica) {
      throw new Error(
        `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: entity missing after restore ${entityId.slice(0, 12)}`,
      );
    }

    const entityConfig = buildSignerEntityConfig(signerAddress, jReplica, preferredJurisdictionName, chainId);
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [
          {
            type: 'importReplica',
            entityId,
            signerId: signerAddress,
            data: {
              isProposer: true,
              config: entityConfig,
              profileName: runtime.label,
            },
          },
        ],
        entityInputs: [],
      },
      () => {
        const repaired = findEntityReplicaByEntityAndSigner(env!, entityId, signerAddress);
        return normalizeJurisdictionKey(getEntityReplicaJurisdictionName(repaired)) === targetJurisdictionKey;
      },
      `importReplica(${entityId.slice(0, 12)}@${targetJurisdictionName})`,
    );
  }

  if (xln.startP2P) {
    xln.startP2P(env, {
      signerId: runtimeIdLower,
      relayUrls: resolveRelayUrls(),
      gossipPollMs: BROWSER_GOSSIP_POLL_MS,
    });
  }

  schemaMismatchRecoveryRuntimeIds.delete(runtimeIdLower);
  return env;
}

function registerRuntimeResumeListener(): void {
  if (resumeListenerRegistered || typeof window === 'undefined' || typeof document === 'undefined') return;
  const triggerRefresh = () => {
    if (isInactiveTabStandby()) return;
    if (document.visibilityState !== 'visible') return;
    void vaultOperations.refreshActiveRuntimeFromDbIfBehind().catch(error => {
      errorLog.log('Resume refresh failed', 'Runtime Resume', error);
    });
  };
  runtimeResumeTrigger = triggerRefresh;
  document.addEventListener('visibilitychange', triggerRefresh);
  window.addEventListener('focus', triggerRefresh);
  if (typeof BroadcastChannel !== 'undefined') {
    runtimeSyncChannel = new BroadcastChannel('xln-runtime-sync');
    runtimeSyncChannel.onmessage = (event: MessageEvent<{ runtimeId?: string; height?: number }>) => {
      if (isInactiveTabStandby()) return;
      const runtimeId = normalizeRuntimeId(event.data?.runtimeId);
      const height = Number(event.data?.height ?? 0);
      if (!runtimeId || !Number.isFinite(height) || height <= 0) return;
      const runtimeEntry = get(runtimes).get(runtimeId);
      const currentHeight = Number(runtimeEntry?.env?.state.height ?? 0);
      if (height <= currentHeight) return;
      void vaultOperations.refreshActiveRuntimeFromDbIfBehind().catch(error => {
        errorLog.log('Broadcast refresh failed', 'Runtime Resume', { runtimeId, height, currentHeight, error });
      });
    };
  }
  resumeListenerRegistered = true;
}

export function shutdownRuntimeResumeListener(): void {
  if (typeof window !== 'undefined' && runtimeResumeTrigger) {
    window.removeEventListener('focus', runtimeResumeTrigger);
  }
  if (typeof document !== 'undefined' && runtimeResumeTrigger) {
    document.removeEventListener('visibilitychange', runtimeResumeTrigger);
  }
  runtimeResumeTrigger = null;
  runtimeSyncChannel?.close();
  runtimeSyncChannel = null;
  resumeListenerRegistered = false;
}

// Runtime operations
export const vaultOperations = {
  beginRuntimePageUnload(): void {
    shutdownRuntimeResumeListener();
    const localEnvs = Array.from(get(runtimes).values())
      .filter(entry => entry.type === 'local' && entry.env)
      .map(entry => unwrapLiveRuntimeEnv(entry.env) ?? entry.env)
      .filter((env): env is RuntimeReplica => Boolean(env));
    if (localEnvs.length === 0) return;

    const xln = get(xlnInstance);
    if (!xln) throw new Error('RUNTIME_PAGE_UNLOAD_XLN_NOT_LOADED');

    const failures: Error[] = [];
    for (const env of localEnvs) {
      try {
        xln.stopJurisdictionWatchers(env);
      } catch (error) {
        failures.push(new Error('RUNTIME_PAGE_UNLOAD_WATCHER_STOP_FAILED', { cause: error }));
      }
      try {
        xln.stopP2P(env);
      } catch (error) {
        failures.push(new Error('RUNTIME_PAGE_UNLOAD_P2P_STOP_FAILED', { cause: error }));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'RUNTIME_PAGE_UNLOAD_INGRESS_FENCE_FAILED');
    }
  },

  async suspendAllRuntimeActivity(): Promise<void> {
    shutdownRuntimeResumeListener();
    const entries = Array.from(get(runtimes).entries());
    await Promise.all(
      entries.map(async ([runtimeId, entry]) => {
        if (!entry?.env) {
          unregisterRuntimeEnvChange(runtimeId);
          return;
        }
        try {
          await stopRuntimeEnv(unwrapLiveRuntimeEnv(entry.env) ?? entry.env);
          // Keep the recovery barrier installed while accepted ingress drains.
          // That drain may commit an Account frame and emit its ACK; removing the
          // barrier first would let the peer advance past the latest tower backup.
          unregisterRuntimeEnvChange(runtimeId);
          await drainRuntimeRecoveryUploads(normalizeRuntimeId(runtimeId));
        } catch (error) {
          throw new Error(
            `RUNTIME_QUIESCE_ENTRY_FAILED:${normalizeRuntimeId(runtimeId)}:${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
    );
  },

  async refreshActiveRuntimeFromDbIfBehind(): Promise<boolean> {
    if (resumeRefreshPromise) return resumeRefreshPromise;
    resumeRefreshPromise = (async () => {
      const currentState = get(runtimesState);
      const runtimeId = normalizeRuntimeId(currentState.activeRuntimeId);
      if (!runtimeId) return false;

      const runtime = currentState.runtimes[runtimeId];
      const runtimeEntry = get(runtimes).get(runtimeId);
      const entryEnv = runtimeEntry?.env as RuntimeReplica | undefined;
      const env = unwrapLiveRuntimeEnv(entryEnv) ?? entryEnv;
      if (!runtime || !env) return false;

      const xln = await getXLN();
      if (typeof xln.getPersistedLatestHeight !== 'function') return false;

      const persistedLatestHeight = Number((await xln.getPersistedLatestHeight(env)) || 0);
      const currentHeight = Number(env.state.height || 0);
      if (persistedLatestHeight <= currentHeight) return false;

      await registerRuntimeSignerKeys(runtime, xln);
      const refreshedEnv = await buildOrRestoreRuntimeEnv(runtime, xln, true);
      unregisterRuntimeEnvChange(runtimeId);
      await stopRuntimeEnv(env);

      runtimes.update(currentRuntimes => {
        const updated = new Map(currentRuntimes);
        updated.set(runtimeId, runtimeToEntry(runtime, refreshedEnv));
        return updated;
      });
      registerRuntimeEnvChange(runtimeId, refreshedEnv, xln);

      return true;
    })();

    try {
      return await resumeRefreshPromise;
    } finally {
      resumeRefreshPromise = null;
    }
  },

  async importJMachine(config: ImportedJMachineConfig): Promise<ImportedJMachineConfig> {
    const runtimeId = normalizeRuntimeId(get(activeRuntimeId));
    if (!runtimeId) throw new Error('No active runtime selected');

    const state = get(runtimesState);
    const runtime = state.runtimes[runtimeId];
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);

    const xln = await getXLN();
    await registerRuntimeSignerKeys(runtime, xln);

    let env = get(runtimes).get(runtimeId)?.env as RuntimeReplica | undefined;
    if (!env) {
      env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
      runtimes.update(currentRuntimes => {
        const updated = new Map(currentRuntimes);
        updated.set(runtimeId, runtimeToEntry(runtime, env!));
        return updated;
      });
      registerRuntimeEnvChange(runtimeId, env, xln);
    }
    const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
    const getLatestEnv = (): RuntimeReplica => {
      const latest = getLiveRuntimeEnvForId(runtimeId, runtimeEnv);
      if (!latest) throw new Error(`Runtime env not found: ${runtimeId}`);
      return latest;
    };

    const existing = findJReplicaByName(getLatestEnv(), config.name);
    if (existing && hasConnectedJurisdictionAdapter(getLatestEnv(), existing.name)) {
      return {
        ...config,
        ...(existing.entityProviderDeploymentBlock !== undefined
          ? { entityProviderDeploymentBlock: existing.entityProviderDeploymentBlock }
          : {}),
        contracts: {
          depository: String(
            existing?.depositoryAddress || existing?.contracts?.depository || config.contracts?.depository || '',
          ),
          entityProvider: String(
            existing?.entityProviderAddress ||
              existing?.contracts?.entityProvider ||
              config.contracts?.entityProvider ||
              '',
          ),
          account: String(existing?.contracts?.account || config.contracts?.account || ''),
          deltaTransformer: String(existing?.contracts?.deltaTransformer || config.contracts?.deltaTransformer || ''),
        },
      };
    }
    if (existing) {
      errorLog.log(`J-machine "${config.name}" exists without a live adapter; re-importing`, 'J-Machine Import', {
        runtimeId,
        jurisdiction: config.name,
      });
    }

    ensureRuntimeLoopRunning(runtimeEnv, xln, `import-jmachine:${config.name}`);
    await enqueueAndAwait(
      xln,
      runtimeEnv,
      {
        runtimeTxs: [
          {
            type: 'importJ',
            data: {
              name: config.name,
              chainId: config.chainId,
              ticker: config.ticker,
              rpcs: config.mode === 'browservm' ? [] : config.rpcs,
              ...(config.mode === 'rpc'
                ? {
                    entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
                      config.entityProviderDeploymentBlock,
                      'VaultStore.importJMachine',
                    ),
                  }
                : {}),
              blockTimeMs: config.blockTimeMs,
              ...(config.contracts ? { contracts: config.contracts } : {}),
            },
          },
        ],
        entityInputs: [],
      },
      () => {
        const latestEnv = getLatestEnv();
        if (latestEnv.infrastructure?.loopActive === false) {
          throw new Error(
            `importJ(${config.name}) failed: runtime loop halted\n${getRuntimeFatalDiagnostics(latestEnv, config.name)}`,
          );
        }
        return hasRuntimeJurisdictionAddresses(latestEnv.state.jReplicas?.get?.(config.name));
      },
      `importJ(${config.name})`,
      45_000,
      () => getRuntimeFatalDiagnostics(getLatestEnv(), config.name),
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(getLatestEnv().state.jReplicas?.get?.(config.name)),
      `importJ(${config.name}).addresses`,
      45_000,
      50,
      () => getRuntimeFatalDiagnostics(getLatestEnv(), config.name),
    );

    const finalEnv = getLatestEnv();
    runtimes.update(currentRuntimes => {
      const updated = new Map(currentRuntimes);
      updated.set(runtimeId, runtimeToEntry(runtime, finalEnv));
      return updated;
    });
    if (normalizeRuntimeId(get(activeRuntimeId)) === runtimeId) {
      setXlnEnvironment(finalEnv);
    }
    const imported = finalEnv.state.jReplicas?.get(config.name);
    return {
      ...config,
      ...(imported?.entityProviderDeploymentBlock !== undefined
        ? { entityProviderDeploymentBlock: imported.entityProviderDeploymentBlock }
        : {}),
      contracts: {
        depository: String(
          imported?.depositoryAddress || imported?.contracts?.depository || config.contracts?.depository || '',
        ),
        entityProvider: String(
          imported?.entityProviderAddress ||
            imported?.contracts?.entityProvider ||
            config.contracts?.entityProvider ||
            '',
        ),
        account: String(imported?.contracts?.account || config.contracts?.account || ''),
        deltaTransformer: String(imported?.contracts?.deltaTransformer || config.contracts?.deltaTransformer || ''),
      },
    };
  },

  async getPersistedLatestHeight(env: RuntimeReplica): Promise<number> {
    const xln = await getXLN();
    return xln.getPersistedLatestHeight(unwrapLiveRuntimeEnv(env) ?? env);
  },

  async listPersistedCheckpointHeights(env: RuntimeReplica): Promise<number[]> {
    const xln = await getXLN();
    return xln.listPersistedCheckpointHeights(unwrapLiveRuntimeEnv(env) ?? env);
  },

  async verifyRuntimeChain(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: { fromSnapshotHeight?: number },
  ) {
    const xln = await getXLN();
    return xln.verifyRuntimeChain(runtimeId, runtimeSeed, options);
  },

  async signRuntimeOwnerMessage(runtimeId: string | null | undefined, message: string): Promise<string> {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId || get(activeRuntimeId));
    if (!normalizedRuntimeId) throw new Error('No active runtime selected');
    const runtime = get(runtimesState).runtimes[normalizedRuntimeId];
    if (!runtime?.seed) throw new Error(`Runtime seed unavailable: ${normalizedRuntimeId}`);
    const wallet = new Wallet(derivePrivateKey(runtime.seed, 0));
    if (normalizeRuntimeId(wallet.address) !== normalizedRuntimeId) {
      throw new Error(`RUNTIME_OWNER_KEY_MISMATCH:${normalizedRuntimeId}:${wallet.address.toLowerCase()}`);
    }
    return wallet.signMessage(message);
  },

  async readPersistedFrameJournal(env: RuntimeReplica, height: number): Promise<PersistedFrameJournal | null> {
    const xln = await getXLN();
    return xln.readPersistedFrameJournal(unwrapLiveRuntimeEnv(env) ?? env, height);
  },

  async updateRuntimeRecovery(runtimeId: string | null | undefined, recovery: RuntimeRecoveryConfig): Promise<Runtime> {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId || get(activeRuntimeId));
    if (!normalizedRuntimeId) throw new Error('No active runtime selected');

    let updatedRuntime: Runtime | null = null;
    runtimesStateBinding.controller.update(state => {
      const runtime = state.runtimes[normalizedRuntimeId];
      if (!runtime) throw new Error(`Runtime not found: ${normalizedRuntimeId}`);
      updatedRuntime = {
        ...runtime,
        recovery: {
          ...recovery,
          towers: normalizeRecoveryTowerConfigs(recovery.towers),
          useDefaultTowers: recovery.useDefaultTowers === true,
        },
      };
      return {
        ...state,
        runtimes: {
          ...state.runtimes,
          [normalizedRuntimeId]: updatedRuntime,
        },
      };
    });

    if (!updatedRuntime) throw new Error(`Runtime not found: ${normalizedRuntimeId}`);
    this.saveToStorage();

    const runtimeEntry = get(runtimes).get(normalizedRuntimeId);
    const entryEnv = runtimeEntry?.env || null;
    if (entryEnv) {
      runtimes.update(currentRuntimes => {
        const updated = new Map(currentRuntimes);
        updated.set(normalizedRuntimeId, runtimeToEntry(updatedRuntime!, entryEnv));
        return updated;
      });
      const xln = await getXLN();
      scheduleRuntimeRecoveryUpload(normalizedRuntimeId, unwrapLiveRuntimeEnv(entryEnv) ?? entryEnv, xln);
    }

    return updatedRuntime;
  },

  async restoreRuntimeFromRecoveryCandidate(
    runtimeId: string | null | undefined,
    candidate: RuntimeRecoveryCandidate,
  ): Promise<Runtime> {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId || get(activeRuntimeId));
    if (!normalizedRuntimeId) throw new Error('No active runtime selected');
    const currentState = get(runtimesState);
    const runtime = currentState.runtimes[normalizedRuntimeId];
    if (!runtime) throw new Error(`Runtime not found: ${normalizedRuntimeId}`);

    const xln = await getXLN();
    const restored = await restoreRuntimeEnvFromRecoveryCandidate(runtime, xln, candidate);
    const restoredEnv = restored.env;
    const updatedRuntime = { ...runtime };

    runtimesStateBinding.controller.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [normalizedRuntimeId]: updatedRuntime,
      },
      activeRuntimeId: normalizedRuntimeId,
    }));
    this.saveToStorage();

    runtimes.update(currentRuntimes => {
      const updated = new Map(currentRuntimes);
      updated.set(normalizedRuntimeId, runtimeToEntry(updatedRuntime, restoredEnv));
      return updated;
    });
    runtimeOperations.setActiveRuntimeId(normalizedRuntimeId);
    registerRuntimeEnvChange(normalizedRuntimeId, restoredEnv, xln);
    setXlnEnvironment(restoredEnv);
    this.syncRuntime({ ...updatedRuntime, env: restoredEnv });
    toasts.info('Runtime restored from encrypted backup', 6_000);
    return updatedRuntime;
  },

  async recoverSchemaMismatchedRuntimesFromConfiguredBackups(): Promise<number> {
    const runtimeIds = Array.from(schemaMismatchRecoveryRuntimeIds).sort();
    if (runtimeIds.length === 0) {
      throw new Error('STORAGE_SCHEMA_RECOVERY_NOT_PENDING');
    }

    const xln = await getXLN();
    const state = get(runtimesState);
    const plans: Array<{ runtimeId: string; candidate: RuntimeRecoveryCandidate }> = [];
    for (const runtimeId of runtimeIds) {
      const runtime = state.runtimes[runtimeId];
      if (!runtime) throw new Error(`STORAGE_SCHEMA_RECOVERY_RUNTIME_MISSING:${runtimeId}`);
      if (!runtime.seed) throw new Error(`STORAGE_SCHEMA_RECOVERY_VAULT_LOCKED:${runtimeId}`);
      const discovery = await discoverRuntimeRecoveryCandidates(runtime.seed, {
        ...(runtime.recovery ? { recovery: runtime.recovery } : {}),
        xln,
      });
      const candidate = discovery.candidates[0];
      if (!candidate) {
        const detail = discovery.errors.slice(0, 3).join('|') || 'no_authenticated_backup';
        throw new Error(`STORAGE_SCHEMA_RECOVERY_BACKUP_NOT_FOUND:${runtimeId}:${detail}`);
      }
      plans.push({ runtimeId, candidate });
    }

    // Discovery/decryption completes for every affected runtime before the
    // first durable byte is replaced. The runtime verifier authenticates each
    // bundle before persistRestoredEnvToDB publishes the new schema-2 head.
    for (const plan of plans) {
      await this.restoreRuntimeFromRecoveryCandidate(plan.runtimeId, plan.candidate);
      schemaMismatchRecoveryRuntimeIds.delete(plan.runtimeId);
    }
    return plans.length;
  },

  syncRuntime(runtime: Runtime | null) {
    const meta: { label?: string; seed?: string; vaultId?: string } = {};
    meta.label = runtime?.label || 'Runtime';
    if (runtime?.seed) meta.seed = runtime.seed;
    if (runtime?.id) meta.vaultId = runtime.id;

    runtimeOperations.setLocalRuntimeMetadata(meta);
    if (runtime?.env) {
      setXlnEnvironment(unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env);
    }
    // P2P is started per-env in createRuntime() and initialize() — no need to restart here
    // Restarting on every selectRuntime caused WS connection leak (15+ connections with 4 runtimes)
  },

  // Load from localStorage
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const saved = localStorage.getItem(VAULT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const normalizedRuntimes: Record<string, Runtime> = {};
        for (const [rawKey, rawRuntime] of Object.entries(parsed?.runtimes || {})) {
          const runtime = rawRuntime as Runtime;
          const normalizedId = normalizeRuntimeId(runtime?.id || rawKey);
          if (!normalizedId) continue;
          normalizedRuntimes[normalizedId] = {
            ...runtime,
            id: normalizedId,
            seed: typeof runtime.seed === 'string' ? runtime.seed : '',
          };
        }
        const normalizedActiveId = normalizeRuntimeId(parsed?.activeRuntimeId || '');
        runtimesStateBinding.controller.set({
          runtimes: normalizedRuntimes,
          activeRuntimeId:
            normalizedActiveId && normalizedRuntimes[normalizedActiveId]
              ? normalizedActiveId
              : Object.keys(normalizedRuntimes)[0] || null,
        });
      }
      vaultStorageLoadedBinding.controller.set(true);
    } catch (error) {
      errorLog.log('Failed to load runtimes; clearing corrupted storage', 'Runtime Storage', error);
      localStorage.removeItem(VAULT_STORAGE_KEY);
      runtimesStateBinding.controller.set(defaultState);
      vaultStorageLoadedBinding.controller.set(true);
    }
  },

  // Save to localStorage
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const current = get(runtimesState);
      localStorage.setItem(VAULT_STORAGE_KEY, serializeVaultState(current));
    } catch (error) {
      errorLog.log('Failed to save runtimes', 'Runtime Storage', error);
    }
  },

  // Create new runtime from seed
  async createRuntime(name: string, seed: string, options: CreateRuntimeOptions = {}): Promise<Runtime> {
    registerRuntimeResumeListener();
    const markPerf = (_step: string): void => {};
    const flushPerf = (_status: 'ok' | 'existing'): void => {};

    // Derive first signer (index 0)
    const firstAddress = deriveAddress(seed, 0);
    markPerf('derive_first_address');

    // Use signer EOA as ID (deterministic, unique)
    const id = normalizeRuntimeId(firstAddress);
    if (!id) throw new Error('Invalid runtimeId derived from seed');
    const label = name;

    // Single-runtime invariant per signer EOA.
    // Creating a second runtime with the same id causes local/server chain divergence
    // (same entity ids, different local genesis) and leads to pending/mismatch loops.
    const currentState = get(runtimesState);
    const existing = findRuntimeByIdCaseInsensitive(currentState.runtimes, id);
    if (existing) {
      if (existing.runtime.seed !== seed) {
        throw new Error(`Runtime id collision for ${id}: existing runtime has different seed`);
      }
      await this.selectRuntime(existing.key);
      markPerf('select_existing_runtime');
      flushPerf('existing');
      return existing.runtime;
    }

    const priorCreation = runtimeCreationInFlight.get(id);
    if (priorCreation) {
      markPerf('await_existing_creation');
      await priorCreation.catch(() => undefined);
      const postCreateState = get(runtimesState);
      const created = findRuntimeByIdCaseInsensitive(postCreateState.runtimes, id);
      if (created) {
        if (created.runtime.seed !== seed) {
          throw new Error(`Runtime id collision for ${id}: existing runtime has different seed`);
        }
        await this.selectRuntime(created.key);
        flushPerf('existing');
        return created.runtime;
      }
    }

    let releaseRuntimeCreation!: () => void;
    const runtimeCreationBarrier = new Promise<void>(resolve => {
      releaseRuntimeCreation = resolve;
    });
    runtimeCreationInFlight.set(id, runtimeCreationBarrier);
    const finishRuntimeCreation = (): void => {
      if (runtimeCreationInFlight.get(id) === runtimeCreationBarrier) {
        runtimeCreationInFlight.delete(id);
      }
      releaseRuntimeCreation();
    };

    const loginType = options.loginType === 'demo' ? 'demo' : 'manual';
    const requiresOnboarding =
      typeof options.requiresOnboarding === 'boolean' ? options.requiresOnboarding : loginType !== 'demo';

    let runtime: Runtime = {
      id,
      label,
      seed,
      ...(options.mnemonic12 ? { mnemonic12: options.mnemonic12 } : {}),
      ...(options.devicePassphrase ? { devicePassphrase: options.devicePassphrase } : {}),
      signers: [
        {
          index: 0,
          address: firstAddress,
          name: 'Signer 1',
        },
      ],
      activeSignerIndex: 0,
      loginType,
      requiresOnboarding,
      recovery:
        options.recovery ||
        (options.skipRecoveryRestore ? { useDefaultTowers: false, towers: [] } : buildDefaultRuntimeRecoveryConfig()),
      createdAt: Date.now(),
    };
    const previousActiveRuntimeId = currentState.activeRuntimeId;

    // CRITICAL: Create NEW isolated runtime for this runtime (AWAIT to avoid race)
    const runtimeId = normalizeRuntimeId(id); // Use normalized runtime ID key

    // Import XLN and create env BEFORE returning
    let xln: XLNModule | null = null;
    let newEnv: RuntimeReplica | null = null;

    try {
      xln = await getXLN();
      markPerf('load_xln_runtime');
      const runtimeIdLower = runtimeId.toLowerCase();

      if (options.recoveryCandidate) {
        const restored = await restoreRuntimeEnvFromRecoveryCandidate(runtime, xln, options.recoveryCandidate);
        newEnv = restored.env;
        applyRuntimeLogPreference(newEnv);
        newEnv.runtimeSeed = seed;
        newEnv.runtimeId = runtimeIdLower;
        newEnv.dbNamespace = runtimeIdLower;
        await registerRuntimeSignerKeys(runtime, xln);
        ensureRuntimeLoopRunning(newEnv, xln, `recovery:${runtimeIdLower.slice(0, 12)}`);
        markPerf('restore_runtime_from_recovery_candidate');
        toasts.info('Runtime restored from recovery backup', 6_000);
      } else {
        newEnv = xln.createEmptyEnv(seed);
        applyRuntimeLogPreference(newEnv);
        newEnv.runtimeId = runtimeIdLower;
        newEnv.dbNamespace = runtimeIdLower;
        runtimes.update(r => {
          const updated = new Map(r);
          updated.set(runtimeId, runtimeToEntry(runtime, newEnv!));
          return updated;
        });
        runtimeOperations.setActiveRuntimeId(runtimeId);
        await suspendInactiveRuntimeActivity(runtimeId);
        ensureRuntimeLoopRunning(newEnv, xln, `create-runtime:${runtimeIdLower.slice(0, 12)}`);
        markPerf('prepare_runtime_before_bootstrap');

        // Fetch pre-deployed contract addresses from prod
        const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
        markPerf('wait_server_runtime_ready');
        const jurisdictions = await fetchJurisdictions(baseOrigin);
        markPerf('fetch_jurisdictions');
        const primaryConfig = resolveJurisdictionConfig(jurisdictions);
        const primaryBlockTimeMs = requireJurisdictionBlockTimeMs(
          primaryConfig.blockTimeMs,
          'VaultStore.createRuntime.primary',
        );
        const defaultJurisdictionImports = listDefaultJurisdictionImports(jurisdictions);
        const primaryJurisdictionName =
          defaultJurisdictionImports[0]?.name || String(primaryConfig.name || 'primary').trim() || 'primary';
        const secondaryJurisdictionImports = defaultJurisdictionImports.slice(1);
        const rpcUrl = resolveRpcUrl(resolveJurisdictionRpc(primaryConfig), baseOrigin);
        const chainId = resolveJurisdictionChainId(primaryConfig, 'VaultStore.createRuntime');

        // Import the same primary jurisdiction name that hub profiles advertise.
        await enqueueAndAwait(
          xln,
          newEnv,
          {
            runtimeTxs: [
              {
                type: 'importJ',
                data: {
                  name: primaryJurisdictionName,
                  chainId,
                  ticker: 'USDC',
                  rpcs: [rpcUrl],
                  entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
                    primaryConfig.entityProviderDeploymentBlock,
                    'VaultStore.createRuntime.primary',
                  ),
                  blockTimeMs: primaryBlockTimeMs,
                  contracts: primaryConfig.contracts,
                  startAtCurrentBlock: false,
                },
              },
            ],
            entityInputs: [],
          },
          () => {
            const replica = findJReplicaByName(newEnv!, primaryJurisdictionName);
            if (hasRuntimeJurisdictionAddresses(replica)) return true;
            if (newEnv?.infrastructure?.loopActive === false) {
              throw new Error(
                `createRuntime.importJ(${primaryJurisdictionName}) failed: runtime loop halted\n${getRuntimeFatalDiagnostics(newEnv)}`,
              );
            }
            return false;
          },
          `createRuntime.importJ(${primaryJurisdictionName})`,
          45_000,
          () => getRuntimeFatalDiagnostics(newEnv!, primaryJurisdictionName),
        );
        await waitForCondition(
          () => hasRuntimeJurisdictionAddresses(findJReplicaByName(newEnv!, primaryJurisdictionName)),
          `createRuntime.importJ(${primaryJurisdictionName}).addresses`,
          45_000,
          50,
          () => getRuntimeFatalDiagnostics(newEnv!, primaryJurisdictionName),
        );
        markPerf('import_j_testnet');

        for (const secondary of secondaryJurisdictionImports) {
          const secondaryRpcUrl = resolveRpcUrl(resolveJurisdictionRpc(secondary.config), baseOrigin);
          const secondaryChainId = resolveJurisdictionChainId(
            secondary.config,
            `VaultStore.createRuntime.${secondary.name}`,
          );
          await enqueueAndAwait(
            xln,
            newEnv,
            {
              runtimeTxs: [
                {
                  type: 'importJ',
                  data: {
                    name: secondary.name,
                    chainId: secondaryChainId,
                    ticker: String((secondary.config as { currency?: unknown }).currency || 'USDC'),
                    rpcs: [secondaryRpcUrl],
                    entityProviderDeploymentBlock: requireEntityProviderDeploymentBlock(
                      secondary.config.entityProviderDeploymentBlock,
                      `VaultStore.createRuntime.${secondary.name}`,
                    ),
                    blockTimeMs: requireJurisdictionBlockTimeMs(
                      secondary.config.blockTimeMs,
                      `VaultStore.createRuntime.${secondary.name}`,
                    ),
                    contracts: secondary.config.contracts,
                    startAtCurrentBlock: false,
                  },
                },
              ],
              entityInputs: [],
            },
            () => hasRuntimeJurisdictionAddresses(newEnv?.state.jReplicas?.get?.(secondary.name)),
            `createRuntime.importJ(${secondary.name})`,
            45_000,
          );
          await waitForCondition(
            () => hasRuntimeJurisdictionAddresses(newEnv?.state.jReplicas?.get?.(secondary.name)),
            `createRuntime.importJ(${secondary.name}).addresses`,
            45_000,
          );
        }

        // === MVP: Create entity ===
        // Create entity config (single-signer, threshold 1)
        const signerAddress = firstAddress;

        // Get contract addresses from imported J-machine
        const jReplica = findJReplicaByName(newEnv, primaryJurisdictionName);
        if (!jReplica) {
          throw new Error(`${primaryJurisdictionName} J-machine not found after import`);
        }
        // Lazy entity IDs are board hashes generated from the sorted validator set.
        const entityId = generateLazyEntityIdPreview([signerAddress], 1n);
        const entityConfig = buildSignerEntityConfig(signerAddress, jReplica, primaryJurisdictionName, chainId);

        // CRITICAL: Register the canonical signer key with runtime BEFORE importing entity.
        // The wallet/runtime signer for index 0 is the BIP44 account-path key derived above;
        // the entity uses the resulting EOA address as signerId, so consensus/J-batch signing
        // must reuse this exact private key instead of deriving a second one from other labels.
        const signerPrivateKey = derivePrivateKey(seed, 0);
        const privateKeyBytes = new Uint8Array(
          signerPrivateKey
            .slice(2)
            .match(/.{2}/g)!
            .map(byte => parseInt(byte, 16)),
        );
        xln.registerSignerKey(newEnv, signerAddress, privateKeyBytes);
        markPerf('register_signer_key');

        // Import entity replica into runtime
        await enqueueAndAwait(
          xln,
          newEnv,
          {
            runtimeTxs: [
              {
                type: 'importReplica',
                entityId: entityId,
                signerId: signerAddress,
                data: {
                  isProposer: true,
                  config: entityConfig,
                  profileName: name,
                },
              },
            ],
            entityInputs: [],
          },
          () => {
            const reps = newEnv?.state.eReplicas;
            if (!reps?.keys) return false;
            const entityIdNorm = String(entityId).toLowerCase();
            for (const key of reps.keys()) {
              const [repEntityId] = String(key).split(':');
              if (String(repEntityId || '').toLowerCase() === entityIdNorm) return true;
            }
            return false;
          },
          `createRuntime.importReplica(${entityId.slice(0, 12)})`,
        );
        markPerf('import_entity_replica');

        // Store entityId in signer
        runtime.signers[0]!.entityId = entityId;
        runtime.signers[0]!.jurisdiction = primaryJurisdictionName;
        if (options.fundSigner !== false) {
          await fundSignerWalletViaFaucet(signerAddress);
        }

        for (const secondary of secondaryJurisdictionImports) {
          const jReplicaSecondary = findJReplicaByName(newEnv, secondary.name);
          if (!jReplicaSecondary) throw new Error(`${secondary.name} J-machine not found after import`);
          const derivationIndex = deriveJurisdictionSignerIndex(secondary.name);
          const secondaryAddress = deriveAddress(seed, derivationIndex);
          const secondaryPrivateKey = derivePrivateKey(seed, derivationIndex);
          const secondaryPrivateKeyBytes = new Uint8Array(
            secondaryPrivateKey
              .slice(2)
              .match(/.{2}/g)!
              .map(byte => parseInt(byte, 16)),
          );
          xln.registerSignerKey(newEnv, secondaryAddress, secondaryPrivateKeyBytes);
          const secondaryEntityId = generateLazyEntityIdPreview([secondaryAddress], 1n);
          const secondaryChainId = Number(jReplicaSecondary.chainId ?? secondary.config.chainId ?? chainId);
          const secondaryEntityConfig = buildSignerEntityConfig(
            secondaryAddress,
            jReplicaSecondary,
            secondary.name,
            Number.isFinite(secondaryChainId) && secondaryChainId > 0 ? secondaryChainId : chainId,
          );
          await enqueueAndAwait(
            xln,
            newEnv,
            {
              runtimeTxs: [
                {
                  type: 'importReplica',
                  entityId: secondaryEntityId,
                  signerId: secondaryAddress,
                  data: {
                    isProposer: true,
                    config: secondaryEntityConfig,
                    profileName: `${name} ${secondary.name}`,
                  },
                },
              ],
              entityInputs: [],
            },
            () => Boolean(findEntityReplicaByEntityAndSigner(newEnv!, secondaryEntityId, secondaryAddress)),
            `createRuntime.importReplica(${secondary.name}:${secondaryEntityId.slice(0, 12)})`,
          );
          runtime.signers.push({
            index: runtime.signers.length,
            derivationIndex,
            address: secondaryAddress,
            name: `${secondary.name} Signer`,
            jurisdiction: secondary.name,
            entityId: secondaryEntityId,
          });
        }
        if (!requiresOnboarding) {
          writeSavedCollateralPolicy({
            mode: 'autopilot',
            softLimitUsd: 500,
            hardLimitUsd: 10_000,
            maxFeeUsd: 15,
          });
          writeHubJoinPreference(loginType === 'demo' ? '1' : 'manual');
          // Runtime creation imports every local signer/entity lane up front
          // (primary Testnet plus cross-j siblings such as Tron). Onboarding is
          // runtime-level, so never leave a sibling lane looking like signup.
          writeOnboardingCompleteForEntities(
            runtime.signers.map(signer => signer.entityId || '').filter(Boolean),
            true,
          );
        }
      }
      await installVaultRuntimeCommandJournalKeys(runtime.id, runtime.seed);
      runtime = await protectRuntimeForDevice({
        runtime, durationMs: options.unlockDurationMs ?? DEFAULT_VAULT_UNLOCK_DURATION_MS, ...vaultLifecycleEffects,
        persist: protectedRuntime => {
          runtimesStateBinding.controller.update(state => ({
            ...state,
            runtimes: { ...state.runtimes, [id]: protectedRuntime },
            activeRuntimeId: id,
          }));
          persistVaultStateOrThrow();
        },
      });
      markPerf('persist_runtime_state');

      // Add to runtimes store
      runtimes.update(r => {
        const updated = new Map(r);
        updated.set(runtimeId, runtimeToEntry(runtime, newEnv!));
        return updated;
      });
      await runtimeOperations.selectRuntime(runtimeId);
      markPerf('activate_runtime');
      setXlnEnvironment(newEnv);
      registerRuntimeEnvChange(runtimeId, newEnv!, xln);
      markPerf('attach_runtime_to_store');

      ensureRuntimeLoopRunning(newEnv!, xln, `create:${runtimeId.slice(0, 12)}`);

      // Start P2P for this runtime's env (one WS per runtime, stays alive across switches)
      if (xln.startP2P) {
        const relayUrls = resolveRelayUrls();
        xln.startP2P(newEnv!, {
          signerId: runtimeId,
          relayUrls,
          gossipPollMs: BROWSER_GOSSIP_POLL_MS,
        });
      }
      markPerf('start_p2p');

      // Sync metadata (no P2P — already started above)
      this.syncRuntime(runtime);
      runtimeOperations.hydrateRemoteRuntimeImports();
      markPerf('sync_runtime');
      flushPerf('ok');

      finishRuntimeCreation();
      return runtime;
    } catch (error) {
      errorLog.log(`createRuntime failed for ${id.slice(0, 12)}`, 'Runtime Creation', { runtimeId: id, error });
      try {
        if (runtimeId) {
          lockRuntimeCommandJournal(runtimeId);
          await cleanupRuntimeEnv(runtimeId);
        }
      } catch (cleanupError) {
        errorLog.log(`Failed to cleanup partial runtime ${id.slice(0, 12)}`, 'Runtime Creation', {
          runtimeId: id,
          cleanupRuntimeId: runtimeId,
          error: cleanupError,
        });
      }
      runtimesStateBinding.controller.update(state => {
        const nextRuntimes = { ...state.runtimes };
        delete nextRuntimes[id];
        return {
          ...state,
          runtimes: nextRuntimes,
          activeRuntimeId:
            previousActiveRuntimeId && nextRuntimes[previousActiveRuntimeId] ? previousActiveRuntimeId : null,
        };
      });
      this.saveToStorage();
      runtimes.update(entries => {
        const updated = new Map(entries);
        updated.delete(runtimeId);
        return updated;
      });
      if (normalizeRuntimeId(get(activeRuntimeId) || '') === runtimeId) {
        runtimeOperations.setActiveRuntimeId(
          previousActiveRuntimeId && currentState.runtimes[String(previousActiveRuntimeId)]
            ? previousActiveRuntimeId
            : '',
        );
      }
      finishRuntimeCreation();
      throw error;
    }
  },

  async unlockRuntime(
    runtimeId: string,
    seed: string,
    durationMs: VaultUnlockDurationMs = DEFAULT_VAULT_UNLOCK_DURATION_MS,
  ): Promise<void> {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) throw new Error('Invalid runtimeId');
    const resolved = findRuntimeByIdCaseInsensitive(get(runtimesState).runtimes, normalizedRuntimeId);
    if (!resolved) throw new Error(`Runtime not found: ${normalizedRuntimeId}`);
    if (normalizeRuntimeId(deriveAddress(seed, 0)) !== normalizedRuntimeId) {
      throw new Error('RUNTIME_UNLOCK_SEED_MISMATCH');
    }
    const previousRuntime = resolved.runtime;
    const previousSeed = previousRuntime.seed;
    const unlockedRuntime = unlockVaultRuntime(previousRuntime, { seed });
    try {
      await installVaultRuntimeCommandJournalKeys(normalizedRuntimeId, seed);
      await protectRuntimeForDevice({
        runtime: unlockedRuntime, durationMs, ...vaultLifecycleEffects,
        persist: protectedRuntime => {
          runtimesStateBinding.controller.update(state => ({
            ...state,
            runtimes: replaceVaultRuntime(state.runtimes, resolved.key, protectedRuntime),
          }));
          persistVaultStateOrThrow();
        },
      });
    } catch (error) {
      runtimesStateBinding.controller.update(state => ({
        ...state,
        runtimes: replaceVaultRuntime(state.runtimes, resolved.key, previousRuntime),
      }));
      if (previousSeed) {
        try {
          await installVaultRuntimeCommandJournalKeys(normalizedRuntimeId, previousSeed);
        } catch (restoreError) {
          lockRuntimeCommandJournal(normalizedRuntimeId);
          throw new AggregateError([error, restoreError], 'RUNTIME_COMMAND_JOURNAL_KEY_ROLLBACK_FAILED');
        }
      } else {
        lockRuntimeCommandJournal(normalizedRuntimeId);
      }
      throw error;
    }
    await this.selectRuntime(normalizedRuntimeId);
    if (get(runtimes).get(normalizedRuntimeId)?.type === 'remote') {
      await resumeRemoteRuntimeCommandIntents(normalizedRuntimeId);
    }
  },

  async lockRuntime(runtimeId: string, expectedProtection?: ProtectedVaultSecrets): Promise<void> {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) throw new Error('Invalid runtimeId');
    const current = get(runtimesState);
    const runtime = current.runtimes[normalizedRuntimeId];
    if (!runtime) {
      lockRuntimeCommandJournal(normalizedRuntimeId);
      return;
    }
    const persistedProtection = readPersistedVaultProtection(normalizedRuntimeId);
    if (expectedProtection && !sameVaultProtectionLease(expectedProtection, persistedProtection)) {
      if (persistedProtection) {
        const refreshedRuntime = protectVaultRuntime(runtime, persistedProtection);
        runtimesStateBinding.controller.update(state => ({
          ...state,
          runtimes: replaceVaultRuntime(state.runtimes, normalizedRuntimeId, refreshedRuntime),
        }));
        scheduleVaultLock(refreshedRuntime);
      }
      return;
    }
    // Once this lock request owns the current protection lease, revoke command
    // retry authority before any asynchronous storage/runtime cleanup begins.
    lockRuntimeCommandJournal(normalizedRuntimeId);
    const protectionToDelete = persistedProtection || runtime.protectedSecrets;
    vaultLockScheduler.cancel(normalizedRuntimeId);
    const runtimeEntry = get(runtimes).get(normalizedRuntimeId);
    const runtimeEnv = runtimeEntry?.env ? (unwrapLiveRuntimeEnv(runtimeEntry.env) ?? runtimeEntry.env) : null;
    let lockError: unknown;
    try {
      if (protectionToDelete) {
        await deleteVaultDeviceKey(normalizedRuntimeId, protectionToDelete);
      }
    } catch (error) {
      lockError = error;
    }
    try {
      if (runtimeEnv) {
        unregisterRuntimeEnvChange(normalizedRuntimeId);
        await stopRuntimeEnv(runtimeEnv);
      }
    } catch (error) {
      lockError ??= error;
    } finally {
      const xln = await getXLN();
      runtimes.update(entries => {
        const updated = new Map(entries);
        updated.delete(normalizedRuntimeId);
        return updated;
      });
      const signerKeyScopeSeed = runtime.seed;
      if (signerKeyScopeSeed) xln.clearSignerKeys(signerKeyScopeSeed);
      if (runtimeEnv) runtimeEnv.runtimeSeed = undefined;
      runtimesStateBinding.controller.update(state => {
        const latestRuntime = state.runtimes[normalizedRuntimeId];
        if (!latestRuntime) return state;
        const protectedRuntime = persistedProtection
          ? protectVaultRuntime(latestRuntime, persistedProtection)
          : latestRuntime;
        return {
          ...state,
          runtimes: replaceVaultRuntime(
            state.runtimes,
            normalizedRuntimeId,
            lockVaultRuntime(protectedRuntime),
          ),
        };
      });
      persistVaultStateOrThrow();
      if (normalizeRuntimeId(get(activeRuntimeId) || '') === normalizedRuntimeId) {
        setXlnEnvironment(null);
        this.syncRuntime(null);
      }
    }
    if (lockError) throw lockError;
  },

  // Restore the vault-owned env and signer keys. The Runtime selection owner
  // calls this inside its global lease before switching the adapter.
  async prepareRuntimeForAdapterSwitch(runtimeId: string): Promise<string> {
    if (initializePromise && !initialized) {
      throw new Error('RUNTIME_SELECTION_DURING_VAULT_INITIALIZATION');
    }

    const requestedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!requestedRuntimeId) throw new Error('Invalid runtimeId');
    const currentState = get(runtimesState);
    const resolved = findRuntimeByIdCaseInsensitive(currentState.runtimes, requestedRuntimeId);
    if (!resolved) {
      throw new Error(`Runtime not found: ${requestedRuntimeId}`);
    }
    const resolvedRuntimeId = normalizeRuntimeId(resolved.key);
    if (!resolvedRuntimeId) throw new Error('Invalid resolved runtimeId');

    runtimesStateBinding.controller.update(state => ({
      ...state,
      activeRuntimeId: resolvedRuntimeId,
    }));
    this.saveToStorage();
    await suspendInactiveRuntimeActivity(resolvedRuntimeId);

    // CRITICAL: Switch to runtime's isolated runtime + seed
    const current = get(runtimesState);
    const runtime = current.runtimes[resolvedRuntimeId];

    if (runtime) {
      if (!runtime.seed) throw new Error(`RUNTIME_LOCKED:${resolvedRuntimeId}`);
      // CRITICAL: Re-register ALL signer private keys when switching runtimes
      // Keys are stored in memory (signerKeys Map), lost on page refresh
      // Must re-register from HD derivation to enable signing
      const xln = await getXLN();

      for (const signer of runtime.signers) {
        const privateKey = derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));
        const privateKeyBytes = new Uint8Array(
          privateKey
            .slice(2)
            .match(/.{2}/g)!
            .map(byte => parseInt(byte, 16)),
        );
        xln.registerSignerKey(runtime.seed, signer.address, privateKeyBytes);
      }

      // Ensure selected runtime processing pipeline is alive.
      // We do NOT blindly recreate P2P; we only recover if missing/disconnected.
      const runtimeEntry = get(runtimes).get(resolvedRuntimeId);
      let env = runtimeEntry?.env;
      if (!env) {
        await registerRuntimeSignerKeys(runtime, xln);
        env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
        const restoredEnv = env;
        runtimes.update(r => {
          const updated = new Map(r);
          updated.set(resolvedRuntimeId, runtimeToEntry(runtime, restoredEnv));
          return updated;
        });
        registerRuntimeEnvChange(resolvedRuntimeId, restoredEnv, xln);
      }
      await ensureRuntimePipelineAlive(runtime ? { ...runtime, env } : null, xln);
    }

    this.syncRuntime(runtime || null);
    return resolvedRuntimeId;
  },

  // Select runtime
  async selectRuntime(runtimeId: string, lease?: RuntimeSelectionLease): Promise<boolean> {
    // Initialization performs its own Runtime selection before resolving.
    // Await it before acquiring the global lease; waiting from inside the
    // lease would deadlock against initialize()'s queued selection.
    if (!lease && initializePromise && !initialized) {
      await initializePromise;
    }
    if (lease && initializePromise && !initialized) {
      throw new Error('RUNTIME_SELECTION_DURING_VAULT_INITIALIZATION');
    }
    if (!lease) {
      const selected = await coordinateRuntimeSelection((currentLease) =>
        this.selectRuntime(runtimeId, currentLease)
      );
      return selected === true;
    }
    const resolvedRuntimeId = await this.prepareRuntimeForAdapterSwitch(runtimeId);
    return runtimeOperations.selectRuntime(resolvedRuntimeId, lease);
  },

  // Add signer to active runtime. Awaits key registration and entity
  // creation before returning: the runtime's own processing loop can pick up
  // a newly imported replica's mempool (e.g. its self-certifyProfile) as soon
  // as importReplica lands, so the signer key must already be registered by
  // then — never fire-and-forget this tail.
  async addSigner(name?: string, jurisdiction?: string): Promise<Signer | null> {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime?.seed) return null;

    const jurisdictionKey = normalizeJurisdictionKey(jurisdiction);
    if (jurisdictionKey) {
      const existing = runtime.signers.find(
        signer => normalizeJurisdictionKey(signer.jurisdiction) === jurisdictionKey,
      );
      if (existing) return existing;
    }

    const inflightKey = runtime.id;
    const priorCreation = signerCreationInFlight.get(inflightKey);
    if (priorCreation) {
      await priorCreation;
      return this.addSigner(name, jurisdiction);
    }

    const nextIndex = runtime.signers.length;
    const derivationIndex = jurisdictionKey ? deriveJurisdictionSignerIndex(jurisdictionKey) : nextIndex;
    const address = deriveAddress(runtime.seed, derivationIndex);

    const newSigner: Signer = {
      index: nextIndex,
      ...(derivationIndex !== nextIndex ? { derivationIndex } : {}),
      address,
      name: name || `Signer ${nextIndex + 1}`,
      ...(jurisdiction ? { jurisdiction } : {}),
    };

    // CRITICAL: Register HD-derived private key with runtime BEFORE creating entity
    // Why: Runtime's deriveSignerKeySync uses different derivation than BIP44 HD
    // Without this, hanko verification fails (signature from wrong key)
    const creation = (async (): Promise<Signer> => {
      const xln = await getXLN();
      const privateKey = derivePrivateKey(runtime.seed, derivationIndex);
      const privateKeyBytes = new Uint8Array(
        privateKey
          .slice(2)
          .match(/.{2}/g)!
          .map(byte => parseInt(byte, 16)),
      );
      xln.registerSignerKey(runtime.seed, address, privateKeyBytes);

      // Now create entity (key is registered, signing will work)
      const { autoCreateEntityForSigner } = await import('../utils/entityFactory');
      const runtimeEntry = get(runtimes).get(runtime.id);
      const runtimeEnv = runtimeEntry?.env ? (unwrapLiveRuntimeEnv(runtimeEntry.env) ?? runtimeEntry.env) : null;
      if (!runtimeEnv) {
        throw new Error(
          `[VaultStore] Cannot auto-create signer entity without active runtime env: runtime=${runtime.id}`,
        );
      }
      const entityId = await autoCreateEntityForSigner(address, runtimeEnv, jurisdiction);
      const committedSigner: Signer = entityId ? { ...newSigner, entityId } : newSigner;

      // Publish the signer only after every prerequisite succeeded. Persisting it
      // earlier leaves a vault entry whose key/entity setup failed halfway.
      runtimesStateBinding.controller.update(state => {
        const latestRuntime = state.runtimes[runtime.id];
        if (!latestRuntime) {
          throw new Error(`SIGNER_RUNTIME_DISAPPEARED:${runtime.id}`);
        }
        if (latestRuntime.signers.some(signer => signer.address.toLowerCase() === address.toLowerCase())) {
          throw new Error(`SIGNER_ADDRESS_ALREADY_EXISTS:${address}`);
        }
        return {
          ...state,
          runtimes: {
            ...state.runtimes,
            [runtime.id]: {
              ...latestRuntime,
              signers: [...latestRuntime.signers, committedSigner],
            },
          },
        };
      });
      this.saveToStorage();
      return committedSigner;
    })();
    signerCreationInFlight.set(inflightKey, creation);

    try {
      return await creation;
    } catch (err) {
      errorLog.log('Failed to register key/create entity', 'Runtime Creation', {
        runtimeId: runtime.id,
        signerIndex: nextIndex,
        signerAddress: address,
        error: err,
      });
      toasts.error(`Failed to create signer entity: ${(err as Error)?.message || String(err)}`, 10_000);
      throw err;
    } finally {
      if (signerCreationInFlight.get(inflightKey) === creation) {
        signerCreationInFlight.delete(inflightKey);
      }
    }
  },

  // Select signer
  selectSigner(index: number) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || index >= runtime.signers.length) return;

    runtimesStateBinding.controller.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          activeSignerIndex: index,
        },
      },
    }));

    this.saveToStorage();
  },

  // Rename signer
  renameSigner(index: number, name: string) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || index >= runtime.signers.length) return;

    runtimesStateBinding.controller.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: runtime.signers.map((s, i) => (i === index ? { ...s, name } : s)),
        },
      },
    }));

    this.saveToStorage();
  },

  // Set entity ID for signer
  setSignerEntity(signerIndex: number, entityId: string) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || signerIndex >= runtime.signers.length) return;

    runtimesStateBinding.controller.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: runtime.signers.map((s, i) => (i === signerIndex ? { ...s, entityId } : s)),
        },
      },
    }));

    this.saveToStorage();
  },

  // Delete runtime
  async deleteRuntime(runtimeId: string) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    await cleanupRuntimeEnv(normalizedRuntimeId);

    let nextActiveId: string | null = null;
    runtimesStateBinding.controller.update(state => {
      const { [normalizedRuntimeId]: removed, ...remaining } = state.runtimes;
      const remainingIds = Object.keys(remaining);
      nextActiveId = state.activeRuntimeId === normalizedRuntimeId ? remainingIds[0] || null : state.activeRuntimeId;

      return {
        runtimes: remaining,
        activeRuntimeId: nextActiveId,
      };
    });

    runtimes.update(r => {
      const updated = new Map(r);
      updated.delete(normalizedRuntimeId);
      return updated;
    });

    runtimeOperations.setActiveRuntimeId(nextActiveId || '');
    this.saveToStorage();
    const current = get(runtimesState);
    this.syncRuntime(current.activeRuntimeId ? current.runtimes[current.activeRuntimeId] || null : null);
  },

  // Get private key for active signer
  getActiveSignerPrivateKey(): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime?.seed) return null;

    const signer = runtime.signers[runtime.activeSignerIndex];
    if (!signer) return null;
    return derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));
  },

  // Get private key for specific signer
  getSignerPrivateKey(signerIndex: number): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime?.seed || signerIndex >= runtime.signers.length) return null;

    return derivePrivateKey(runtime.seed, getSignerDerivationIndex(runtime.signers[signerIndex]));
  },

  // Check if runtime exists
  runtimeExists(id: string): boolean {
    const current = get(runtimesState);
    if (!current?.runtimes) return false;
    const normalized = normalizeRuntimeId(id);
    if (!normalized) return false;
    return normalized in current.runtimes;
  },

  // Initialize
  async initialize() {
    registerRuntimeResumeListener();
    if (initialized) return;
    if (initializePromise) return initializePromise;

    initializePromise = (async () => {
      this.loadFromStorage();
      const loaded = get(runtimesState);
      let migratedPlaintext = false;
      for (const storedRuntime of Object.values(loaded.runtimes)) {
        let runtime = storedRuntime;
        if (runtime.seed) {
          if (!runtime.protectedSecrets) {
            runtime = await protectRuntimeForDevice({
              runtime, durationMs: DEFAULT_VAULT_UNLOCK_DURATION_MS, ...vaultLifecycleEffects,
              persist: protectedRuntime => {
                runtimesStateBinding.controller.update(state => ({
                  ...state,
                  runtimes: replaceVaultRuntime(state.runtimes, runtime.id, protectedRuntime),
                }));
                persistVaultStateOrThrow();
              },
            });
            migratedPlaintext = true;
          } else {
            runtime = protectVaultRuntime(runtime, runtime.protectedSecrets);
            runtimesStateBinding.controller.update(state => ({
              ...state,
              runtimes: replaceVaultRuntime(state.runtimes, runtime.id, runtime),
            }));
            scheduleVaultLock(runtime);
          }
          await installVaultRuntimeCommandJournalKeys(runtime.id, runtime.seed);
          continue;
        }
        const restoredRuntime = await restoreRuntimeFromDevice({ runtime, scheduleLock: scheduleVaultLock });
        if (restoredRuntime) {
          runtimesStateBinding.controller.update(state => ({
            ...state,
            runtimes: replaceVaultRuntime(state.runtimes, runtime.id, restoredRuntime),
          }));
        }
      }
      if (migratedPlaintext) this.saveToStorage();
      const current = get(runtimesState);
      const all = Object.values(current.runtimes);
      let xln: XLNModule | null = null;

      if (all.length > 0) {
        xln = await getXLN();

        for (const runtime of all) {
          if (!runtime.seed) continue;
          const runtimeId = normalizeRuntimeId(runtime.id);
          if (!runtimeId) continue;
          const existing = get(runtimes).get(runtimeId);
          if (existing?.env) {
            continue;
          }
          await registerRuntimeSignerKeys(runtime, xln);

          const env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
          if (normalizeRuntimeId(env?.runtimeId || '') !== runtimeId) {
            throw new Error(
              `[VaultStore.initialize] Runtime isolation mismatch: slot=${runtimeId} env.runtimeId=${String(env?.runtimeId || 'none')}`,
            );
          }
          runtimes.update(r => {
            const updated = new Map(r);
            updated.set(runtimeId, runtimeToEntry({ ...runtime, id: runtimeId }, env));
            return updated;
          });
          registerRuntimeEnvChange(runtimeId, env, xln);
        }
      }

      const latest = get(runtimesState);
      const allLatest = Object.values(latest.runtimes);
      const resolvedActive = findRuntimeByIdCaseInsensitive(latest.runtimes, latest.activeRuntimeId ?? undefined);
      const currentSelected = normalizeRuntimeId(get(activeRuntimeId) || '');
      const sharedRuntimes = get(runtimes);
      const currentSharedRuntime = currentSelected ? sharedRuntimes.get(currentSelected) : null;
      const keepCurrentSelection = !!(
        currentSelected &&
        (latest.runtimes[currentSelected] || currentSharedRuntime?.type === 'remote')
      );
      const activeId = keepCurrentSelection
        ? currentSelected
        : normalizeRuntimeId(resolvedActive?.key ?? allLatest[0]?.id ?? null);
      runtimeOperations.setActiveRuntimeId(activeId);
      const runtimeEntry = activeId ? sharedRuntimes.get(activeId) : null;
      const runtimeMeta = activeId ? latest.runtimes[activeId] : null;
      const runtimeToSync = runtimeMeta && runtimeEntry?.env ? { ...runtimeMeta, env: runtimeEntry.env } : runtimeMeta;
      if (activeId && runtimeToSync?.env && normalizeRuntimeId(runtimeToSync.env.runtimeId || '') !== activeId) {
        throw new Error(
          `[VaultStore.initialize] Active runtime env mismatch: active=${activeId} env.runtimeId=${String(runtimeToSync.env.runtimeId || 'none')}`,
        );
      }
      if (runtimeToSync?.seed) {
        const activeXln = xln ?? (await getXLN());
        await ensureRuntimePipelineAlive(runtimeToSync as Runtime, activeXln);
        await runtimeOperations.selectRuntime(activeId);
      }
      if (runtimeToSync?.seed) this.syncRuntime(runtimeToSync);
      else if (runtimeToSync) this.syncRuntime(null);
      else if (!activeId) this.syncRuntime(null);
      initialized = true;
    })();

    try {
      await initializePromise;
    } finally {
      initializePromise = null;
    }
  },

  // Clear all runtimes
  async clearAll() {
    const runtimeIds = Array.from(get(runtimes).keys());
    await Promise.all(runtimeIds.map(id => cleanupRuntimeEnv(id)));

    runtimesStateBinding.controller.set(defaultState);
    vaultStorageLoadedBinding.controller.set(true);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(VAULT_STORAGE_KEY);
    }

    runtimes.set(new Map());
    runtimeOperations.setActiveRuntimeId('');
    this.syncRuntime(null);
  },

  // === MVP: Get XLN balance for active entity ===
  async getEntityBalance(tokenId: number = 1): Promise<bigint> {
    const signer = get(activeSigner);
    if (!signer?.entityId) return 0n;

    try {
      const xln = await getXLN();
      const activeId = normalizeRuntimeId(get(activeRuntimeId) || '');
      const runtimeEntry = activeId ? get(runtimes).get(activeId) : null;
      const env = runtimeEntry?.env ? (unwrapLiveRuntimeEnv(runtimeEntry.env) ?? runtimeEntry.env) : null;
      const jadapter = env ? xln.getEntityJAdapter(env, signer.entityId, signer.address) : null;
      if (!jadapter?.getReserves) return 0n;

      return await jadapter.getReserves(signer.entityId, tokenId);
    } catch (err) {
      errorLog.log('Failed to get balance', 'Runtime Balance', {
        entityId: signer.entityId,
        tokenId,
        error: err,
      });
      return 0n;
    }
  },

  // === MVP: Send tokens to another entity ===
  async sendTokens(
    toEntityId: string,
    amount: bigint,
    tokenId: number = 1,
  ): Promise<{ success: boolean; error?: string }> {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return { success: false, error: 'No active runtime' };

    const runtime = current.runtimes[current.activeRuntimeId];
    const signer = runtime?.signers[runtime.activeSignerIndex];
    if (!signer?.entityId) return { success: false, error: 'No entity for signer' };

    try {
      const activeId = normalizeRuntimeId(get(activeRuntimeId) || '');
      const runtimeEntry = activeId ? get(runtimes).get(activeId) : null;
      const env = runtimeEntry?.env ? (unwrapLiveRuntimeEnv(runtimeEntry.env) ?? runtimeEntry.env) : null;
      if (!env) return { success: false, error: 'Runtime env unavailable' };

      await submitXlnEntityInputs([
        {
          entityId: signer.entityId,
          signerId: signer.address,
          entityTxs: [
            {
              type: 'r2r',
              data: { toEntityId, tokenId, amount },
            },
          ],
        },
      ]);
      return { success: true };
    } catch (err) {
      errorLog.log('Send failed', 'Runtime Send', {
        fromEntityId: signer.entityId,
        toEntityId,
        tokenId,
        amount: amount.toString(),
        error: err,
      });
      return { success: false, error: err instanceof Error ? err.message : 'Transfer failed' };
    }
  },

  // Get active entity ID
  getActiveEntityId(): string | null {
    const signer = get(activeSigner);
    return signer?.entityId || null;
  },
};

registerDebugSurface('vault', () => vaultOperations);
