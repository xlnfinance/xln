import type {
  RuntimeAdapter,
  RuntimeReplica,
  XLNModule,
} from '../../../../core/api/public/runtime-module';
import type { WalletEmbeddedRuntimeResource } from '../../../packages/browser/src/wallet-embedded-runtime-session';
import { suspendWalletRuntimeActivity } from '../../../packages/browser/src/wallet-runtime-suspension';

const RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS = 10_000;

const describeRuntime = (env: RuntimeReplica): string =>
  `runtime=${String(env.runtimeId || 'unknown')};height=${String(env.state.height)}`;

const suspendRuntime = (
  xln: XLNModule,
  env: RuntimeReplica,
): Promise<void> => suspendWalletRuntimeActivity(env, {
  stopWatchers: target => xln.stopJurisdictionWatchersAndWait(target),
  waitForWorkDrained: (target, timeoutMs) => xln.waitForRuntimeWorkDrained(target, timeoutMs),
  stopRuntimeLoop: (target, timeoutMs) => xln.stopRuntimeLoopAndWait(target, timeoutMs),
  stopP2P: (target, timeoutMs) => xln.stopP2PAndWait(target, timeoutMs),
  describeTarget: describeRuntime,
}, { p2pShutdownTimeoutMs: RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS });

const createAdapter = (
  xln: XLNModule,
  env: RuntimeReplica,
): RuntimeAdapter => new xln.EmbeddedRuntimeAdapter({
  getEnv: () => env,
  validateRuntimeInputAdmission: (target, input) => xln.validateRuntimeInputAdmission(target, input),
  enqueueRuntimeInput: (target, input) => xln.enqueueRuntimeInput(target, input),
  submitCrossJurisdictionIntent: async (target, route) => {
    await xln.submitCrossJurisdictionIntent(target, route);
    return { delivered: true };
  },
  controlRuntime: (target, action) => {
    if (action !== 'verify-chain') throw new Error(`UNSUPPORTED_RUNTIME_CONTROL:${action}`);
    return xln.verifyLiveRuntimeStorage(target);
  },
  registerRuntimePublishedCallback: (target, callback) =>
    xln.registerRuntimePublishedCallback(target, callback),
  buildReadContext: target => ({
    readHead: () => xln.readPersistedStorageHead(target),
    readFrame: height => xln.readPersistedStorageFrameRecord(target, height),
    listCheckpoints: () => xln.listPersistedCheckpointHeights(target),
    loadEntityState: (entityId, height) => xln.loadEntityStateFromStorageDb(target, entityId, height),
    loadEntityAccountDoc: (entityId, counterpartyId, height) =>
      xln.loadEntityAccountDocFromStorageDb(target, entityId, counterpartyId, height),
    loadEntityViewPage: (entityId, height, query) =>
      xln.loadEntityViewPageFromStorageDb(target, entityId, height, query),
    listEntityIdsAtHeight: height => xln.listPersistedEntityIdsAtHeight(target, height),
    readActivityPage: options => xln.readPersistedRuntimeActivityPage(target, options),
    readAccountSwapHistoryPage: (entityId, counterpartyId, options) =>
      xln.readPersistedAccountSwapHistoryPage(target, entityId, counterpartyId, options),
  }),
});

export const fenceEmbeddedRuntimePageUnload = (
  xln: XLNModule,
  env: RuntimeReplica,
): void => {
  const failures: Error[] = [];
  try {
    xln.stopJurisdictionWatchers(env);
  } catch (error: unknown) {
    failures.push(new Error('RUNTIME_PAGE_UNLOAD_WATCHER_STOP_FAILED', { cause: error }));
  }
  try {
    xln.stopP2P(env);
  } catch (error: unknown) {
    failures.push(new Error('RUNTIME_PAGE_UNLOAD_P2P_STOP_FAILED', { cause: error }));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'RUNTIME_PAGE_UNLOAD_INGRESS_FENCE_FAILED');
  }
};

export const bootEmbeddedRuntimeAdapter = async (
  xln: XLNModule,
  onPageUnloadFence: (fence: () => void) => void,
): Promise<WalletEmbeddedRuntimeResource<RuntimeAdapter>> => {
  const env = await xln.main(null);
  const adapter = createAdapter(xln, env);
  await adapter.connect({
    mode: 'embedded',
    ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
  });
  const fence = () => fenceEmbeddedRuntimePageUnload(xln, env);
  onPageUnloadFence(fence);
  return {
    adapter,
    runtimeId: adapter.runtimeId,
    readHeight: () => adapter.currentHeight,
    subscribeHeight: listener => adapter.onChange(listener),
    subscribeStatus: listener => adapter.onStatus(listener),
    stop: async () => {
      adapter.disconnect();
      await suspendRuntime(xln, env);
      await xln.closeRuntimeDb(env);
      await xln.closeInfraDb(env);
      onPageUnloadFence(() => {});
    },
  };
};
