import { retainOperatorDiagnosticsAuthority } from '@xln/frontend/lib/debug/operator-target';
import { adoptActiveTabLock, initializeActiveTabLock } from '../../../frontend/src/lib/utils/control/activeTabLock';
import { closeRuntimeSession } from '../../../frontend/src/lib/security/runtimeSession';
import type {
  RuntimeAdapter,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
} from '@xln/core/api/runtime-adapter/types';
import type { RuntimeReplica } from '@xln/core/api/public/runtime-module';
import { getXLN } from './xln-loader';
import { useApp } from './store';
import { restoreFreshRuntime, type RuntimeRecoveryCandidate } from './restore';
import {
  listUnresolvedRemoteRuntimeCommandIntents,
  markRemoteRuntimeCommandIntentAccepted,
  resolveRemoteRuntimeCommandId,
  settleRemoteRuntimeCommandIntent,
  withRemoteRuntimeCommandReplayLease,
} from '@xln/frontend/lib/stores/commands/runtimeCommandIntent';
import { installRuntimeCommandJournalKeys } from '@xln/frontend/lib/stores/commands/runtimeCommandJournalKeyring';
import { runtimeHttpOriginFromWsUrl } from '@xln/frontend/lib/utils/runtime/wsUrl';
import {
  deployStack,
  fetchStackManagerStatus,
  type StackManagerDeployRequest,
} from '@xln/frontend/lib/components/Settings/stack-manager-client';

/**
 * Liveness is a host-observed fact the runtime asks its transport for. Every
 * entity this runtime hosts is reachable without a socket, so the embedded host
 * reports them online the same way the hub orchestrator reports its directly
 * connected peers. When a relay connection starts later, the runtime composes
 * relay presence with this direct set; without one, hosted peers are all it knows.
 */
function installHostedLivenessObserver(env: RuntimeReplica): void {
  const infrastructure = env.infrastructure ?? (env.infrastructure = {});
  const hosted = (entityIds: readonly string[]): ReadonlySet<string> => {
    const local = new Set(Array.from(env.state.eReplicas.values(), replica => replica.entityId.toLowerCase()));
    return new Set(entityIds.map(entityId => entityId.toLowerCase()).filter(entityId => local.has(entityId)));
  };
  infrastructure.observeDirectOnlineEntityIds = hosted;
  if (!infrastructure.observeOnlineEntityIds) infrastructure.observeOnlineEntityIds = hosted;
}

let currentAdapter: RuntimeAdapter | null = null;
let currentEnv: RuntimeReplica | null = null;
let detach: (() => void) | null = null;
let closing: Promise<void> | null = null;
let releaseOwnership: (() => void) | null = null;
// A capability belongs only to this authenticated connection, never persisted or exposed by inspection.
let remoteAdmin: { runtimeId: string; apiOrigin: string; capability: string } | null = null;

export function getAdapter(): RuntimeAdapter | null {
  return currentAdapter;
}

/** Live env of the embedded runtime; null in remote mode. */
export function getEmbeddedEnv(): RuntimeReplica | null {
  return currentEnv;
}

function attach(adapter: RuntimeAdapter, endpoint = 'embedded'): void {
  let confirmedTarget = '';
  const push = (): void => {
    confirmedTarget = retainOperatorDiagnosticsAuthority(
      { mode: adapter.mode, authLevel: adapter.authLevel, runtimeId: adapter.runtimeId, endpoint },
      confirmedTarget,
    );
    useApp.getState().setAdapterState({
      status: adapter.status,
      height: adapter.currentHeight,
      commandReady: adapter.commandReady,
      commandReadyReason: adapter.commandReadyReason,
      operatorRuntimeId: confirmedTarget ? adapter.runtimeId : '',
    });
  };
  const offChange = adapter.onChange(() => push());
  const offStatus = adapter.onStatus(() => push());
  detach = () => {
    offChange();
    offStatus();
  };
  push();
}

export function disconnectAdapter(): void {
  detach?.();
  detach = null;
  currentAdapter?.disconnect();
  currentAdapter = null;
  currentEnv = null;
  remoteAdmin = null;
  // Entity selection belongs to this connection; a new adapter must not inherit its authority context.
  useApp.getState().setActiveEntityId(null);
  useApp.getState().setAdapterState({
    status: 'disconnected',
    height: 0,
    commandReady: false,
    commandReadyReason: null,
    operatorRuntimeId: '',
  });
}

/** Stop accepted work before revoking the in-memory signing authority. */
export function lockEmbeddedRuntime(): Promise<void> {
  // Keep a failed close rejected until reload; adopting this lease again must
  // never bypass a Runtime that failed to quiesce.
  if (!closing)
    closing = closeAndLockRuntime().then(() => {
      closing = null;
    });
  return closing;
}

