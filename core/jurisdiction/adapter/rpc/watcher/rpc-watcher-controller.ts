import { BLOCKCHAIN } from '../../../../config/constants';
import type { RuntimeReplica } from '../../../../runtime/types';
import { isRuntimeMempoolCapacityError } from '../../../../runtime/mempool/input-queue';
import { nextWatcherPollWindow } from '../../watcher/observe/watcher-poll-policy';
import { isDebugEventEmitter } from '../../rpc-utils';
import {
  haltProcessForFatalWatcherError,
  watcherErrorDetails,
  watcherErrorMessage,
} from '../rpc-boundary';
import { rpcLog } from '../../rpc-public';
import { getWatcherStartBlock } from '../../watcher';
import { runWatcherPoll } from './rpc-watcher-poll';
import { createWatchedErc20TokenReader } from '../../rpc-watcher-inputs';
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
    pollMs: resolveRpcWatcherPollMs(services.watchPollMs),
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
    maxBlocksPerPoll: BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL,
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
  if (isRuntimeMempoolCapacityError(error)) {
    // A catch-up window can carry more runtime txs than the mempool holds.
    // Retry a smaller window once frames drain; never exit the process.
    session.maxBlocksPerPoll = nextWatcherPollWindow(session.maxBlocksPerPoll, false);
    handleTransientFailure(services, session, trace, message, error);
    return;
  }
  if (services.isTransientRpcUnavailable(error)) {
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
 * Drive the poll loop, fast while catching up and idle at the tip.
 *
 * One poll reads at most `J_WATCHER_MAX_BLOCKS_PER_POLL` blocks. Waiting the
 * full interval between those windows makes the initial scan take
 * `blocksBehind / windowSize * pollMs`, which on a chain of any age is longer
 * than a wallet is willing to wait to open: at 256 blocks a window and five
 * seconds between them, a chain 70,000 blocks along needs twenty-odd minutes
 * before the first screen can be drawn.
 *
 * So the next poll is scheduled immediately whenever the previous one actually
 * advanced the synced height, and at the normal interval as soon as it did not.
 * A watcher that stops making progress therefore falls straight back to idle
 * pacing instead of spinning against the node.
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
