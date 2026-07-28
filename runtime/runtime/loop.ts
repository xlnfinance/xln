import type { Provider } from 'ethers';
import {
  yieldRuntimeIoTurn,
} from '../runtime/platform';
import { getWallClockMs } from './../utils';
import type { JAdapter } from './../jadapter';
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
} from '../runtime/p2p-lifecycle';
import { extractEntityId, extractSignerId } from './../ids';
import {
  MAX_PENDING_NETWORK_OUTPUTS,
  sendEntityInputWithRouting,
  type RuntimeEntityInputRoutingResult,
  type RuntimeOutputRoutingDeps,
} from '../runtime/output-routing';
import { runtimeInputRequiresOutboxCapacity } from '../runtime/admission';
import {
  MAX_RUNTIME_J_INPUT_BYTES,
  MAX_RUNTIME_J_INPUTS,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  validateRuntimeInputShapeAndLimits,
} from '../runtime/input-validation';
import {
  createRuntimeOutputRoutingDeps,
  registerEntityRuntimeHintWithDeps,
  validateInboundP2PEntityInput,
  validateInboundP2PEntityInputsEnvelope,
  type RuntimeInboundEntityInputOptions,
  type RuntimeInboundEntityInputsResult,
  type RuntimeEntityRoutingDeps,
} from '../runtime/entity-routing';
import {
  assertScheduledWakeTxAuthorized,
  deleteScheduledWakeIndex,
  rebuildScheduledWakeIndex,
} from '../runtime/scheduled-wake';
import {
  assertRuntimeCommandReady,
  inferRuntimeLifecyclePhase,
  transitionRuntimeLifecycle,
} from '../runtime/lifecycle';
import {
  requireRuntimeMempool,
  requestRuntimeLoopWake,
} from '../runtime/input-queue';
import { ensureRuntimeState } from '../runtime/runtime-state';
import { registerReliableReceiptIngress } from '../runtime/reliable-delivery';
import { safeStringify } from './../protocol/serialization';
import { validateEntityInput } from './../validation-utils';
import type {
  EntityInput,
  Env,
  JReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
  RuntimeInput,
} from './../types';
import { clearInfraGossipProfiles } from '../runtime/infra-gossip-store';
import {
  closeFrameDb,
  closeInfraDb,
  closeStorageDb,
  normalizeDbNamespace,
} from './../storage/runtime-dbs';
import { createStructuredLogger } from '../infra/logger';
import {
  ENV_APPLY_ALLOWED_KEY,
  ENV_REPLAY_MODE_KEY,
  ensureRuntimeConfig,
  envRecord,
  failfastAssert,
  registerEnvChangeCallback,
  registerRecoveryBackupBarrier,
  registerRuntimeFrameCommitCallback,
} from './loop-environment';
import {
  clearCleanLogs,
  copyCleanLogs,
  drainInfraDbWrites,
  enqueueRuntimeContinuation,
  enqueueRuntimeInputs,
  getCleanLogs,
  getRuntimeFrameDb,
  getRuntimeInfraDb,
  getRuntimeStorageDb,
  infraGossipDbAccess,
  rotateRuntimeStorageEpochDb,
  trackInfraDbWrite,
  tryOpenRuntimeFrameDb,
  tryOpenRuntimeInfraDb,
  tryOpenRuntimeStorageDb,
  waitForRuntimeLoopWake,
  waitForRuntimeLoopWakeOrTimeout,
} from './loop-infrastructure';
import {
  applyEntityInputFrameCap,
  applyEntityTxFrameCap,
  collectAccountMempoolWakeInputs,
  collectEntityMempoolWakeInputs,
  generateHookPings,
  getEarliestWallClockDueTimestamp,
  getRemainingRuntimeFrameDelayMs,
  isRuntimeFrameReady,
  prioritizeJEventFrame,
  resolveNextWallClockWakeTimestamp,
  resolveRuntimeWorkReason,
  type RuntimeWorkDeps,
} from './loop-work';
import {
  quarantineLiveRuntimeInput,
  RuntimeInputQuarantinedError,
} from './input-quarantine';

type RuntimeModule = typeof import('../runtime');

