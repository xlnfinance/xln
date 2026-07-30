import { BLOCKCHAIN } from '../config/constants';
import type { RuntimeState } from '../runtime/types';
import { isDebugEventEmitter } from './rpc-utils';
import {
  haltProcessForFatalWatcherError,
  watcherErrorDetails,
  watcherErrorMessage,
} from './rpc-boundary';
import { rpcLog } from './rpc-public';
import { getWatcherStartBlock } from './watcher';
import { runWatcherPoll } from './rpc-watcher-poll';
import { createWatchedErc20TokenReader } from './rpc-watcher-inputs';
import type {
  RpcWatcherControllerState,
  RpcWatcherMethods,
  RpcWatcherServices,
  RpcWatcherSession,
  RpcWatcherTrace,
} from './rpc-watcher-types';

const emitWatcherDebug = (
  session: RpcWatcherSession,
  payload: Record<string, unknown>,
): void => {
  const p2p = session.env.runtimeState?.p2p;
  if (!isDebugEventEmitter(p2p)) return;
  p2p.sendDebugEvent({
    level: 'info',
    code: 'J_WATCH_RPC',
    ...payload,
  });
};

const createWatcherSession = (
  env: RuntimeState,
  generation: number,
  services: RpcWatcherServices,
): RpcWatcherSession => {
  const startBlock = getWatcherStartBlock(
    env,
    services.depositoryAddress,
    services.chainId,
  );
  let session: RpcWatcherSession;
  const readWatchedErc20Tokens = createWatchedErc20TokenReader(
    services.getDepository(),
    payload => emitWatcherDebug(session, payload),
  );
  session = {
    env,
    generation,
    interval: null,
    manualPolling: env.scenarioMode === true,
    confirmationDepth: services.resolveFinalityDepth(env.scenarioMode === true),
    pollMs: BLOCKCHAIN.J_WATCHER_POLL_INTERVAL_MS,
    lastSyncedBlock: Math.max(0, startBlock - 1),
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
  if (
    session.transientFailures !== 1 &&
    now - session.lastTransientLogAtMs < 10_000
  ) return;
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
  if (services.isTransientRpcUnavailable(error)) {
    handleTransientFailure(services, session, trace, message, error);
    return;
  }
  const fatalPayload = buildFailurePayload(services, session, trace, message, error);
  emitWatcherDebug(session, fatalPayload);
  state.fatalError = message;
  if (session.interval) clearInterval(session.interval);
  session.interval = null;
  state.lastScanProgress = session.scanProgress;
  state.session = null;
  emitWatcherDebug(session, { ...fatalPayload, event: 'j_watch_fatal_halt' });
  rpcLog.error('watcher.fatal_exit', fatalPayload);
  haltProcessForFatalWatcherError(fatalPayload);
};

const pollOnce = (
  state: RpcWatcherControllerState,
  services: RpcWatcherServices,
): Promise<void> => {
  const session = state.session;
  if (!session) return Promise.resolve();
  if (state.inFlight) return state.inFlight;
  const trace: RpcWatcherTrace = {
    step: 'start',
    fromBlock: null,
    toBlock: null,
  };
  const isCancelled = (): boolean =>
    state.session !== session || state.generation !== session.generation;
  const poll = runWatcherPoll({
    session,
    services,
    trace,
    isCancelled,
    emitDebug: payload => emitWatcherDebug(session, payload),
  })
    .catch(error => handlePollFailure(state, services, session, trace, error))
    .finally(() => {
      state.inFlight = null;
    });
  state.inFlight = poll;
  return poll;
};

/**
 * Owns external watcher lifecycle only. Runtime state remains the live ingress
 * target; single-flight and generation fences prevent a stopped poll from
 * writing after shutdown or into a later watcher session.
 */
export const createRpcWatcherController = (
  services: RpcWatcherServices,
): RpcWatcherMethods => {
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
        session.interval = setInterval(() => {
          void pollOnce(state, services);
        }, session.pollMs);
        void pollOnce(state, services);
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
      if (session?.interval) clearInterval(session.interval);
      if (session) {
        session.interval = null;
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
