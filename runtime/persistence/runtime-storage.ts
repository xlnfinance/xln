import { Level } from 'level';
import { runtimeIsBrowser } from './../runtime/platform';
import { getPerfMs } from './../utils';
import { cloneIsolatedRoutedEntityInputs, cloneIsolatedRuntimeInput } from './../protocol/runtime-input-clone';
import { requireBoundaryInteger } from './../protocol/boundary-validation';
import {
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimeMachineSnapshot,
  authorizeRestoredRuntimeInput,
  restoreDurableRuntimeSnapshot,
} from './../wal/snapshot';
import { assertPersistedLocalEntityCryptoKeys } from './../entity/crypto';
import { getLiveConsumptionAccumulatorStates } from './../entity/consumption-store';
import { getLiveAccountJClaimAccumulatorStates } from './../account/j-claim-store';
import {
  dropPendingFrameDbRecords,
  dropOverlay,
  peekPendingFrameDbRecords,
  setAccountFrameHistoryView,
} from './../runtime/env-events';
import { normalizeRuntimeId } from './../networking/runtime-id';
import { formatReplicaKey, createReplicaKey } from './../ids';
import { transitionRuntimeLifecycle } from './../runtime/lifecycle';
import { ensureRuntimeState } from './../runtime/runtime-state';
import { restoreDurableOutputRetryState } from './../runtime/durable-output-retry';
import { cloneEntityState } from './../state-helpers';
import { safeStringify } from './../protocol/serialization';
import {
  computeCanonicalEntityHash,
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalStateHashFromEnv,
} from './../storage/canonical-hash';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from './../storage/entity-lineage';
import { assertCertifiedRegistrationEvidenceStore } from './../jurisdiction/registration-evidence';
import {
  computeStoragePostStateHash,
  findStorageLatestSnapshotAtOrBelow,
  hydrateAccountJClaimRootNodesFromStorage,
  hydrateCertifiedBoardRootNodesFromStorage,
  hydrateConsumptionRootNodesFromStorage,
  listStorageSnapshotEntityIds,
  listStorageSnapshotHeights,
  listStorageSnapshotReplicaMetas,
  listStorageReplicaMetas,
  loadEntityStatesAtHeightFromStorage,
  readFrameDbAccountFrames,
  readFrameDbRuntimeActivity,
  readStorageFrameRecord,
  readStorageHead,
  readStorageOverlayRecordsFromDiffs,
  saveRuntimeFrameToStorage,
  type StorageFrameRecord,
  type StorageHead,
  verifyStorageSnapshotAtHeight,
} from './../storage';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
} from './../storage/replicas';
import { assertStorageSafetyOverridesAllowed } from './../storage/safety';
import { storageOverlayRecordKey } from './../storage/overlay';
import { evaluateStorageProgressDeadline } from './../storage/progress-deadline';
import { assertCertifiedJHistoryIntegrity, assertValidatorJHistoryIntegrity } from './../jurisdiction/local-history';
import { restoreJPrefixRound } from './../jurisdiction/j-prefix-consensus';
import type {
  EntityReplica,
  EntityState,
  Env,
  FrameLogEntry,
  RoutedEntityInput,
  RuntimeOverlayRecord,
  RuntimeInput,
} from './../types';
import { buildRecoveryJournalFromStorageFrame } from './queries';
import { normalizeDbNamespace, withStorageWriterLock } from './../storage/runtime-dbs';
import { createStructuredLogger } from '../infra/logger';
import type { PersistedFrameJournal } from '../storage/types';
import type { StorageDbRole } from '../storage/runtime-dbs';

type RuntimeModule = typeof import('../runtime');

export type RuntimeStorageApiDeps = Pick<RuntimeModule, 'closeRuntimeDb' | 'closeInfraDb' | 'createEmptyEnv'> & {
  getStorageDb(env: Env, role?: StorageDbRole): Level<Buffer, Buffer>;
  getFrameDb(env: Env): Level<Buffer, Buffer>;
  tryOpenStorageDb(env: Env, role?: StorageDbRole): Promise<boolean>;
  rotateStorageEpochDb(env: Env, snapshotHeight: number, timestamp?: number): Promise<boolean>;
  tryOpenFrameDb(env: Env): Promise<boolean>;
  waitForPromiseBeforeTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean>;
  replayRecoveryFrameJournals(env: Env, frames: PersistedFrameJournal[]): Promise<void>;
};

