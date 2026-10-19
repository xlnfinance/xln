import { BLOCKCHAIN } from '../../../../config/constants';
import type { RuntimeReplica } from '../../../../runtime/types';
import { isRuntimeMempoolCapacityError } from '../../../../runtime/mempool/input-queue';
import {
  nextWatcherPollWindow,
  nextWatcherRpcBackoffMs,
  watcherPollWindowLimit,
} from '../../watcher/observe/watcher-poll-policy';
import { isDebugEventEmitter } from '../../rpc-utils';
import { haltProcessForFatalWatcherError, watcherErrorDetails, watcherErrorMessage } from '../rpc-boundary';
import { rpcLog } from '../../rpc-public';
import { getMinimumScannedSignerJHeight, getWatcherStartBlock } from '../../watcher';
import { requireWatcherJurisdictionReplica } from '../../watcher/observe/watcher-replica';
import { runWatcherPoll } from './rpc-watcher-poll';
import { createWatchedErc20TokenReader } from '../../rpc-watcher-inputs';
import type {
  RpcWatcherControllerState,
  RpcWatcherMethods,
  RpcWatcherServices,
  RpcWatcherSession,
  RpcWatcherTrace,
} from './rpc-watcher-types';

const emitWatcherDebug = (session: RpcWatcherSession, payload: Record<string, unknown>): void => {
  const p2p = session.env.infrastructure?.p2p;
  if (!isDebugEventEmitter(p2p)) return;
  p2p.sendDebugEvent({
    level: 'info',
    code: 'J_WATCH_RPC',
    ...payload,
  });
};

export const resolveRpcWatcherPollMs = (configured: number | undefined): number => {
  if (configured === undefined) return BLOCKCHAIN.J_WATCHER_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error(`J_WATCHER_POLL_INTERVAL_INVALID:${String(configured)}`);
  }
  return configured;
};

const createWatcherSession = (
  env: RuntimeReplica,
  generation: number,
  services: RpcWatcherServices,
): RpcWatcherSession => {
  const startBlock = getWatcherStartBlock(env, services.depositoryAddress, services.chainId);
  const localScan = getMinimumScannedSignerJHeight(
    env,
    requireWatcherJurisdictionReplica(env, services.depositoryAddress, services.chainId, 'session-start'),
  );
  let session: RpcWatcherSession;
  const readWatchedErc20Tokens = createWatchedErc20TokenReader(
    services.getDepository(),
    calls => services.sendAuthenticatedBatch(calls),
    payload => emitWatcherDebug(session, payload),
  );
  session = {
    env,
    generation,
    interval: null,
    manualPolling: env.scenarioMode === true,
    confirmationDepth: services.resolveFinalityDepth(env.scenarioMode === true),
    pollMs: resolveRpcWatcherPollMs(services.watchPollMs),
    // Reuse the common authenticated suffix after restore; the first poll
    // audits its canonical anchor/frontier before applying or reporting it.
    lastSyncedBlock: Math.max(0, startBlock - 1, localScan ?? 0),
    scanProgress: { scannedThroughHeight: 0, replicaScannedThrough: {} },
    pendingBlocks: new Map(),
    pendingHistoryRange: null,
    pendingHistoryWaitKey: '',
    pendingRewindReplicaKeys: [],
    lastAuthorityAuditKey: '',
    lastObservedHead: -1,
    lastCanonicalAuditAtMs: 0,
    transientFailures: 0,
    lastTransientLogAtMs: 0,
    rpcCooldown: { backoffMs: 0, untilMs: 0, releaseWait: null },
    maxBlocksPerPoll: watcherPollWindowLimit(services.mode),
    txCounter: { value: 0, _seenLogs: { set: new Set<string>(), order: [] } },
    readWatchedErc20Tokens,
  };
  return session;
};

const buildFailurePayload = (
  services: RpcWatcherServices,
  session: RpcWatcherSession,
  trace: RpcWatcherTrace,
  message: string,
  error: unknown,
): Record<string, unknown> => ({
  event: 'j_watch_error',
  message,
  chainId: services.chainId,
  rpcUrl: services.rpcUrl,
  step: trace.step,
  fromBlock: trace.fromBlock,
  toBlock: trace.toBlock,
  lastSyncedBlock: session.lastSyncedBlock,
  error: watcherErrorDetails(error),
});