async function closeAndLockRuntime(): Promise<void> {
  const env = currentEnv;
  const seed = env?.runtimeSeed;
  disconnectAdapter();
  useApp.getState().lockAll();
  if (env) {
    const xln = await getXLN();
    try {
      await closeRuntimeSession(env, xln);
    } finally {
      if (seed) xln.clearSignerKeys(seed);
      env.runtimeSeed = undefined;
    }
  }
  // A failed drain retains the lease: a second Runtime must not sign against
  // the same namespace until all accepted work and database handles are closed.
  releaseOwnership?.();
  releaseOwnership = null;
}

/** `runtimeId` is the caller's already-derived numeric signer 1 address for `seed`. */
export async function connectEmbedded(
  seed: string,
  runtimeId: string,
  recovery?: RuntimeRecoveryCandidate,
): Promise<RuntimeAdapter> {
  await closing;
  const xln = await getXLN();
  if (recovery && currentEnv) throw new Error('Close this wallet and reload before restoring on a clean device.');
  disconnectAdapter();

  let env: RuntimeReplica | null = null;
  const adapter = new xln.EmbeddedRuntimeAdapter({
    getEnv: () => env,
    main: async (runtimeSeed?: string | null) => {
      // Serialize local bootstrap/import across tabs before either opens storage.
      // bootHostedVault registers every signer this wallet uses before boot;
      // further numeric signers derive lazily, so warm only the Runtime id.
      env = await navigator.locks.request(`xln-wallet-bootstrap:${runtimeId}`, () =>
        recovery
          ? restoreFreshRuntime(xln, seed, recovery)
          : xln.main(runtimeSeed ?? seed, { numericSignerPrewarmCount: 1, jCatchupFence: true }),
      );
      installHostedLivenessObserver(env);
      currentEnv = env;
      return env;
    },
    enqueueRuntimeInput: (target, input) => xln.enqueueRuntimeInput(target, input),
    validateRuntimeInputAdmission: (target, input) => xln.validateRuntimeInputAdmission(target, input),
    submitCrossJurisdictionIntent: async (target, route) => {
      await xln.submitCrossJurisdictionIntent(target, route);
      return { delivered: true as const };
    },
    controlRuntime: async (target, action) => {
      if (action !== 'verify-chain') throw new Error(`UNSUPPORTED_RUNTIME_CONTROL:${String(action)}`);
      return xln.verifyLiveRuntimeStorage(target);
    },
    registerRuntimePublishedCallback: (target, cb) => xln.registerRuntimePublishedCallback(target, cb),
    buildReadContext: target => ({
      readHead: () => xln.readPersistedStorageHead(target),
      readFrame: (height: number) => xln.readPersistedStorageFrameRecord(target, height),
      listCheckpoints: () => xln.listPersistedCheckpointHeights(target),
      loadEntityState: (entityId: string, height: number) => xln.loadEntityStateFromStorageDb(target, entityId, height),
      loadEntityAccountDoc: (entityId: string, counterpartyId: string, height: number) =>
        xln.loadEntityAccountDocFromStorageDb(target, entityId, counterpartyId, height),
      loadEntityViewPages: (entityIds: readonly string[], height: number, query?: RuntimeAdapterReadQuery) =>
        xln.loadEntityViewPagesFromStorageDb(target, entityIds, height, query),
      loadEntityViewPage: (entityId: string, height: number, query: unknown) =>
        xln.loadEntityViewPageFromStorageDb(target, entityId, height, query as never),
      listEntityIdsAtHeight: (height: number) => xln.listPersistedEntityIdsAtHeight(target, height),
      readActivityPage: (opts: unknown) => xln.readPersistedRuntimeActivityPage(target, opts as never),
      readFrameReceipts: query =>
        xln.readRuntimeFrameReceipts(
          {
            latestHeight: () => xln.getPersistedLatestHeight(target),
            journals: (from, to) => xln.readPersistedRuntimeActivityJournals(target, from, to),
          },
          query,
        ),
      readAccountSwapHistoryPage: (entityId, counterpartyId, options) =>
        xln.readPersistedAccountSwapHistoryPage(target, entityId, counterpartyId, options),
      readAccountFrameHistory: (entityId: string, counterpartyId: string, limit: number) =>
        xln.readPersistedAccountFrameHistory(target, entityId, counterpartyId, limit),
      findPaymentRoutes: (query?: RuntimeAdapterReadQuery) => xln.findPaymentRoutes(target, query),
    }),
  });

  // Password authentication precedes this call. Reuse the observer's canonical
  // origin-wide lease; its takeover callback drains the previous signer before
  // the new Runtime may open storage or connect to the relay.
  const bootstrapFinished = Promise.withResolvers<void>();
  const relinquish = async (): Promise<void> => {
    // main() owns an opening Runtime before currentEnv is available. A takeover
    // during that await must wait for its owner to be able to drain and close it.
    await bootstrapFinished.promise;
    await lockEmbeddedRuntime();
  };
  releaseOwnership = adoptActiveTabLock(relinquish) ?? (await initializeActiveTabLock(relinquish));
  try {
    await adapter.connect({ mode: 'embedded', seed });
  } catch (error) {
    try {
      await lockEmbeddedRuntime();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'WALLET_BOOT_AND_CLEANUP_FAILED');
    }
    xln.clearSignerKeys(seed);
    throw error;
  } finally {
    bootstrapFinished.resolve();
  }
  currentAdapter = adapter;
  attach(adapter);
  return adapter;
}