const ENV_REPLAY_MODE_KEY = Symbol.for('xln.runtime.env.replay.mode');
const envRecord = (env: Env): Record<PropertyKey, unknown> => env as unknown as Record<PropertyKey, unknown>;
const runtimeLog = createStructuredLogger('runtime');
const formatPerfMs = (value: number): string => value.toFixed(2);

export const createRuntimeStorageApi = (deps: RuntimeStorageApiDeps) => {
  const {
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
  } = deps;

  const waitForRuntimeProcessingIdle = async (env: Env, timeoutMs = 5_000): Promise<boolean> => {
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

  const shouldRequireCanonicalStorageAudit = (runtimeProcess = getRuntimeProcessGlobal()): boolean => {
    const raw = String(runtimeProcess?.env?.['XLN_STORAGE_VERIFY_CANONICAL'] || '')
      .trim()
      .toLowerCase();
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
      super(`STORAGE_WRITE_TIMEOUT:frame=${frameHeight}:runtime=${runtimeId}:` + `timeoutMs=${timeoutMs}:step=${step}`);
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
            deadline = evaluateStorageProgressDeadline(lastProgressAtMs, Date.now(), timeoutMs);
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
          reject(
            new RuntimeStorageWriteTimeoutError(timeoutMs, env.height, String(env.runtimeId || ''), lastProgressStep),
          );
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
      Promise.resolve()
        .then(() => operation(markProgress))
        .then(
          value => {
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
      const runtimeMachineMatches =
        !frame.runtimeMachine ||
        safeStringify(frame.runtimeMachine) ===
          safeStringify(
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
  const saveEnvToDB = async (
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
      saveResult = await withStorageWriteTimeout(env, markStorageProgress =>
        withStorageWriterLock(env, () =>
          saveRuntimeFrameToStorage({
            env,
            tryOpenDb: targetEnv => tryOpenStorageDb(targetEnv, 'current'),
            getRuntimeDb: targetEnv => getStorageDb(targetEnv, 'current'),
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
            onPersistenceBoundary: boundary => markStorageProgress(`boundary:${boundary}`),
          }),
        ),
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
        message: `STALE_RUNTIME_WRITER_STOPPED: frame=${env.height} runtime=${String(env.runtimeId || '').slice(0, 12)}`,
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
    if (
      runtimeIsBrowser &&
      typeof BroadcastChannel !== 'undefined' &&
      typeof env.runtimeId === 'string' &&
      env.runtimeId.length > 0
    ) {
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
    return [
      {
        role: 'history',
        db,
        head,
        latestHeight: head.latestHeight,
        latestMaterializedHeight: Math.max(
          0,
          Math.floor(Number(head.latestMaterializedHeight ?? head.latestSnapshotHeight ?? 0)),
        ),
        latestSnapshotHeight: head.latestSnapshotHeight,
        snapshotHeights: (await listStorageSnapshotHeights(db)).filter(height => height <= head.latestSnapshotHeight),
      },
    ];
  };

  const restoreOverlayFromFrameLog = async (env: Env, targetHeight: number): Promise<void> => {
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
    return Array.from(new Set(handles.flatMap(handle => handle.snapshotHeights))).sort((left, right) => left - right);
  };

  const readPersistedStorageFrameRecord = async (
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
    return listStorageSnapshotReplicaMetas(getFrameDb(env), snapshotHeight, normalizedEntityId);
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

  const listPersistedEntityIdsAtHeight = async (env: Env, targetHeight: number): Promise<string[]> => {
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
      .map(validator => String(validator || '').toLowerCase())
      .filter(validator => validator.length > 0);
  };

  const resolvePersistedReplicaIdentity = (
    entityId: string,
    state: EntityState,
    meta: Awaited<ReturnType<typeof readPersistedStorageReplicaMetas>>[number] | null,
    targetHeight: number,
    latestHeight: number,
  ): { signerId: string; isProposer: boolean } => {
    const validators = listPersistedReplicaValidators(state);
    const metaSignerId =
      typeof meta?.signerId === 'string' && meta.signerId.trim().length > 0 ? meta.signerId.trim().toLowerCase() : '';
    const isLatestRestore = targetHeight === latestHeight;
    if (isLatestRestore && !metaSignerId && validators.length > 1) {
      throw new Error(
        `STORAGE_RESTORE_REPLICA_META_REQUIRED: entity=${entityId} validators=${validators.length} height=${targetHeight}`,
      );
    }
    const signerId = metaSignerId || validators[0] || String(state.entityId || entityId).toLowerCase();
    const isProposer =
      typeof meta?.isProposer === 'boolean'
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
      const latestHeight = persistedHandles.reduce((max, handle) => Math.max(max, handle.latestHeight), 0);
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
        const retainedCheckpoint = persistedHandles.some(handle => handle.snapshotHeights.includes(targetHeight));
        if (options.prunedTargetReturnsNull && targetHeight < latestSnapshotHeight && !retainedCheckpoint) return null;
        throw new Error(`STORAGE_RESTORE_FRAME_MISSING: height=${targetHeight}`);
      }
      const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(env, targetHeight);
      if (selectedSnapshotHeight > 0) {
        const snapshotHandle = persistedHandles.find(handle => handle.snapshotHeights.includes(selectedSnapshotHeight));
        if (!snapshotHandle) {
          throw new Error(`STORAGE_RESTORE_SNAPSHOT_HANDLE_MISSING:height=${selectedSnapshotHeight}`);
        }
        await verifyStorageSnapshotAtHeight(snapshotHandle.db, snapshotHandle.head, selectedSnapshotHeight);
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
        const persistedMetas =
          targetHeight === latestHeight
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
            ...(meta?.certifiedFrameLineage ? { certifiedFrameLineage: meta.certifiedFrameLineage } : {}),
            ...(meta?.certifiedFrameAnchor ? { certifiedFrameAnchor: meta.certifiedFrameAnchor } : {}),
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
      for (const root of new Set(
        Array.from(env.eReplicas.values(), replica => replica.state.certifiedBoardState?.boardRegistryRoot).filter(
          (value): value is string => Boolean(value),
        ),
      )) {
        await hydrateCertifiedBoardRootNodesFromStorage(env, historyDb, root);
      }
      for (const state of getLiveConsumptionAccumulatorStates(env)) {
        await hydrateConsumptionRootNodesFromStorage(env, historyDb, state);
      }
      await hydrateAccountJClaimRootNodesFromStorage(env, historyDb, getLiveAccountJClaimAccumulatorStates(env));

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
      restoreDurableOutputRetryState(env, frame.runtimeOutputRetryState ?? [], frame.runtimeOutputs ?? []);
      await restoreOverlayFromFrameLog(env, targetHeight);
      await hydrateAccountFrameHistoryViews(env);
      let restoredFrameLogs: FrameLogEntry[] = [];
      try {
        if (await tryOpenFrameDb(env)) {
          const activity = await readFrameDbRuntimeActivity(getFrameDb(env), targetHeight);
          if (activity?.logs) restoredFrameLogs = activity.logs.map(entry => ({ ...entry }));
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
        const expectedEntities = new Map(
          (frame.canonicalEntityHashes || []).map(entry => [entry.entityId, entry.hash]),
        );
        const actualEntities = computeCanonicalEntityHashesFromEnv(env);
        const mismatch = actualEntities.find(entry => expectedEntities.get(entry.entityId) !== entry.hash);
        const missing = (frame.canonicalEntityHashes || []).find(
          entry => !actualEntities.some(actual => actual.entityId === entry.entityId),
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
          setAccountFrameHistoryView(
            account,
            records.map(record => record.frame),
            limit,
          );
        }
      }
    } catch (error) {
      runtimeLog.warn('account_frame_history.hydrate_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

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
      ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, replayCheckpointLineagePlan, {
          omitIntermediateSingleSignerState: persistedFrame.replicaMetaStateMode === 'shared-entity-state',
        }).digest
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
      ? expectedCanonicalStateHash
        ? computeCanonicalStateHashFromEnv(env)
        : ''
      : actualStateHash;
    return {
      expectedStateHash,
      actualStateHash,
      expectedCanonicalStateHash,
      actualCanonicalStateHash,
      ok: expectedStateHash === actualStateHash && expectedCanonicalStateHash === actualCanonicalStateHash,
    };
  };

  const verifyRuntimeChain = async (
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
        throw new Error(`REPLAY_INVARIANT_FAILED: failed to restore checkpoint at height ${selectedSnapshotHeight}`);
      }
      for (let height = selectedSnapshotHeight; height <= latestHeight; height += 1) {
        const persistedFrame = await readPersistedStorageFrameRecord(replayed.env, height);
        if (!persistedFrame) {
          throw new Error(`REPLAY_INVARIANT_FAILED: missing persisted frame at height ${height}`);
        }
        if (height > selectedSnapshotHeight) {
          await replayRecoveryFrameJournals(replayed.env, [buildRecoveryJournalFromStorageFrame(persistedFrame)]);
        }
        if (height < requestedFromHeight) continue;
        const verification = verifyPersistedFrameState(replayed.env, persistedFrame);
        ({ expectedStateHash, actualStateHash, expectedCanonicalStateHash, actualCanonicalStateHash } = verification);
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
          Number.isFinite(Number(targetHeightOverride)) ? Math.floor(Number(targetHeightOverride)) : latestHeight,
        ),
      );
      const selectedSnapshotHeight = await resolvePersistedSnapshotHeight(probeEnv, targetHeight);
      if (selectedSnapshotHeight <= 0) {
        const latestSnapshotHeight = await resolvePersistedSnapshotHeight(probeEnv, latestHeight);
        if (options.prunedTargetReturnsNull && latestSnapshotHeight > targetHeight) return null;
        throw new Error(`STORAGE_RESTORE_SNAPSHOT_MISSING:height=${targetHeight}`);
      }
      return { latestHeight, targetHeight, selectedSnapshotHeight };
    } finally {
      await closeRuntimeDb(probeEnv);
      await closeInfraDb(probeEnv);
    }
  };

  const restoreReplayedActivityViews = async (env: Env, targetHeight: number): Promise<void> => {
    // Activity/history hydration is a read-model concern. Never erase deferred
    // input state reconstructed from the latest WAL frame.
    env.runtimeInput = env.runtimeMempool ?? { runtimeTxs: [], entityInputs: [] };
    await restoreOverlayFromFrameLog(env, targetHeight);
    await hydrateAccountFrameHistoryViews(env);
    env.frameLogs = [];
    if (!(await tryOpenFrameDb(env))) return;
    try {
      const activity = await readFrameDbRuntimeActivity(getFrameDb(env), targetHeight);
      env.frameLogs = activity?.logs?.map(entry => ({ ...entry })) ?? [];
    } catch (error) {
      runtimeLog.warn('storage.activity_restore_failed', {
        height: targetHeight,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  };

  const assertReplayedStorageFrameMatches = (env: Env, frame: StorageFrameRecord): void => {
    const verification = verifyPersistedFrameState(env, frame);
    if (verification.ok) return;
    const expectedEntities = new Map((frame.canonicalEntityHashes ?? []).map(entry => [entry.entityId, entry.hash]));
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
        target.selectedSnapshotHeight <= 1 ? 'genesis:1' : `checkpoint:${target.selectedSnapshotHeight}`,
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
    const restored = await loadEnvFromStorage(runtimeId, runtimeSeed, target.selectedSnapshotHeight, options);
    if (!restored) return null;
    let returningEnv = false;
    try {
      let targetFrame: StorageFrameRecord | null = null;
      for (let height = target.selectedSnapshotHeight; height <= target.targetHeight; height += 1) {
        const frame = await readPersistedStorageFrameRecord(restored.env, height);
        if (!frame) throw new Error(`STORAGE_RESTORE_FRAME_MISSING:height=${height}`);
        targetFrame = frame;
        if (height > target.selectedSnapshotHeight) {
          await replayRecoveryFrameJournals(restored.env, [buildRecoveryJournalFromStorageFrame(frame)]);
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

  return {
    waitForRuntimeProcessingIdle,
    getRuntimeProcessGlobal,
    RuntimeStorageWriteTimeoutError,
    RuntimeFrameStorageError,
    saveEnvToDB,
    readPersistedStorageFrameRecord,
    listPersistedEntityIdsAtHeight,
    verifyRuntimeChain,
    resolvePersistedLatestHeight,
    resolvePersistedCheckpointHeights,
    loadEnvFromStorageByReplay,
  };
};