const handleTransientFailure = (
  services: RpcWatcherServices,
  session: RpcWatcherSession,
  trace: RpcWatcherTrace,
  message: string,
  error: unknown,
): void => {
  session.transientFailures += 1;
  const now = Date.now();
  if (session.transientFailures !== 1 && now - session.lastTransientLogAtMs < 10_000) return;
  session.lastTransientLogAtMs = now;
  emitWatcherDebug(session, {
    event: 'j_watch_transient_rpc_unavailable',
    message,
    chainId: services.chainId,
    rpcUrl: services.rpcUrl,
    step: trace.step,
    fromBlock: trace.fromBlock,
    toBlock: trace.toBlock,
    lastSyncedBlock: session.lastSyncedBlock,
    consecutiveFailures: session.transientFailures,
    error: watcherErrorDetails(error),
  });
  if (session.transientFailures >= 3) {
    console.warn(
      `[JAdapter:rpc] transient watcher RPC unavailable ` +
        `(chain=${services.chainId}, failures=${session.transientFailures}): ${message}`,
    );
  }
};

const handlePollFailure = (
  state: RpcWatcherControllerState,
  services: RpcWatcherServices,
  session: RpcWatcherSession,
  trace: RpcWatcherTrace,
  error: unknown,
): void => {
  const message = watcherErrorMessage(error);
  if (state.session !== session || state.generation !== session.generation) {
    emitWatcherDebug(session, {
      event: 'j_watch_shutdown_poll_aborted',
      message,
      chainId: services.chainId,
      rpcUrl: services.rpcUrl,
      step: trace.step,
      fromBlock: trace.fromBlock,
      toBlock: trace.toBlock,
      lastSyncedBlock: session.lastSyncedBlock,
    });
    return;
  }
  const transportUnavailable = services.isTransientRpcUnavailable(error);
  if (isRuntimeMempoolCapacityError(error) || transportUnavailable) {
    // Bound both ingress and transport pressure with the same window. A
    // throttled 2048-block read otherwise retries its entire prefix forever;
    // no cursor advances until a complete authenticated window is admitted.
    session.maxBlocksPerPoll = nextWatcherPollWindow(session.maxBlocksPerPoll, false);
    if (transportUnavailable) {
      session.rpcCooldown.backoffMs = nextWatcherRpcBackoffMs(session.rpcCooldown.backoffMs, false);
    }
    handleTransientFailure(services, session, trace, message, error);
    return;
  }
  const fatalPayload = buildFailurePayload(services, session, trace, message, error);
  emitWatcherDebug(session, fatalPayload);
  state.fatalError = message;
  if (session.interval) clearTimeout(session.interval);
  session.interval = null;
  state.lastScanProgress = session.scanProgress;
  state.session = null;
  emitWatcherDebug(session, { ...fatalPayload, event: 'j_watch_fatal_halt' });
  rpcLog.error('watcher.fatal_exit', fatalPayload);
  haltProcessForFatalWatcherError(fatalPayload);
};

const waitForRpcCooldown = (session: RpcWatcherSession): Promise<void> => {
  const delayMs = session.rpcCooldown.untilMs - performance.now();
  if (delayMs <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const release = (): void => {
      clearTimeout(timer);
      session.rpcCooldown.releaseWait = null;
      resolve();
    };
    const timer = setTimeout(release, delayMs);
    session.rpcCooldown.releaseWait = release;
  });
};