export async function connectRemote(wsUrl: string, authKey?: string): Promise<RuntimeAdapter> {
  await closing;
  const xln = await getXLN();
  disconnectAdapter();

  const adapter = new xln.RemoteRuntimeAdapter();
  const config: RuntimeAdapterConfig = {
    mode: 'remote',
    wsUrl,
    ...(authKey ? { authKey } : {}),
  };
  await adapter.connect(config);
  currentAdapter = adapter;
  if (authKey && adapter.authLevel === 'admin') {
    remoteAdmin = { runtimeId: adapter.runtimeId, apiOrigin: runtimeHttpOriginFromWsUrl(wsUrl), capability: authKey };
  }
  attach(adapter, wsUrl);
  return adapter;
}

function requireRemoteAdmin() {
  if (
    !remoteAdmin ||
    currentAdapter?.mode !== 'remote' ||
    currentAdapter.status !== 'connected' ||
    currentAdapter.authLevel !== 'admin' ||
    currentAdapter.runtimeId !== remoteAdmin.runtimeId
  ) {
    throw new Error('Connect the hosting runtime with administrator access to deploy a stack.');
  }
  return remoteAdmin;
}

export function readRemoteStackManager(rpcUrl = '', signerId = '') {
  const session = requireRemoteAdmin();
  return fetchStackManagerStatus(session.apiOrigin, rpcUrl, signerId, session.capability);
}

export function deployRemoteStack(request: StackManagerDeployRequest) {
  const session = requireRemoteAdmin();
  return deployStack(session.apiOrigin, request, session.capability);
}

export type RuntimeAdapterInspection = Pick<
  RuntimeAdapter,
  | 'mode'
  | 'runtimeId'
  | 'serverFingerprint'
  | 'status'
  | 'currentHeight'
  | 'nextCommandSequence'
  | 'commandLaneKind'
  | 'authLevel'
  | 'commandReady'
  | 'commandReadyReason'
  | 'read'
>;

/** A metadata snapshot and bound reads, never the connection's command authority. */
function inspectAdapter(): RuntimeAdapterInspection | null {
  const adapter = currentAdapter;
  if (!adapter) return null;
  return Object.freeze({
    mode: adapter.mode,
    runtimeId: adapter.runtimeId,
    serverFingerprint: adapter.serverFingerprint,
    status: adapter.status,
    currentHeight: adapter.currentHeight,
    nextCommandSequence: adapter.nextCommandSequence,
    commandLaneKind: adapter.commandLaneKind,
    authLevel: adapter.authLevel,
    commandReady: adapter.commandReady,
    commandReadyReason: adapter.commandReadyReason,
    read: adapter.read.bind(adapter),
  });
}
/** Dev-only: lets the browser console and E2E debugging inspect committed data. */
declare const __XLN_UI_DIAGNOSTICS__: boolean;
if (import.meta.env.DEV || __XLN_UI_DIAGNOSTICS__) {
  (window as typeof window & { __xln?: Record<string, unknown> }).__xln = {
    adapter: inspectAdapter,
    env: () => currentEnv,
    xln: () => getXLN(),
    store: useApp,
    get runtimeConnectivity() {
      const env = currentEnv;
      const p2p = env?.infrastructure?.p2p;
      const config = env?.infrastructure?.lastP2PConfig;
      if (!env || !p2p || !config) return null;
      if (typeof env.runtimeId !== 'string' || !env.runtimeId) throw new Error('RUNTIME_CONNECTIVITY_IDENTITY_MISSING');
      if (!Array.isArray(config.relayUrls)) throw new Error('RUNTIME_CONNECTIVITY_RELAY_CONFIG_MISSING');
      // Return observations, never transport clients or mutating controls.
      return Object.freeze({
        runtimeId: env.runtimeId,
        matchesIdentity: p2p.matchesIdentity(env.runtimeId, config.signerId),
        connected: p2p.isConnected(),
        relayClientCount: p2p.getRelayClientCount(),
        relayUrls: Object.freeze([...config.relayUrls]),
      });
    },
    // The shipped local QA bundle exercises the same encrypted journal as
    // remote commands. Never expose its key installation on a public host.
    ...(['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
      ? {
          commandJournal: {
            installKeys: installRuntimeCommandJournalKeys,
            list: listUnresolvedRemoteRuntimeCommandIntents,
            resolveId: resolveRemoteRuntimeCommandId,
            markAccepted: markRemoteRuntimeCommandIntentAccepted,
            settle: settleRemoteRuntimeCommandIntent,
            withReplayLease: withRemoteRuntimeCommandReplayLease,
          },
        }
      : {}),
  };
}

export function requireAdapter(): RuntimeAdapter {
  if (!currentAdapter) throw new Error('Runtime is not connected');
  return currentAdapter;
}