export type RuntimeLoopApiDeps = {
  notifyEnvChange(env: Env): void;
  processRuntime: RuntimeModule['processRuntime'];
  waitForRuntimeProcessingIdle: RuntimeModule['waitForRuntimeProcessingIdle'];
  getRuntimeProcessGlobal(): { exit?: (code: number) => unknown } | null;
  runtimeInputHasQueuedWork(input: RuntimeInput): boolean;
};

const runtimeLog = createStructuredLogger('runtime');

export const createRuntimeLoopApi = (deps: RuntimeLoopApiDeps) => {
  const { notifyEnvChange, processRuntime, waitForRuntimeProcessingIdle, getRuntimeProcessGlobal, runtimeInputHasQueuedWork } =
    deps;

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

  const closeManagedInfraDb = async (env: Env): Promise<void> => {
    const state = ensureRuntimeState(env);
    state.infraDbClosing = true;
    await drainInfraDbWrites(env);
    await closeInfraDb(env);
  };

  const runtimeWorkDeps: RuntimeWorkDeps = {
    runtimeInputHasQueuedWork,
    getOutputRoutingDeps: () => getRuntimeOutputRoutingDeps(),
  };
  const getRuntimeWorkReason = (env: Env): string | null =>
    resolveRuntimeWorkReason(env, runtimeWorkDeps);
  const hasRuntimeWork = (env: Env): boolean => getRuntimeWorkReason(env) !== null;
  const getNextWallClockWakeTimestamp = (env: Env): number | null =>
    resolveNextWallClockWakeTimestamp(env, runtimeWorkDeps);

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
              await processRuntime(env);
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
              const mempool = requireRuntimeMempool(env);
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
        await processRuntime(env);
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

  const handleInboundP2PEntityInput = (env: Env, from: string, input: RoutedEntityInput, ingressTimestamp?: number) => {
    const deps = getRuntimeEntityRoutingDeps();
    const validation = validateInboundP2PEntityInput(env, from, input, deps);
    if (validation.kind === 'ignored') return validation;
    // The transport boundary validates and appends to the one Runtime
    // mempool. Reliable frontier registration belongs to the isolated frame.
    deps.enqueueRuntimeInputs(env, [{ ...input, from }], undefined, undefined, ingressTimestamp);
    return { kind: 'queued' } as const;
  };

  const handleInboundP2PEntityInputs = (
    env: Env,
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp?: number,
  ): RuntimeInboundEntityInputsResult => {
    const deps = getRuntimeEntityRoutingDeps();
    const inputs = validateInboundP2PEntityInputsEnvelope(env, from, envelope, deps);
    if (inputs.length > 0) {
      // Validation stamps authenticated provenance on transported Entity
      // inputs, but intentionally leaves an accepted cross-j intent's locally
      // synthesized command untagged. Reapplying `from` here would turn that
      // local command into forbidden remote consensus input.
      deps.enqueueRuntimeInputs(
        env,
        inputs,
        undefined,
        undefined,
        ingressTimestamp,
      );
    }
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
      });
    }
    if (registration === 'duplicate') return 'duplicate';
    enqueueRuntimeInputs(env, undefined, undefined, undefined, env.timestamp, [receipt], options);
    return 'queued';
  };

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
    validateRuntimeInputShapeAndLimits(env, runtimeInput, message => {
      throw new Error(`RUNTIME_INPUT_ADMISSION_REJECTED: ${message}`);
    });
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
    getStorageDb: getRuntimeStorageDb,
    getInfraDb: getRuntimeInfraDb,
    getFrameDb: getRuntimeFrameDb,
    tryOpenStorageDb: tryOpenRuntimeStorageDb,
    rotateStorageEpochDb: rotateRuntimeStorageEpochDb,
    tryOpenFrameDb: tryOpenRuntimeFrameDb,
    closeRuntimeDb,
    closeInfraDb: closeManagedInfraDb,
    getCleanLogs,
    clearCleanLogs,
    copyCleanLogs,
    enqueueRuntimeInputs,
    enqueueRuntimeContinuation,
    tryOpenInfraDb: tryOpenRuntimeInfraDb,
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
  };
};