const pollOnce = (state: RpcWatcherControllerState, services: RpcWatcherServices): Promise<void> => {
  const session = state.session;
  if (!session) return Promise.resolve();
  if (state.inFlight) return state.inFlight;
  const trace: RpcWatcherTrace = {
    step: 'start',
    fromBlock: null,
    toBlock: null,
  };
  const isCancelled = (): boolean => state.session !== session || state.generation !== session.generation;
  // The single flight includes this wait; explicit pollNow drains cannot
  // bypass transport pressure or start another read while a retry is sleeping.
  const poll = waitForRpcCooldown(session)
    .then(async () => {
      if (isCancelled()) return;
      const before = session.lastSyncedBlock;
      await runWatcherPoll({
        session,
        services,
        trace,
        isCancelled,
        emitDebug: payload => emitWatcherDebug(session, payload),
      });
      if (!isCancelled() && session.lastSyncedBlock > before) {
        session.rpcCooldown.backoffMs = nextWatcherRpcBackoffMs(session.rpcCooldown.backoffMs, true);
      }
    })
    .catch(error => handlePollFailure(state, services, session, trace, error))
    .finally(() => {
      session.rpcCooldown.untilMs = performance.now() + session.rpcCooldown.backoffMs;
      state.inFlight = null;
    });
  state.inFlight = poll;
  return poll;
};

/**
 * Healthy catch-up stays immediate; idle polls use the configured interval.
 * pollOnce owns transport cooldown for this timer and explicit callers alike.
 */
const scheduleNextPoll = (
  state: RpcWatcherControllerState,
  services: RpcWatcherServices,
  session: RpcWatcherSession,
  delayMs: number,
): void => {
  session.interval = setTimeout(() => {
    if (state.session !== session || state.generation !== session.generation) return;
    const before = session.lastSyncedBlock;
    void pollOnce(state, services).finally(() => {
      if (state.session !== session || state.generation !== session.generation) return;
      const advanced = session.lastSyncedBlock > before;
      scheduleNextPoll(state, services, session, advanced ? 0 : session.pollMs);
    });
  }, delayMs);
};

/**
 * Owns external watcher lifecycle only. Runtime state remains the live ingress
 * target; single-flight and generation fences prevent a stopped poll from
 * writing after shutdown or into a later watcher session.
 */
export const createRpcWatcherController = (services: RpcWatcherServices): RpcWatcherMethods => {
  const state: RpcWatcherControllerState = {
    session: null,
    inFlight: null,
    fatalError: null,
    generation: 0,
    lastScanProgress: { scannedThroughHeight: 0, replicaScannedThrough: {} },
  };
  return {
    startWatching(env): void {
      services.assertStackBindingVerified();
      if (state.session) {
        rpcLog.debug('watcher.already_running', { chainId: services.chainId });
        return;
      }
      services.getDepository().removeAllListeners();
      services.getEntityProvider().removeAllListeners();
      state.generation += 1;
      const session = createWatcherSession(env, state.generation, services);
      state.lastScanProgress = session.scanProgress;
      state.session = session;
      if (state.fatalError) {
        emitWatcherDebug(session, {
          event: 'j_watch_fatal_already_halted',
          message: state.fatalError,
          lastSyncedBlock: session.lastSyncedBlock,
        });
        rpcLog.error('watcher.already_halted', { error: state.fatalError });
        return;
      }
      rpcLog.info('watcher.start', {
        chainId: services.chainId,
        pollMs: session.pollMs,
        depth: session.confirmationDepth,
        fromBlock: session.lastSyncedBlock + 1,
      });
      if (!session.manualPolling) {
        scheduleNextPoll(state, services, session, 0);
      }
      rpcLog.info('watcher.ready', {
        chainId: services.chainId,
        mode: session.manualPolling ? 'manual' : 'interval',
        pollMs: session.pollMs,
      });
    },

    async pollNow(): Promise<void> {
      await pollOnce(state, services);
    },

    isWatching(): boolean {
      return state.session !== null;
    },

    stopWatching(): void {
      const session = state.session;
      state.generation += 1;
      state.session = null;
      if (session?.interval) clearTimeout(session.interval);
      if (session) {
        session.interval = null;
        session.rpcCooldown.releaseWait?.();
        state.lastScanProgress = session.scanProgress;
      }
      rpcLog.info('watcher.stopped', { chainId: services.chainId });
    },

    async stopWatchingAndWait(): Promise<void> {
      const inFlight = state.inFlight;
      this.stopWatching();
      if (inFlight) await inFlight;
    },

    getWatcherScanProgress() {
      return state.session?.scanProgress ?? state.lastScanProgress;
    },
  };
};
