import { Level } from 'level';
import type { Provider } from 'ethers';
import {
  DEFAULT_SNAPSHOT_INTERVAL_FRAMES,
  isProductionRuntime,
  readRuntimeEnv,
  yieldRuntimeIoTurn,
} from '../machine/platform';
import { getWallClockMs } from './../utils';
import { accountHasProposableMempool } from './../entity/consensus/account-mempool-eligibility';
import { isEntityActiveLeader } from './../entity/consensus/leader';
import type { JAdapter } from './../jadapter';
import { recordRuntimeSecurityIncident } from '../machine/security-incidents';
import { normalizeRuntimeFailureCode } from './../protocol/failure-taxonomy';
import { deriveSignerAddressSync, getSignerPrivateKeyIfAvailable } from './../account/crypto';
import { normalizeRuntimeId } from './../networking/runtime-id';
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
} from '../machine/p2p-lifecycle';
import { extractEntityId, extractSignerId } from './../ids';
import {
  getNextNetworkRetryTimestamp,
  hasReadyPendingNetworkOutputs,
  MAX_PENDING_NETWORK_OUTPUTS,
  sendEntityInputWithRouting,
  type RuntimeEntityInputRoutingResult,
  type RuntimeOutputRoutingDeps,
} from '../machine/output-routing';
import { runtimeInputRequiresOutboxCapacity } from '../machine/admission';
import { isDeliveryDelivered } from './../protocol/payments/delivery-result';
import {
  createRuntimeOutputRoutingDeps,
  routeInboundP2PEntityInput,
  routeInboundP2PEntityInputs,
  registerEntityRuntimeHintWithDeps,
  validateInboundP2PEntityInput,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeInboundEntityInputOptions,
  type RuntimeEntityRoutingDeps,
} from '../machine/entity-routing';
import {
  generateHookPingsWithDeps,
  getEarliestWallClockDueTimestampWithDeps,
  getNextWallClockWakeTimestampWithDeps,
  hasDueEntityHooksWithDeps,
  type RuntimeWakeDeps,
} from '../machine/wake';
import {
  assertScheduledWakeTxAuthorized,
  deleteScheduledWakeIndex,
  rebuildScheduledWakeIndex,
} from '../machine/scheduled-wake';
import {
  assertRuntimeCommandReady,
  inferRuntimeLifecyclePhase,
  transitionRuntimeLifecycle,
} from '../machine/lifecycle';
import {
  enqueueRuntimeInputsWithDeps,
  ensureRuntimeMempool,
  requestRuntimeLoopWake,
  type RuntimeInputQueueDeps,
  type RuntimeInputQueueOptions,
} from '../machine/input-queue';
import { ensureRuntimeState } from '../machine/runtime-state';
import { registerReliableReceiptIngress } from '../machine/reliable-delivery';
import {
  clearRuntimeCleanLogs,
  copyRuntimeCleanLogs,
  getRuntimeCleanLogs,
  type RuntimeCleanLogDeps,
} from '../machine/clean-logs';
import { RuntimeEntityInputApplyError } from '../machine/entity-inputs';
import { safeStringify } from './../protocol/serialization';
import {
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  hasCurrentRoundJPrefixAttestation,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
} from './../jurisdiction/j-prefix-consensus';
import { validateEntityInput } from './../validation-utils';
import type {
  EntityInput,
  EntityReplica,
  Env,
  JInput,
  JReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
  RuntimeFrameIngressBuffer,
  RuntimeInput,
  RuntimeTx,
} from './../types';
import { clearInfraGossipProfiles } from '../machine/infra-gossip-store';
import {
  closeFrameDb,
  closeStorageDb,
  normalizeDbNamespace,
  type RuntimeStorageDbDeps,
  type StorageDbRole,
} from './../storage/runtime-dbs';
import * as runtimeDbs from './../storage/runtime-dbs';
import { createStructuredLogger } from '../infra/logger';

type RuntimeModule = typeof import('../runtime');

type RuntimeFrameIngressTransaction = {
  liveEnv: Env;
  ingressBuffer: RuntimeFrameIngressBuffer;
};

export type RuntimeLoopApiDeps = {
  notifyEnvChange(env: Env): void;
  process: RuntimeModule['process'];
  waitForRuntimeProcessingIdle: RuntimeModule['waitForRuntimeProcessingIdle'];
  getRuntimeProcessGlobal(): { exit?: (code: number) => unknown } | null;
  runtimeInputHasQueuedWork(input: RuntimeInput): boolean;
};

const runtimeLog = createStructuredLogger('runtime');

export const createRuntimeLoopApi = (deps: RuntimeLoopApiDeps) => {
  const { notifyEnvChange, process, waitForRuntimeProcessingIdle, getRuntimeProcessGlobal, runtimeInputHasQueuedWork } =
    deps;

  const registerEnvChangeCallback = (env: Env, callback: (env: Env) => void): (() => void) => {
    const state = ensureRuntimeState(env);
    if (!state.envChangeCallbacks) {
      state.envChangeCallbacks = new Set();
    }
    state.envChangeCallbacks.add(callback);
    return () => state.envChangeCallbacks?.delete(callback);
  };

  const registerRuntimeFrameCommitCallback = (
    env: Env,
    callback: (frame: { height: number; runtimeInput: RuntimeInput }) => void,
  ): (() => void) => {
    const state = ensureRuntimeState(env);
    if (!state.runtimeFrameCommitCallbacks) state.runtimeFrameCommitCallbacks = new Set();
    state.runtimeFrameCommitCallbacks.add(callback);
    return () => state.runtimeFrameCommitCallbacks?.delete(callback);
  };

  const registerRecoveryBackupBarrier = (
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
    const storageEpochMaxBytesEnv = readRuntimeEnv('XLN_STORAGE_EPOCH_MAX_BYTES');
    if (storageEpochMaxBytesEnv !== undefined && env.runtimeConfig.storage?.epochMaxBytes === undefined) {
      const epochMaxBytes = Number(storageEpochMaxBytesEnv);
      if (!Number.isSafeInteger(epochMaxBytes) || epochMaxBytes < 1) {
        throw new Error(`RUNTIME_CONFIG_STORAGE_EPOCH_MAX_BYTES_INVALID:${storageEpochMaxBytesEnv}`);
      }
      env.runtimeConfig.storage = {
        ...(env.runtimeConfig.storage || {}),
        epochMaxBytes,
      };
    }
    const storageSnapshotPeriodEnv = readRuntimeEnv('XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES');
    if (storageSnapshotPeriodEnv !== undefined && env.runtimeConfig.storage?.snapshotPeriodFrames === undefined) {
      const snapshotPeriodFrames = Number(storageSnapshotPeriodEnv);
      if (!Number.isSafeInteger(snapshotPeriodFrames) || snapshotPeriodFrames < 1) {
        throw new Error(`RUNTIME_CONFIG_STORAGE_SNAPSHOT_PERIOD_FRAMES_INVALID:${storageSnapshotPeriodEnv}`);
      }
      env.runtimeConfig.storage = {
        ...(env.runtimeConfig.storage || {}),
        snapshotPeriodFrames,
      };
    }
    const configuredSnapshotInterval = env.runtimeConfig.snapshotIntervalFrames;
    if (!Number.isFinite(configuredSnapshotInterval ?? NaN) || (configuredSnapshotInterval ?? 0) < 1) {
      env.runtimeConfig.snapshotIntervalFrames = DEFAULT_SNAPSHOT_INTERVAL_FRAMES;
    }
    return env.runtimeConfig;
  };

  const getRuntimeStorageDbDeps = (): RuntimeStorageDbDeps => ({
    ensureRuntimeState,
  });

  const getRuntimeStorageDb = (env: Env, role: StorageDbRole = 'current'): Level<Buffer, Buffer> =>
    getStorageDb(env, role);

  const getStorageDb = (env: Env, role: StorageDbRole = 'current'): Level<Buffer, Buffer> =>
    runtimeDbs.getStorageDb(env, getRuntimeStorageDbDeps(), role);

  const getInfraDb = (env: Env): Level<Buffer, Buffer> => runtimeDbs.getInfraDb(env, getRuntimeStorageDbDeps());

  const getFrameDb = (env: Env): Level<Buffer, Buffer> => runtimeDbs.getFrameDb(env, getRuntimeStorageDbDeps());

  const tryOpenStorageDb = (env: Env, role: StorageDbRole = 'current'): Promise<boolean> =>
    runtimeDbs.tryOpenStorageDb(env, getRuntimeStorageDbDeps(), role);

  const rotateStorageEpochDb = (env: Env, snapshotHeight: number, timestamp = env.timestamp): Promise<boolean> =>
    runtimeDbs.rotateStorageEpochDb(env, getRuntimeStorageDbDeps(), snapshotHeight, timestamp);

  const tryOpenFrameDb = (env: Env): Promise<boolean> => runtimeDbs.tryOpenFrameDb(env, getRuntimeStorageDbDeps());

  const throwSettledErrors = (results: PromiseSettledResult<unknown>[], code: string): void => {
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, code);
  };

  const closeRuntimeDb = async (env: Env): Promise<void> => {
    await stopJurisdictionWatchersAndWait(env);
    const shutdown = await Promise.allSettled([
      stopRuntimeLoopAndWait(env, 10_000).then(stopped => {
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
    ]);
    throwSettledErrors(closed, 'RUNTIME_DB_CLOSE_FAILED');
  };

  const closeInfraDb = async (env: Env): Promise<void> => {
    const state = ensureRuntimeState(env);
    state.infraDbClosing = true;
    await drainInfraDbWrites(env);
    await runtimeDbs.closeInfraDb(env);
  };

  const waitForRuntimeLoopWake = async (env: Env): Promise<void> => {
    const state = ensureRuntimeState(env);
    if (state.wakeRequested) {
      state.wakeRequested = false;
      return;
    }
    await new Promise<void>(resolve => {
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
    return await new Promise<'wake' | 'timeout'>(resolve => {
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
  ) => asserts condition = (condition: unknown, code: string, message: string, details?: Record<string, unknown>) => {
    if (condition) return;
    const detailText = details ? ` ${safeStringify(details)}` : '';
    throw new Error(`${code}: ${message}${detailText}`);
  };

  const getCleanLogs = (env: Env): string => getRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

  const clearCleanLogs = (env: Env): void => clearRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

  const copyCleanLogs = async (env: Env): Promise<string> => copyRuntimeCleanLogs(env, getRuntimeCleanLogDeps());

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
  ): void =>
    enqueueRuntimeInputs(env, inputs, runtimeTxs, jInputs, explicitTimestamp, reliableReceipts, {
      acceptedBeforeQuiesce: true,
    });

  function getRuntimeInputQueueDeps(): RuntimeInputQueueDeps {
    return {
      ensureRuntimeState,
      requestRuntimeLoopWake,
    };
  }

  async function tryOpenInfraDb(env: Env): Promise<boolean> {
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
            (error.message?.includes('blocked') ||
              error.name === 'SecurityError' ||
              error.name === 'InvalidStateError');
          if (isBlocked) {
            runtimeLog.warn('infra_db.blocked_in_memory', {
              error: error instanceof Error ? error.message : String(error),
            });
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

  const hasRuntimeWork = (env: Env): boolean => getRuntimeWorkReason(env) !== null;

  const collectAccountMempoolWakeInputs = (env: Env): EntityInput[] => {
    const wakeInputs: EntityInput[] = [];
    for (const replica of env.eReplicas?.values?.() ?? []) {
      const entityId = String(replica?.entityId || replica?.state?.entityId || '')
        .trim()
        .toLowerCase();
      const signerId = String(replica?.signerId || '')
        .trim()
        .toLowerCase();
      if (!entityId || !signerId) continue;
      const accounts = replica?.state?.accounts;
      if (!(accounts instanceof Map)) continue;
      const hasAccountMempool = Array.from(accounts.values()).some(account =>
        accountHasProposableMempool(account, replica.state),
      );
      if (!hasAccountMempool) continue;
      wakeInputs.push({ entityId, signerId, entityTxs: [] });
    }
    return wakeInputs;
  };

  const entityJPrefixReadyForWake = (replica: EntityReplica): boolean => {
    const prefixNeeded =
      entityRequiresJPrefixCertificate(replica.state) || hasPendingLocalJEvent(replica.state, replica.jHistory);
    if (!prefixNeeded || replica.jPrefixRound?.certificate) return true;
    if (hasCurrentRoundJPrefixAttestation(replica)) return false;
    return Boolean(replica.jHistory && getLocalJPrefixAttestableHeight(replica.state, replica.jHistory) !== null);
  };

  const entityMempoolNeedsWake = (replica: EntityReplica): boolean =>
    isEntityActiveLeader(replica) &&
    entityJPrefixReadyForWake(replica) &&
    (replica.mempool.length > 0 ||
      Boolean(
        replica.jPrefixRound?.certificate &&
        replica.jPrefixRound.certificate.selected.scannedThroughHeight > replica.state.lastFinalizedJHeight,
      ) ||
      isFrozenBaseJPrefixRollAuthorized(replica, replica.jPrefixRound?.certificate)) &&
    !replica.proposal &&
    !replica.lockedFrame;

  const collectEntityMempoolWakeInputs = (env: Env): EntityInput[] => {
    const wakeInputs: EntityInput[] = [];
    for (const replica of env.eReplicas?.values?.() ?? []) {
      if (!entityMempoolNeedsWake(replica)) continue;
      const entityId = String(replica.entityId || replica.state?.entityId || '')
        .trim()
        .toLowerCase();
      const signerId = String(replica.signerId || '')
        .trim()
        .toLowerCase();
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

  const prioritizeJEventFrame = (runtimeInput: RuntimeInput, mempool: RuntimeInput, timestamp: number): boolean => {
    const priorityInputs: EntityInput[] = [];
    const deferredInputs: EntityInput[] = [];

    for (const input of runtimeInput.entityInputs) {
      const entityTxs = input.entityTxs ?? [];
      const jEventTxs = entityTxs.filter(tx => tx?.type === 'j_event');
      const otherTxs = entityTxs.filter(tx => tx?.type !== 'j_event');
      const hasNonTxPayload =
        !!input.proposedFrame ||
        !!input.hashPrecommitFrame ||
        (!!input.hashPrecommits && input.hashPrecommits.size > 0) ||
        (!!input.jPrefixAttestations && input.jPrefixAttestations.size > 0) ||
        !!input.leaderTimeoutVote;

      if (jEventTxs.length > 0) {
        // Consensus lanes are not Entity transactions. If a mixed envelope is
        // split at the J-event barrier, those lanes must remain exclusively on
        // the deferred copy or the next Runtime frame would replay them.
        const {
          proposedFrame: _proposedFrame,
          hashPrecommitFrame: _hashPrecommitFrame,
          hashPrecommits: _hashPrecommits,
          jPrefixAttestations: _jPrefixAttestations,
          leaderTimeoutVote: _leaderTimeoutVote,
          ...transactionLane
        } = input;
        priorityInputs.push({ ...transactionLane, entityTxs: jEventTxs });
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

  const hasDueEntityHooks = (env: Env): boolean => hasDueEntityHooksWithDeps(env, getRuntimeWakeDeps());

  const getEarliestWallClockDueTimestamp = (env: Env): number | null =>
    getEarliestWallClockDueTimestampWithDeps(env, getRuntimeWakeDeps());

  const getNextWallClockWakeTimestamp = (env: Env): number | null => {
    const entityDueAt = getNextWallClockWakeTimestampWithDeps(env, getRuntimeWakeDeps());
    const networkDueAt = getNextNetworkRetryTimestamp(env, getRuntimeOutputRoutingDeps());
    if (entityDueAt === null) return networkDueAt;
    if (networkDueAt === null) return entityDueAt;
    return Math.min(entityDueAt, networkDueAt);
  };

  const generateHookPings = (env: Env, nowMs = getRuntimeNowMs(env), queuedAt = env.timestamp ?? 0): void => {
    // Quiesce drains only work accepted before its ingress fence. Scheduled
    // hooks remain durable for resume and must not extend the shutdown drain.
    if (env.runtimeState?.persistenceQuiescing) return;
    generateHookPingsWithDeps(env, getRuntimeWakeDeps(), nowMs, queuedAt);
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
    if (error instanceof RuntimeEntityInputApplyError) {
      return error.isQuarantinableRemoteIngress ? 'REMOTE_ENTITY_INPUT_APPLY_FAILED' : null;
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
    state.quarantinedRuntimeInputs = [...(state.quarantinedRuntimeInputs ?? []), record].slice(
      -MAX_RUNTIME_INPUT_QUARANTINE_RECORDS,
    );
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
  type RuntimeLoopConfig = {
    tickDelayMs?: number;
    maxEntityInputsPerFrame?: number;
    maxEntityTxsPerFrame?: number;
    onFatal?: (payload: { code: string; message: string; height: number; timestamp: number }) => void | Promise<void>;
  };

  function startRuntimeLoop(env: Env, config?: RuntimeLoopConfig): () => void {
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
            transitionRuntimeLifecycle(state, 'halted');
            state.fatalDebugPayload = {
              message,
              ...(stack ? { stack } : {}),
              height: Math.max(0, env.height ?? 0),
              timestamp: Math.max(0, env.timestamp ?? 0),
            };
            if (config?.onFatal) {
              try {
                await config.onFatal({
                  code: normalizeRuntimeFailureCode(message),
                  message,
                  height: Math.max(0, env.height ?? 0),
                  timestamp: Math.max(0, env.timestamp ?? 0),
                });
              } catch (reportError) {
                runtimeLog.error('loop.fatal_report_failed', {
                  error: reportError instanceof Error ? reportError.message : String(reportError),
                });
              }
            }
            runtimeLog.error('loop.error', { message, ...(stack ? { stack } : {}) });
            emitRuntimeLoopError(env, 'RUNTIME_LOOP_ERROR', {
              message,
              ...(stack ? { stack } : {}),
            });
            const runtimeProcess = getRuntimeProcessGlobal();
            if (runtimeProcess?.exit) {
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
            const waitResult = await waitForRuntimeLoopWakeOrTimeout(env, Math.max(0, nextDueAt - getWallClockMs()));
            if (waitResult === 'timeout') {
              const dueTimestamp = getEarliestWallClockDueTimestamp(env) ?? nextDueAt;
              const mempool = ensureRuntimeMempool(env);
              mempool.queuedAt =
                mempool.queuedAt === undefined ? dueTimestamp : Math.max(mempool.queuedAt, dueTimestamp);
              generateHookPings(env, dueTimestamp, dueTimestamp);
            }
            continue;
          }
          await waitForRuntimeLoopWake(env);
        }
      } finally {
        if (haltedMessage) {
          emitRuntimeLoopError(env, 'RUNTIME_LOOP_HALTED', { message: haltedMessage });
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

  const waitForPromiseBeforeTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      promise.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  const stopRuntimeLoopAndWait = async (env: Env, timeoutMs = 10_000): Promise<boolean> => {
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

  const resumeRuntimeLoop = (env: Env, config?: RuntimeLoopConfig): (() => void) => {
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
  const resumeRuntimeAfterPersistenceQuiesce = (env: Env, config?: RuntimeLoopConfig): (() => void) => {
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

  const waitForRuntimeWorkDrained = async (
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
          processing.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), Math.min(remaining, 250))),
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

  const startJurisdictionWatchers = (env: Env): void => {
    // Quiesce closes ingress before it drains accepted work. The still-running
    // runtime loop may reach this function once more while draining; it must not
    // resurrect a watcher that quiesce has already stopped.
    if (env.runtimeState?.persistenceQuiescing) return;
    if (!env.jReplicas || env.jReplicas.size === 0) return;
    const watcherOwners = new Map<string, JAdapter>();
    const providerUrlOf = (adapter: JAdapter, replica: JReplica): string => {
      const configured = replica.rpcs?.find(rpc => typeof rpc === 'string' && rpc.trim().length > 0);
      if (configured) return configured.trim();
      const providerWithConnection = adapter.provider as Provider & {
        _getConnection?: () => { url?: string };
      };
      return String(providerWithConnection?._getConnection?.()?.url || '').trim();
    };
    const watcherKeyOf = (replica: JReplica): string | null => {
      const adapter = replica.jadapter;
      if (!adapter) return null;
      const depository = String(replica.depositoryAddress || replica.contracts?.depository || '')
        .trim()
        .toLowerCase();
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

  const stopJurisdictionWatchers = (env: Env): void => {
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

  const stopJurisdictionWatchersAndWait = async (env: Env): Promise<void> => {
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
  const getEnv = (env?: Env | null): Env | null => {
    if (!env) {
      runtimeLog.warn('env.missing');
      return null;
    }
    return env;
  };

  const setRuntimeId = (env: Env, id: string | null): void => {
    const normalizedRuntimeId = normalizeRuntimeId(id);
    if (normalizedRuntimeId) env.runtimeId = normalizedRuntimeId;
    else delete env.runtimeId;
    if (env.runtimeId) {
      env.dbNamespace = normalizeDbNamespace(env.runtimeId);
    }
    startPendingRuntimeP2PIfReady(env, getRuntimeP2PLifecycleDeps());
  };

  // Derive runtimeId from seed (for isolated envs that need to set their own runtimeId)
  const deriveRuntimeId = (seed: string): string => {
    return normalizeRuntimeId(deriveSignerAddressSync(seed, '1'));
  };

  // scheduleNetworkProcess removed — loop is always-on via startRuntimeLoop()

  const registerEntityRuntimeHint = (env: Env, entityId: string, runtimeId: string): void => {
    registerEntityRuntimeHintWithDeps(env, entityId, runtimeId, getRuntimeEntityRoutingDeps());
  };

  const MAX_RUNTIME_J_INPUTS = 256;
  const MAX_RUNTIME_J_TXS = 1_024;
  const MAX_RUNTIME_J_TXS_PER_JURISDICTION = 512;
  const MAX_RUNTIME_J_INPUT_BYTES = 1024 * 1024;

  const validateRuntimeJIngressLimits = (env: Env, runtimeInput: RuntimeInput): void => {
    if (runtimeInput.jInputs === undefined) return;
    if (!Array.isArray(runtimeInput.jInputs)) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Invalid jInputs: expected array, got ${typeof runtimeInput.jInputs}`,
      );
    }
    if (runtimeInput.jInputs.length > MAX_RUNTIME_J_INPUTS) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Too many J inputs: ${runtimeInput.jInputs.length} > ${MAX_RUNTIME_J_INPUTS}`,
      );
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
        throw new Error(
          `RUNTIME_INPUT_ADMISSION_REJECTED: Too many J transactions: ${totalTxs} > ${MAX_RUNTIME_J_TXS}`,
        );
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
        throw new Error(
          `RUNTIME_INPUT_ADMISSION_REJECTED: J payload too large: ${totalBytes} > ${MAX_RUNTIME_J_INPUT_BYTES}`,
        );
      }
    }
  };

  type RuntimeFrameIngressEntry = RuntimeFrameIngressBuffer['entries'][number];

  const beginRuntimeFrameIngressBuffer = (env: Env): RuntimeFrameIngressBuffer => {
    const state = ensureRuntimeState(env);
    if (state.runtimeFrameIngressBuffer) {
      throw new Error(`RUNTIME_FRAME_INGRESS_BUFFER_ALREADY_ACTIVE:${state.runtimeFrameIngressBuffer.status}`);
    }
    const buffer: RuntimeFrameIngressBuffer = {
      status: 'active',
      entries: [],
    };
    state.runtimeFrameIngressBuffer = buffer;
    return buffer;
  };

  const getRuntimeFrameIngressBuffer = (env: Env): RuntimeFrameIngressBuffer | undefined => {
    const buffer = env.runtimeState?.runtimeFrameIngressBuffer;
    if (buffer && buffer.status !== 'active') {
      throw new Error(`RUNTIME_FRAME_INGRESS_BUFFER_INVALID_LIFECYCLE:${buffer.status}`);
    }
    return buffer;
  };

  const appendRuntimeFrameIngress = (buffer: RuntimeFrameIngressBuffer, entry: RuntimeFrameIngressEntry): void => {
    buffer.entries.push(structuredClone(entry));
  };

  const handleInboundP2PEntityInput = (env: Env, from: string, input: RoutedEntityInput, ingressTimestamp?: number) => {
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

  const handleInboundP2PEntityInputs = (
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

  const handleInboundReliableReceipt = (
    env: Env,
    from: string,
    receipt: ReliableDeliveryReceipt,
    options: RuntimeInboundEntityInputOptions = {},
  ): 'queued' | 'duplicate' | 'deferred' => {
    const sourceRuntimeId = normalizeRuntimeId(from);
    if (!sourceRuntimeId || sourceRuntimeId !== receipt?.body?.receiverRuntimeId) {
      throw new Error('RELIABLE_RECEIPT_TRANSPORT_SOURCE_MISMATCH');
    }
    if (env.runtimeState?.persistenceQuiescing && !env.scenarioMode && options.acceptedBeforeQuiesce !== true) {
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
    enqueueRuntimeInputs(env, undefined, undefined, undefined, env.timestamp, [receipt], options);
    return 'queued';
  };

  const dispatchRuntimeReliableReceipt = (env: Env, runtimeId: string, receipt: ReliableDeliveryReceipt): void => {
    const state = ensureRuntimeState(env);
    const directResult = state.directReliableReceiptDispatch?.(runtimeId, receipt);
    const result =
      directResult && isDeliveryDelivered(directResult)
        ? directResult
        : (getP2P(env)?.enqueueReliableReceiptDelivery(runtimeId, receipt) ?? directResult);
    if (!result || !isDeliveryDelivered(result)) {
      env.warn('network', 'RELIABLE_RECEIPT_SEND_DEFERRED', {
        targetRuntimeId: runtimeId,
        delivery: result ?? null,
      });
    }
  };

  const describeRuntimeFrameIngressErrors = (errors: readonly Error[]): string =>
    errors.map((error, index) => `${index + 1}/${errors.length}:${error.name}:${error.message}`).join('|');

  const drainRuntimeFrameIngressBuffer = (transaction: RuntimeFrameIngressTransaction): void => {
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
    const deps = getRuntimeEntityRoutingDeps();
    const errors: Error[] = [];
    try {
      for (const ingress of entries) {
        try {
          if (ingress.kind === 'receipt') {
            handleInboundReliableReceipt(env, ingress.from, ingress.receipt, { acceptedBeforeQuiesce: true });
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
    return getLocalSignerIdsForEntity(env, entityId).some(
      localSignerId => localSignerId.toLowerCase() === targetSignerId,
    );
  };

  const resolveSoleLocalSignerForEntity = (env: Env, entityId: string): string | null => {
    const signerIds = getLocalSignerIdsForEntity(env, entityId);
    return signerIds.length === 1 ? signerIds[0]! : null;
  };

  const validateRuntimeInputAdmission = (env: Env, runtimeInput: RuntimeInput): void => {
    assertRuntimeCommandReady(env);
    if (!runtimeInput) {
      throw new Error('RUNTIME_INPUT_ADMISSION_REJECTED: Null runtime input provided');
    }
    if (!Array.isArray(runtimeInput.runtimeTxs)) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Invalid runtimeTxs: expected array, got ${typeof runtimeInput.runtimeTxs}`,
      );
    }
    if (!Array.isArray(runtimeInput.entityInputs)) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Invalid entityInputs: expected array, got ${typeof runtimeInput.entityInputs}`,
      );
    }
    if (runtimeInput.reliableReceipts !== undefined && !Array.isArray(runtimeInput.reliableReceipts)) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Invalid reliableReceipts: expected array, got ${typeof runtimeInput.reliableReceipts}`,
      );
    }
    validateRuntimeJIngressLimits(env, runtimeInput);
    if (runtimeInput.runtimeTxs.length > 1000) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Too many runtime transactions: ${runtimeInput.runtimeTxs.length} > 1000`,
      );
    }
    if (runtimeInput.entityInputs.length > 10000) {
      throw new Error(
        `RUNTIME_INPUT_ADMISSION_REJECTED: Too many entity inputs: ${runtimeInput.entityInputs.length} > 10000`,
      );
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
      )
        return;
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
        enqueueRuntimeInputs(env, inputs, runtimeTxs, jInputs, ingressTimestamp, undefined, options),
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

  const sendEntityInput = (env: Env, input: RoutedEntityInput): RuntimeEntityInputRoutingResult => {
    return sendEntityInputWithRouting(env, input, getRuntimeOutputRoutingDeps());
  };

  const startP2P = (env: Env, config: P2PConfig = {}) => startRuntimeP2P(env, config, getRuntimeP2PLifecycleDeps());

  const stopP2P = (env: Env): void => stopRuntimeP2P(env, getRuntimeP2PLifecycleDeps());

  const stopP2PAndWait = (env: Env, timeoutMs?: number): Promise<void> =>
    stopRuntimeP2PAndWait(env, getRuntimeP2PLifecycleDeps(), timeoutMs);

  const getP2P = (env: Env) => getRuntimeP2P(env, getRuntimeP2PLifecycleDeps());

  const getP2PState = (env: Env): P2PConnectionState => getRuntimeP2PState(env, getRuntimeP2PLifecycleDeps());

  const refreshGossip = (env: Env): void => refreshRuntimeGossip(env, getRuntimeP2PLifecycleDeps());

  const ensureGossipProfiles = async (env: Env, entityIds: string[]): Promise<boolean> =>
    ensureRuntimeGossipProfiles(env, getRuntimeP2PLifecycleDeps(), entityIds);

  const clearGossip = async (env: Env, options: { runtimeId?: string } = {}): Promise<void> => {
    // Restoring infra gossip announces every loaded profile and queues its
    // LevelDB write. Drain those puts before deleting the relocated route or a
    // late put can resurrect the old signed endpoint after the clear completes.
    await drainInfraDbWrites(env);
    await clearInfraGossipProfiles(env, infraGossipDbAccess, options);
    const targetRuntimeId = String(options.runtimeId || '')
      .trim()
      .toLowerCase();
    if (!targetRuntimeId) {
      env.gossip?.profiles?.clear();
    } else {
      for (const [entityId, profile] of env.gossip?.profiles ?? []) {
        if (
          String(profile.runtimeId || '')
            .trim()
            .toLowerCase() === targetRuntimeId
        ) {
          env.gossip.profiles.delete(entityId);
        }
      }
    }
    notifyEnvChange(env);
  };

  /**
   * Create a runtime environment for frontend initialization.
   */

  return {
    registerEnvChangeCallback,
    registerRuntimeFrameCommitCallback,
    registerRecoveryBackupBarrier,
    ENV_APPLY_ALLOWED_KEY,
    ENV_REPLAY_MODE_KEY,
    envRecord,
    failfastAssert,
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
    validateRuntimeJIngressLimits,
    beginRuntimeFrameIngressBuffer,
    handleInboundP2PEntityInput,
    handleInboundP2PEntityInputs,
    handleInboundReliableReceipt,
    describeRuntimeFrameIngressErrors,
    drainRuntimeFrameIngressBuffer,
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
  };
};
