/**
 * XLN Unified Server
 *
 * Single entry point combining:
 * - XLN Runtime (always running)
 * - Static file serving (SPA)
 * - WebSocket relay (/relay)
 * - RPC for remote UI (/rpc)
 * - REST API (/api/*)
 *
 * Usage:
 *   bun runtime/server/index.ts                    # Server on :8080
 *   bun runtime/server/index.ts --port 9000        # Custom port
 */

import {
  main,
  enqueueRuntimeInput,
  validateRuntimeInputAdmission,
  startP2P,
  startRuntimeLoop,
  ensureGossipProfiles,
  registerEnvChangeCallback,
  registerRuntimeFrameCommitCallback,
  closeRuntimeDb,
  closeInfraDb,
} from '../runtime.ts';
import { readFileSync } from 'node:fs';
import { safeStringify, serializeTaggedJson } from '../protocol/serialization';
import type { RuntimeState, RuntimeEntityInputsEnvelope } from '../types';
import { createExternalWalletApi } from '../api/external-wallet-api';
import { maybeHandleQaRequest } from '../qa/api';
import { createJAdapter, createXlnJsonRpcProvider, type JAdapter } from '../jadapter';
import type { JAdapterConfig } from '../jadapter/types';
import {
  createMarketMakerServerState,
  resetMarketMakerServerState,
} from './market-maker-health';
import { serveRuntimeBundle, serveStatic } from './static-assets';
import { hasDaemonControlAuth, parseTaggedControlBody, requireDaemonControlAuth } from './auth';
import { isLocalOperatorRequest, resolveSocketPeerAddress } from './health-redaction';
import { listLocalControlEntities } from './control-entities';
import {
  getAccountState,
  getEntityReplicaById,
} from './entity-lookup';
import { createRuntimeIngressReceiptStore } from './ingress-receipts';
import {
  createRelayStore,
  pushDebugEvent,
  removeClient,
} from '../relay/store';
import { openRelayIncidentJournal } from '../relay/incident-journal';
import { maybeHandleRelayDebugRequest } from '../relay/debug-http';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from '../relay/router';
import { deserializeWsMessage, serializeWsMessage, type RuntimeWsMessage } from '../networking/ws-protocol';
import { createHelloChallengeRegistry } from '../networking/hello-challenge';
import { createLocalDeliveryHandler } from '../relay/local-delivery';
import { resolveJurisdictionsJsonPath } from '../jurisdiction/jurisdictions-path';
import { createStructuredLogger, registerStructuredLogSink, shortId } from '../infra/logger';
import { startParentLivenessWatch } from '../infra/parent-watch';
import {
  buildMarketSnapshotForReplica,
  type MarketSnapshotPayload,
} from '../relay/market-snapshot';
import { createMarketSubscriptionStack } from '../relay/market-subscriptions';
import {
  decodeMarketWireRequest,
  encodeMarketWireMessage,
  type MarketWireRequest,
} from '../relay/market-wire';
import {
  JSON_HEADERS,
  getErrorMessage,
  resolveRequiredAnvilRpc,
} from './utils';
import { ethers } from 'ethers';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
} from '../radapter/server';
import { decodeRuntimeAdapterRequest, runtimeAdapterMessageByteLength } from '../radapter/codec';
import {
  getRelayClientIp,
  hasConnectedEncryptedRelayClient,
  resolveRequestClientIp,
  sendEntityInputDirectViaRelaySocketDelivery,
  type RelaySocket,
} from './relay-direct';
import { createServerRpcMessageHandler } from './rpc-ws';
import {
  buildRuntimeJurisdictionsJson,
  readCanonicalJurisdictionsJson,
  updateJurisdictionsJson,
} from './jurisdictions';
import { createTokenCatalogController } from './token-catalog';
import { buildHubDiscoveryPayload } from './hub-discovery';
import { buildDebugEntitiesPayload, buildKnownProfileBundle } from './gossip-profiles';
import { maybeHandleDebugDumpsRequest } from './debug-dumps';
import { handleCreditRequest } from './credit-request';
import { handleLendingStateRequest } from './lending';
import { handleWatchtowerProxy } from './watchtower-proxy';
import { handleOffchainFaucet } from './offchain-faucet';
import { handleReserveFaucet } from './reserve-faucet';
import { handleRuntimeHealth, type RuntimeHealthCacheEntry } from './health-api';
import { handleRuntimeRpcProxy } from './rpc-proxy';
import { handleP2PControl } from './p2p-control';
import { handleRuntimeInputControl, handleRuntimeInputStatus } from './runtime-input-control';
import { handleSignerRegistration } from './signer-control';
import { fetchRpcCode, probeLocalAnvilContractStack } from './stack-probe';
import { handleRuntimeActivityRequest } from './activity-api';
import {
  createAssistantProxyFromEnv,
  resolveAssistantDirectClientIp,
  resolveAssistantRateClientId,
} from './assistant-proxy';
import { selectPredeployedJurisdiction } from './predeployed-jurisdiction';
import { getJurisdictionIdentityRef } from '../jurisdiction/jurisdiction-runtime';
import { readInheritedChildSecrets } from '../infra/child-secrets';
import { createLocalPairingController } from './local-pairing';
import { deriveSignerAddressSync } from '../account/crypto';
import { buildLocalRuntimeOwner, ensureLocalRuntimeOwner } from './local-runtime-owner';
import { dbRootPath } from '../runtime/platform';
import type { Server } from 'bun';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
let serverEnv: RuntimeState | null = null;
let serverStartupBarrier: Promise<void> = Promise.resolve();
let resolveServerStartupBarrier: (() => void) | null = null;
// Server encryption keypair now managed by relay-local-delivery.ts
const HEALTH_CACHE_TTL_MS = 10_000;
let cachedHealthResponse:
  | RuntimeHealthCacheEntry
  | null = null;
let cachedHealthInFlight: Promise<{ fullBody: string; publicBody: string }> | null = null;

let processGuardsInstalled = false;
const runtimeIngressReceipts = createRuntimeIngressReceiptStore();
const serverLog = createStructuredLogger('server');
const assistantProxy = createAssistantProxyFromEnv(serverLog);
const localPairingController = createLocalPairingController({
  ...(process.env['XLN_LOCAL_CONTROL_TOKEN'] ? { controlToken: process.env['XLN_LOCAL_CONTROL_TOKEN'] } : {}),
  ...(process.env['XLN_LOCAL_INSTANCE_ID'] ? { instanceId: process.env['XLN_LOCAL_INSTANCE_ID'] } : {}),
  ...(process.env['XLN_DISTRIBUTION_VERSION'] ? { version: process.env['XLN_DISTRIBUTION_VERSION'] } : {}),
});
const tokenCatalogController = createTokenCatalogController({
  getAdapter: () => globalJAdapter,
});

const requireWatcherConfirmationDepth = (adapter: JAdapter): number => {
  const depth = adapter.getFinalityDepth?.();
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0) {
    throw new Error(`JADAPTER_WATCHER_CONFIRMATION_DEPTH_INVALID:${String(depth)}`);
  }
  return depth;
};

const STARTUP_STEP_TIMEOUT_MS = Math.max(
  5_000,
  Math.floor(Number(process.env['XLN_STARTUP_STEP_TIMEOUT_MS'] ?? '20000')),
);

const withStartupStepTimeout = async <T>(label: string, work: Promise<T>, timeoutMs = STARTUP_STEP_TIMEOUT_MS): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`[XLN] Startup step timed out: ${label} after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const isServerBootInProgress = (): boolean =>
  serverBootPhase === 'starting' || serverBootPhase === 'runtime' || serverBootPhase === 'bootstrap';

const oneShotLogs = new Map<string, number>();
const ONE_SHOT_TTL_MS = 60_000;
const logOneShot = (key: string, message: string, fields: Record<string, unknown> = {}) => {
  const nowMs = Date.now();
  const last = oneShotLogs.get(key) ?? 0;
  if (nowMs - last < ONE_SHOT_TTL_MS) return;
  oneShotLogs.set(key, nowMs);
  serverLog.warn(message, fields);
};

const currentRuntimeHeight = (env: RuntimeState | null): number =>
  Math.max(0, Math.floor(Number(env?.height ?? 0)));

const runtimeInputStatusUrl = (id: string): string =>
  `/api/control/runtime-input/${encodeURIComponent(id)}/status`;

const SERVER_RUNTIME_SEED = (() => {
  const seed = process.env['XLN_RUNTIME_SEED']?.trim();
  if (!seed) {
    throw new Error('XLN_RUNTIME_SEED is required for runtime/server/index.ts');
  }
  return seed;
})();
const STARTUP_SIGNER = (() => {
  const secrets = readInheritedChildSecrets();
  const seed = String(secrets['startupSignerSeed'] || '').trim();
  const label = String(secrets['startupSignerLabel'] || '').trim();
  if (Boolean(seed) !== Boolean(label)) {
    throw new Error('STARTUP_SIGNER_DERIVATION_INCOMPLETE');
  }
  return seed && label ? { seed, label } : null;
})();
const LOCAL_RUNTIME_OWNER = (() => {
  const label = String(process.env['XLN_LOCAL_OWNER_LABEL'] || '').trim();
  if (!label) return null;
  const profileName = String(process.env['XLN_LOCAL_OWNER_PROFILE_NAME'] || 'xln finance').trim();
  if (!profileName) throw new Error('XLN_LOCAL_OWNER_PROFILE_NAME_REQUIRED');
  return { label, profileName };
})();
const FAUCET_SIGNER_LABEL = process.env['FAUCET_SIGNER_LABEL'] ?? 'faucet-1';
const FAUCET_SEED = process.env['FAUCET_SEED'] ?? `${SERVER_RUNTIME_SEED}:faucet`;
const FAUCET_WALLET_ETH_TARGET = ethers.parseEther('100');
const FAUCET_TOKEN_TARGET_UNITS = 1_000_000n;
const SKIP_SERVER_BOOTSTRAP = /^(1|true)$/i.test(process.env['XLN_SKIP_SERVER_BOOTSTRAP'] ?? '');
const resolveTrustedServerRestoreRpcBindings = (): Array<{
  jurisdictionRef: string;
  rpcUrl: string;
}> => {
  if (process.env['USE_ANVIL'] !== 'true' || process.env['XLN_USE_PREDEPLOYED_ADDRESSES'] !== 'true') return [];
  const rpcUrl = resolveRequiredAnvilRpc();
  const preferredKey = String(process.env['XLN_PREDEPLOYED_JURISDICTION_KEY'] || '').trim();
  const jurisdictions = JSON.parse(readFileSync(resolveJurisdictionsJsonPath(), 'utf8')) as unknown;
  const selected = selectPredeployedJurisdiction(jurisdictions, rpcUrl, preferredKey);
  if (!selected) throw new Error('PREDEPLOYED_JURISDICTION_CONFIG_MISSING');
  const jurisdictionRef = getJurisdictionIdentityRef(selected);
  if (!jurisdictionRef) throw new Error('PREDEPLOYED_JURISDICTION_IDENTITY_MISSING');
  return [{ jurisdictionRef, rpcUrl }];
};
const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const RELAY_MARKET_MAX_SUBSCRIPTIONS = readPositiveIntEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTIONS', 1000);
const RELAY_MARKET_MAX_SUBSCRIPTION_CELLS = readPositiveIntEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTION_CELLS', 64);
const RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP = readPositiveIntEnv('XLN_RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP', 8);
const marketMakerState = createMarketMakerServerState();

const externalWalletApi = createExternalWalletApi({
  getJAdapter: () => globalJAdapter,
  getRuntimeId: () => String(serverEnv?.runtimeId || ''),
  getTokenCatalog: async () => tokenCatalogController.ensureTokenCatalog(),
  jsonHeaders: JSON_HEADERS,
  faucetSeed: FAUCET_SEED,
  faucetSignerLabel: FAUCET_SIGNER_LABEL,
  faucetWalletEthTarget: FAUCET_WALLET_ETH_TARGET,
  faucetTokenTargetUnits: FAUCET_TOKEN_TARGET_UNITS,
  emitDebugEvent: (entry) => {
    pushDebugEvent(relayStore, entry);
  },
  fundBrowserVmWallet: async (address: string, amount: bigint, tokenSymbol?: string): Promise<boolean> => {
    if (!globalJAdapter?.fundSignerWallet) return false;
    await globalJAdapter.fundSignerWallet(address, amount, tokenSymbol);
    return true;
  },
});

const stopMarketMakerLoop = (): void => {
  resetMarketMakerServerState(marketMakerState);
};

export type XlnServerOptions = {
  port: number;
  host?: string | undefined;
  staticDir?: string | undefined;
  serverId?: string | undefined;
};

const DEFAULT_OPTIONS: XlnServerOptions = {
  port: 8080,
  host: '127.0.0.1',
  staticDir: './frontend/build',
  serverId: 'xln-server',
};
const getDefaultLocalRelayUrl = (port?: number): string => `ws://localhost:${port ?? DEFAULT_OPTIONS.port}/relay`;
const resolveConfiguredRelayUrl = (port?: number): string => {
  const fallback = getDefaultLocalRelayUrl(port);
  const candidates = [
    process.env['INTERNAL_RELAY_URL'],
    process.env['RELAY_URL'],
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return candidates[0] || fallback;
};

let relayStore = createRelayStore(DEFAULT_OPTIONS.serverId ?? 'xln-server');
registerStructuredLogSink((entry) => {
  if (entry.level !== 'error') return;
  const severity = entry['severity'] === 'fatal' ? 'fatal' : 'error';
  pushDebugEvent(relayStore, {
    event: 'error',
    status: severity,
    reason: typeof entry['code'] === 'string' ? entry['code'] : entry.message,
    details: {
      source: 'runtime-server',
      severity,
      ...entry,
    },
  });
});
type ServerBootPhase = 'starting' | 'runtime' | 'bootstrap' | 'ready' | 'failed';
let serverBootPhase: ServerBootPhase = 'starting';
let serverBootError: string | null = null;
let serverBootStartedAt = 0;
let serverBootCompletedAt: number | null = null;

const sendDirectEntityInput = (
  env: RuntimeState,
  targetRuntimeId: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp?: number,
) => sendEntityInputDirectViaRelaySocketDelivery(relayStore, env, targetRuntimeId, envelope, logOneShot, ingressTimestamp);

const hasDirectRelayClient = (targetRuntimeId: string): boolean =>
  hasConnectedEncryptedRelayClient(relayStore, targetRuntimeId);

const installProcessSafetyGuards = (): void => {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    try {
      serverLog.error('process.unhandled_rejection', {
        code: 'UNHANDLED_REJECTION',
        severity: 'fatal',
        message,
        stack,
      });
    } finally {
      process.exit(1);
    }
  });

  process.on('uncaughtException', error => {
    const message = getErrorMessage(error, 'Unknown uncaught exception');
    try {
      serverLog.error('process.uncaught_exception', {
        code: 'UNCAUGHT_EXCEPTION',
        severity: 'fatal',
        message,
        stack: error?.stack,
      });
    } finally {
      process.exit(1);
    }
  });
};

const buildMarketSnapshot = (
  env: RuntimeState,
  hubEntityId: string,
  pairId: string,
  depth: number,
): MarketSnapshotPayload => {
  const hubReplica = getEntityReplicaById(env, hubEntityId);
  if (!hubReplica) {
    const error = new Error(`Unknown market hub: ${hubEntityId}`) as Error & { code?: string };
    error.code = 'E_UNKNOWN_HUB';
    throw error;
  }
  return buildMarketSnapshotForReplica(hubReplica, hubEntityId, pairId, depth);
};

const marketSubscriptionStack = createMarketSubscriptionStack<RelaySocket>({
  maxSubscriptions: RELAY_MARKET_MAX_SUBSCRIPTIONS,
  maxSubscriptionsPerIp: RELAY_MARKET_MAX_SUBSCRIPTIONS_PER_IP,
  maxCellsPerSubscription: RELAY_MARKET_MAX_SUBSCRIPTION_CELLS,
  getClientIp: getRelayClientIp,
  isReady: () => Boolean(serverEnv),
  readyError: 'Runtime not ready',
  fetchSnapshots: (hubEntityId, pairIds, depth) => {
    const env = serverEnv;
    if (!env) throw new Error('Runtime not ready');
    return pairIds.map((pairId) => buildMarketSnapshot(env, hubEntityId, pairId, depth));
  },
  onHandlerError: (error, msg) => {
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'MARKET_HANDLER_EXCEPTION',
      details: { error: getErrorMessage(error), msgType: msg['type'] },
    });
  },
});

const cleanupRpcMarketSubscription = (ws: RelaySocket): void => marketSubscriptionStack.cleanup(ws);

const handleRpcMessage = createServerRpcMessageHandler({
  validateRuntimeInputAdmission,
  registerRuntimeInputReceipt: (receipt) => runtimeIngressReceipts.register(receipt),
  readRuntimeInputReceipt: (id) => runtimeIngressReceipts.get(id),
  buildRuntimeInputStatusUrl: runtimeInputStatusUrl,
});

const maybeHandleControlApi = async (
  req: Request,
  pathname: string,
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
): Promise<Response | null> => {
  if (pathname === '/api/control/entities' && req.method === 'GET') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    if (!env) {
      return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
    }
    return new Response(
      serializeTaggedJson({
        ok: true,
        runtimeId: typeof env.runtimeId === 'string' ? env.runtimeId : null,
        entities: listLocalControlEntities(env, entityId => relayStore.gossipProfiles.get(entityId)?.profile?.name),
      }),
      { headers },
    );
  }

  if (pathname === '/api/control/signers/register' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    if (!env) {
      return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
    }
    return handleSignerRegistration(req, headers, { parseTaggedControlBody, env });
  }

  if (pathname === '/api/control/runtime-input' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    return handleRuntimeInputControl(req, headers, env, {
      enqueueRuntimeInput,
      validateRuntimeInputAdmission,
      parseTaggedControlBody,
      receipts: runtimeIngressReceipts,
      getCurrentRuntimeHeight: currentRuntimeHeight,
      buildStatusUrl: runtimeInputStatusUrl,
    });
  }

  const runtimeInputStatusMatch = pathname.match(/^\/api\/control\/runtime-input\/([^/]+)\/status$/);
  if (runtimeInputStatusMatch && req.method === 'GET') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    const receiptId = decodeURIComponent(runtimeInputStatusMatch[1] || '');
    return handleRuntimeInputStatus(receiptId, headers, env, {
      receipts: runtimeIngressReceipts,
      getCurrentRuntimeHeight: currentRuntimeHeight,
    });
  }

  if (pathname === '/api/control/p2p' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    return handleP2PControl(req, headers, env, { parseTaggedControlBody, startP2P });
  }
  return null;
};

const maybeHandleRuntimeInfoApi = async (
  req: Request,
  pathname: string,
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
  operatorAuthorized: boolean,
): Promise<Response | null> => {
  if (pathname === '/api/health') {
    return handleRuntimeHealth(req, headers, {
      env,
      relayStore,
      healthCacheTtlMs: HEALTH_CACHE_TTL_MS,
      cachedHealthResponse,
      setCachedHealthResponse: (entry) => { cachedHealthResponse = entry; },
      cachedHealthInFlight,
      setCachedHealthInFlight: (work) => { cachedHealthInFlight = work; },
      boot: {
        phase: serverBootPhase,
        startedAt: serverBootStartedAt,
        completedAt: serverBootCompletedAt,
        error: serverBootError,
      },
      activeHubEntityIds: relayStore.activeHubEntityIds,
      marketMakerState,
      getAccountState,
      ensureTokenCatalog: () => tokenCatalogController.ensureTokenCatalog(),
    }, operatorAuthorized);
  }

  if (pathname === '/api/watchtower-proxy' && (req.method === 'GET' || req.method === 'POST' || req.method === 'PUT')) {
    return handleWatchtowerProxy(req);
  }

  const qaResponse = await maybeHandleQaRequest(req, pathname, headers, { operatorAuthorized });
  if (qaResponse) return qaResponse;

  if (pathname === '/api/hubs') {
    return new Response(safeStringify(buildHubDiscoveryPayload({ env, relayStore })), { headers });
  }
  if (pathname === '/api/state' && env) {
    return new Response(safeStringify({
      height: env.height,
      timestamp: env.timestamp,
      runtimeId: env.runtimeId,
      entityCount: env.eReplicas?.size || 0,
    }), { headers });
  }
  if (pathname === '/api/clients') {
    return new Response(safeStringify({
      count: relayStore.clients.size,
      clients: Array.from(relayStore.clients.keys()),
    }), { headers });
  }
  return null;
};

const handleGossipProfileApi = async (
  req: Request,
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
): Promise<Response> => {
  const url = new URL(req.url);
  const targetEntityId = String(url.searchParams.get('entityId') || '').trim().toLowerCase();
  if (!targetEntityId) {
    return new Response(safeStringify({ ok: false, error: 'entityId is required' }), { status: 400, headers });
  }
  try {
    await env?.runtimeState?.p2p?.syncProfiles?.();
  } catch (error) {
    serverLog.warn('gossip.profile_sync_failed', {
      targetEntityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    if (env) await ensureGossipProfiles(env, [targetEntityId]);
  } catch (error) {
    serverLog.warn('gossip.profile_ensure_failed', {
      targetEntityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const bundle = buildKnownProfileBundle({ env, relayStore, entityId: targetEntityId });
  return new Response(safeStringify({
    ok: true,
    entityId: targetEntityId,
    found: !!bundle.profile,
    profile: bundle.profile,
    peers: bundle.peers,
  }), { headers });
};

const handleJurisdictionsApi = async (
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
): Promise<Response> => {
  try {
    const payload = await buildRuntimeJurisdictionsJson(env) ?? await readCanonicalJurisdictionsJson();
    return new Response(payload, {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    return new Response(
      safeStringify({ error: getErrorMessage(error, 'Failed to read jurisdictions.json') }),
      { status: 500, headers },
    );
  }
};

const maybeHandleDiscoveryApi = (
  req: Request,
  pathname: string,
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
): Promise<Response> | null => {
  if (pathname === '/api/gossip/profile') {
    return handleGossipProfileApi(req, env, headers);
  }
  if (pathname === '/api/jurisdictions') {
    return handleJurisdictionsApi(env, headers);
  }
  return null;
};

const maybeHandleDebugApi = async (
  req: Request,
  pathname: string,
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
  operatorAuthorized: boolean,
): Promise<Response | null> => {
  const relayDebugResponse = await maybeHandleRelayDebugRequest({
    request: req,
    pathname,
    url: new URL(req.url),
    headers,
    store: relayStore,
    operatorAuthorized,
  });
  if (relayDebugResponse) return relayDebugResponse;
  if (pathname === '/api/debug/activity' && env) {
    return handleRuntimeActivityRequest(env, new URL(req.url), headers);
  }
  const debugDumpsResponse = await maybeHandleDebugDumpsRequest({ req, pathname, relayStore, headers });
  if (debugDumpsResponse) return debugDumpsResponse;
  if (pathname === '/api/debug/entities') {
    const url = new URL(req.url);
    return new Response(
      safeStringify(buildDebugEntitiesPayload({
        relayStore,
        query: url.searchParams.get('q') || '',
        limit: Number(url.searchParams.get('limit') || '1000'),
        onlineOnly: url.searchParams.get('online') === 'true',
      })),
      { headers },
    );
  }
  if (pathname === '/api/debug/reserve') {
    if (!globalJAdapter) {
      return new Response(safeStringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
    }

    const url = new URL(req.url);
    const entityId = String(url.searchParams.get('entityId') || '').trim();
    const tokenId = Number(url.searchParams.get('tokenId') || '1');

    if (!entityId) {
      return new Response(safeStringify({ error: 'Missing entityId' }), { status: 400, headers });
    }
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return new Response(safeStringify({ error: 'Invalid tokenId' }), { status: 400, headers });
    }

    try {
      const reserve = await globalJAdapter.getReserves(entityId, tokenId);
      return new Response(
        safeStringify({
          ok: true,
          entityId,
          tokenId,
          reserve: reserve.toString(),
        }),
        { headers },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(safeStringify({ error: message }), { status: 500, headers });
    }
  }
  return null;
};

const maybeHandleFinancialApi = (
  req: Request,
  pathname: string,
  env: RuntimeState | null,
  headers: typeof JSON_HEADERS,
): Promise<Response> | Response | null => {
  if (pathname === '/api/tokens') {
    return externalWalletApi.handleTokens();
  }
  if (pathname === '/api/external-wallet/snapshot' && req.method === 'POST') {
    return externalWalletApi.handleWalletSnapshot(req);
  }
  if (pathname === '/api/faucet/erc20' && req.method === 'POST') {
    return externalWalletApi.handleErc20Faucet(req);
  }
  if (pathname === '/api/faucet/gas' && req.method === 'POST') {
    return externalWalletApi.handleGasFaucet(req);
  }
  if (pathname === '/api/faucet/reserve' && req.method === 'POST') {
    return handleReserveFaucet({
      req,
      env,
      headers,
      relayStore,
      getJAdapter: () => globalJAdapter,
      ensureTokenCatalog: () => tokenCatalogController.ensureTokenCatalog(),
      validateRuntimeInputAdmission,
      enqueueRuntimeInput,
    });
  }
  if (pathname === '/api/faucet/offchain' && req.method === 'POST') {
    return handleOffchainFaucet({
      req,
      env,
      headers,
      relayStore,
      enqueueRuntimeInput,
      validateRuntimeInputAdmission,
      registerReceipt: (receipt) => runtimeIngressReceipts.register(receipt),
      getCurrentRuntimeHeight: currentRuntimeHeight,
      buildRuntimeInputStatusUrl: runtimeInputStatusUrl,
    });
  }
  if (pathname === '/api/credit/request' && req.method === 'POST') {
    return handleCreditRequest({
      req,
      env,
      headers,
      activeHubEntityIds: relayStore.activeHubEntityIds,
      enqueueRuntimeInput,
      validateRuntimeInputAdmission,
      registerReceipt: (receipt) => runtimeIngressReceipts.register(receipt),
      getCurrentRuntimeHeight: currentRuntimeHeight,
      buildRuntimeInputStatusUrl: runtimeInputStatusUrl,
    });
  }
  if (pathname === '/api/lending/state' && req.method === 'GET') {
    return handleLendingStateRequest({
      req,
      env,
      headers,
      activeHubEntityIds: relayStore.activeHubEntityIds,
    });
  }
  return null;
};

const handleApi = async (
  req: Request,
  pathname: string,
  env: RuntimeState | null,
  clientId: string,
  operatorAuthorized: boolean,
): Promise<Response> => {
  const headers = JSON_HEADERS;
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  const assistantResponse = await assistantProxy.handle(req, pathname, clientId);
  if (assistantResponse) return assistantResponse;
  const controlResponse = await maybeHandleControlApi(req, pathname, env, headers);
  if (controlResponse) return controlResponse;
  // /rpc is the canonical JSON-RPC path; /api/rpc remains a transport alias.
  if ((pathname === '/api/rpc' || pathname === '/rpc') && req.method === 'POST') {
    return handleRuntimeRpcProxy({ req, pathname, env, relayStore, headers, operatorAuthorized });
  }
  const runtimeInfoResponse = await maybeHandleRuntimeInfoApi(req, pathname, env, headers, operatorAuthorized);
  if (runtimeInfoResponse) return runtimeInfoResponse;
  const discoveryResponse = maybeHandleDiscoveryApi(req, pathname, env, headers);
  if (discoveryResponse) return discoveryResponse;
  const debugResponse = await maybeHandleDebugApi(req, pathname, env, headers, operatorAuthorized);
  if (debugResponse) return debugResponse;
  const financialResponse = maybeHandleFinancialApi(req, pathname, env, headers);
  if (financialResponse) return financialResponse;
  return new Response(safeStringify({ error: 'Not found' }), { status: 404, headers });
};

type ServerSession = {
  env: RuntimeState | null;
  routerConfig: RelayRouterConfig | null;
  relayHelloChallenges: ReturnType<typeof createHelloChallengeRegistry>;
};

const handleHttpRequest = async (
  options: XlnServerOptions,
  session: ServerSession,
  req: Request,
  server: Server,
): Promise<Response | undefined> => {
  const pathname = new URL(req.url).pathname;
  const localPairingResponse = await localPairingController.handle(req, pathname, session.env);
  if (localPairingResponse) return localPairingResponse;

  if (req.headers.get('upgrade') === 'websocket') {
    const wsType = pathname === '/relay' ? 'relay' : pathname === '/rpc' ? 'rpc' : null;
    if (wsType && server.upgrade(req, { data: { type: wsType, clientIp: resolveRequestClientIp(req) } })) {
      return undefined;
    }
    return new Response('WebSocket upgrade failed', { status: 400 });
  }

  if (pathname.startsWith('/api/') || pathname === '/rpc') {
    try {
      const directClientIp = resolveAssistantDirectClientIp(server, req);
      const clientId = resolveAssistantRateClientId(req, directClientIp);
      const peerAddress = resolveSocketPeerAddress(server, req);
      const operatorAuthorized = isLocalOperatorRequest(req, peerAddress) || hasDaemonControlAuth(req, session.env);
      return await handleApi(req, pathname, session.env, clientId, operatorAuthorized);
    } catch (error) {
      const message = getErrorMessage(error, 'API handler failed');
      serverLog.error('api.unhandled_route_error', { pathname, message });
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'API_HANDLER_EXCEPTION',
        details: { pathname, message },
      });
      return new Response(safeStringify({ error: message, code: 'API_HANDLER_EXCEPTION' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (options.staticDir) {
    if (pathname === '/runtime.js') {
      const runtimeBundle = await serveRuntimeBundle();
      if (runtimeBundle) return runtimeBundle;
    }
    if (pathname === '/') {
      const index = await serveStatic('/index.html', options.staticDir);
      if (index) return index;
    }
    const file = await serveStatic(pathname, options.staticDir);
    if (file) return file;
    const fallback = await serveStatic('/index.html', options.staticDir);
    if (fallback) return fallback;
  }

  return new Response('Not found', { status: 404 });
};

const routeRelaySocketMessage = (
  session: ServerSession,
  ws: RelaySocket,
  peerMessage: RuntimeWsMessage,
): void => {
  const routerConfig = session.routerConfig;
  if (!routerConfig) {
    ws.send(serializeWsMessage({ type: 'error', error: 'Runtime transport not ready' }));
    return;
  }
  Promise.resolve(relayRoute(routerConfig, ws, peerMessage)).catch(error => {
    const reason = getErrorMessage(error, 'relay handler error');
    serverLog.error('ws.relay_handler_error', { reason, type: peerMessage.type });
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'RELAY_HANDLER_EXCEPTION',
      details: {
        error: reason,
        msgType: peerMessage.type,
        from: peerMessage.from,
        to: peerMessage.to,
      },
    });
    try {
      ws.send(serializeWsMessage({ type: 'error', error: 'Relay handler exception' }));
    } catch (sendError) {
      serverLog.debug('ws.relay_error_response_failed', {
        error: getErrorMessage(sendError),
      });
    }
  });
};

const handleWebSocketMessage = (
  session: ServerSession,
  ws: RelaySocket,
  message: string | Uint8Array | ArrayBuffer,
): void => {
  const messageText = (): string => typeof message === 'string'
    ? message
    : new TextDecoder().decode(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
  const wsType = ws.data.type;
  try {
    if (wsType === 'rpc') {
      const request = decodeRuntimeAdapterRequest(message);
      Promise.resolve(handleRpcMessage(ws, request, session.env)).catch(error => {
        const reason = getErrorMessage(error);
        serverLog.error('ws.rpc_handler_error', { reason, op: request.op });
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'RPC_HANDLER_EXCEPTION',
          details: { error: reason, op: request.op },
        });
        closeInvalidRuntimeAdapterMessage(ws, error);
      });
      return;
    }

    let peerMessage: RuntimeWsMessage | null = null;
    let marketMessage: MarketWireRequest | null = null;
    try {
      peerMessage = deserializeWsMessage(message);
    } catch (binaryError) {
      try {
        marketMessage = decodeMarketWireRequest(messageText());
      } catch {
        throw binaryError;
      }
    }
    if (marketMessage) {
      Promise.resolve(marketSubscriptionStack.handleMessage(ws, marketMessage)).catch(error => {
        const reason = getErrorMessage(error);
        serverLog.error('ws.market_handler_error', { reason, type: marketMessage?.type });
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'MARKET_HANDLER_EXCEPTION',
          details: { error: reason, msgType: marketMessage?.type },
        });
        ws.send(encodeMarketWireMessage({ type: 'error', error: reason }));
      });
      return;
    }
    if (!peerMessage) throw new Error('RELAY_MESSAGE_DECODE_INVARIANT');

    if (!session.routerConfig && isServerBootInProgress()) {
      void serverStartupBarrier.then(() => routeRelaySocketMessage(session, ws, peerMessage));
      return;
    }
    routeRelaySocketMessage(session, ws, peerMessage);
  } catch (error) {
    const byteLength = wsType === 'rpc' ? runtimeAdapterMessageByteLength(message) : messageText().length;
    const errorMessage = getErrorMessage(error);
    serverLog.error('ws.parse_error', { type: wsType, len: byteLength, error: errorMessage });
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: wsType === 'rpc' ? 'Invalid runtime adapter message' : 'Invalid relay message',
      details: { wsType, len: byteLength, error: errorMessage },
    });
    if (wsType === 'rpc') {
      closeInvalidRuntimeAdapterMessage(ws, error);
    } else {
      ws.send(serializeWsMessage({ type: 'error', error: 'Invalid relay message' }));
    }
  }
};

const handleWebSocketClose = (
  session: ServerSession,
  ws: RelaySocket,
  code: number,
  reason: string | Buffer,
): void => {
  session.relayHelloChallenges.forget(ws);
  cleanupRpcMarketSubscription(ws);
  forgetRuntimeAdapterClient(ws);
  forgetRelaySocketRuntimeId(ws);
  const removedId = removeClient(relayStore, ws);
  const reasonText = typeof reason === 'string' ? reason : reason.toString();
  serverLog.warn('ws.close', {
    type: ws.data.type,
    runtime: removedId ? shortId(removedId, 10) : 'unknown',
    code: Number(code || 0),
    reason: reasonText || null,
  });
  if (removedId) {
    pushDebugEvent(relayStore, {
      event: 'ws_close',
      runtimeId: removedId,
      from: removedId,
      details: {
        wsType: ws.data.type,
        code: Number(code || 0),
        reason: reasonText || null,
      },
    });
  }
};

const createHttpServer = (options: XlnServerOptions, session: ServerSession) => Bun.serve({
  port: options.port,
  hostname: options.host ?? '127.0.0.1',
  fetch: (req, server) => handleHttpRequest(options, session, req, server),
  websocket: {
    open(ws: RelaySocket) {
      serverLog.info('ws.open', { type: ws.data.type });
      if (ws.data.type === 'rpc' && session.env) {
        attachRuntimeAdapterTicker(session.env, registerEnvChangeCallback);
      }
      if (ws.data.type === 'relay') session.relayHelloChallenges.issue(ws);
      pushDebugEvent(relayStore, { event: 'ws_open', details: { wsType: ws.data.type } });
    },
    message: (ws, message) => handleWebSocketMessage(session, ws, message),
    close: (ws, code, reason) => handleWebSocketClose(session, ws, code, reason),
  },
});

export async function startXlnServer(opts: Partial<XlnServerOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const incidentJournalPath = String(
    process.env['XLN_SERVER_DEBUG_INCIDENT_JOURNAL_PATH'] || `${dbRootPath}.debug-incidents.jsonl`,
  ).trim();
  const incidentJournal = openRelayIncidentJournal(incidentJournalPath);
  relayStore = createRelayStore(options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server', {
    initialDebugId: incidentJournal.debugId,
    initialIncidents: incidentJournal.incidents,
    debugIdAllocator: () => incidentJournal.allocateDebugId(),
    incidentSink: incident => incidentJournal.record(incident),
  });
  installProcessSafetyGuards();
  serverLog.info('start', { port: options.port, host: options.host, staticDir: options.staticDir });
  marketSubscriptionStack.clear();
  const internalRelayUrl = resolveConfiguredRelayUrl(options.port);
  serverBootStartedAt = Date.now();
  serverBootCompletedAt = null;
  serverBootPhase = 'starting';
  serverBootError = null;
  serverStartupBarrier = new Promise<void>(resolve => {
    resolveServerStartupBarrier = resolve;
  });

  let env: RuntimeState | null = null;
  const serverSession: ServerSession = {
    env: null,
    routerConfig: null,
    relayHelloChallenges: createHelloChallengeRegistry(),
  };
  const server = createHttpServer(options, serverSession);

  const closeFailedStartup = async (startupError: unknown): Promise<never> => {
    stopMarketMakerLoop();
    const original = startupError instanceof Error ? startupError : new Error(String(startupError));
    const cleanup = await Promise.allSettled([
      globalJAdapter?.close() ?? Promise.resolve(),
      env ? closeRuntimeDb(env) : Promise.resolve(),
      env ? closeInfraDb(env) : Promise.resolve(),
      server.stop(true),
    ]);
    globalJAdapter = null;
    serverEnv = null;
    serverSession.env = null;
    serverSession.routerConfig = null;
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([original, ...cleanupErrors], 'SERVER_STARTUP_FAILED_WITH_CLEANUP_ERRORS');
    }
    throw original;
  };

  try {
    serverBootPhase = 'runtime';
    serverLog.info('runtime.init.start');
    env = await main(SERVER_RUNTIME_SEED, {
      trustedJurisdictionRpcBindings: resolveTrustedServerRestoreRpcBindings(),
      localSigners: [
        ...(STARTUP_SIGNER ? [STARTUP_SIGNER] : []),
        ...(LOCAL_RUNTIME_OWNER ? [{ label: LOCAL_RUNTIME_OWNER.label }] : []),
      ],
    });
    serverEnv = env;
    serverSession.env = env;
    registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
      runtimeIngressReceipts.observeRuntimeInput(height, runtimeInput);
    });
    serverLog.info('runtime.init.ready', { runtimeId: shortId(env.runtimeId, 10) });
    const runtimeEnv = env;
    const verboseRuntimeLogs = /^(1|true)$/i.test(process.env['RUNTIME_VERBOSE_LOGS'] ?? '');
    env.quietRuntimeLogs = !verboseRuntimeLogs;
    serverLog.info('runtime.log_mode', { mode: env.quietRuntimeLogs ? 'quiet' : 'verbose' });
    env.runtimeState = env.runtimeState ?? {};
    env.runtimeState.directEntityInputsDispatch = (targetRuntimeId, envelope, ingressTimestamp) =>
      sendDirectEntityInput(runtimeEnv, targetRuntimeId, envelope, ingressTimestamp);
    env.runtimeState.canUseConnectedRelayFallback = hasDirectRelayClient;
    startRuntimeLoop(env, {
      onFatal: async payload => {
        serverLog.error('runtime.loop_fatal', {
          ...payload,
          runtimeId: runtimeEnv.runtimeId,
          severity: 'fatal',
        });
      },
    });
    serverLog.info('runtime.loop.started');

    // Initialize J-adapter (anvil for testnet, browserVM for local)
    const useAnvil = process.env['USE_ANVIL'] === 'true';
    const anvilRpc = useAnvil ? resolveRequiredAnvilRpc() : '';

    serverLog.info('jadapter.mode', { useAnvil, anvilRpc: useAnvil ? anvilRpc : null });

    if (useAnvil) {
      serverLog.info('anvil.connect.start', { rpc: anvilRpc });
      const usePredeployedAddresses = process.env['XLN_USE_PREDEPLOYED_ADDRESSES'] === 'true';
      const predeployedJurisdictionKey = String(process.env['XLN_PREDEPLOYED_JURISDICTION_KEY'] || '').trim();

    // Optional: reuse addresses from jurisdictions.json (disabled by default).
    const fs = await import('fs/promises');
    let fromReplica: JAdapterConfig['fromReplica'] | undefined = undefined;
    if (usePredeployedAddresses) {
      try {
        const jurisdictionsPath = resolveJurisdictionsJsonPath();
        serverLog.info('anvil.predeployed.load', {
          path: jurisdictionsPath,
          jurisdictionKey: predeployedJurisdictionKey || null,
        });
        const jurisdictionsData = await fs.readFile(jurisdictionsPath, 'utf-8');
        const jurisdictions = JSON.parse(jurisdictionsData);
        const predeployedConfig = selectPredeployedJurisdiction(jurisdictions, anvilRpc, predeployedJurisdictionKey);
        if (!predeployedConfig) throw new Error('PREDEPLOYED_JURISDICTION_CONFIG_MISSING');
        const contracts = predeployedConfig.contracts;
        fromReplica = {
          depositoryAddress: String(contracts['depository']),
          entityProviderAddress: String(contracts['entityProvider']),
          contracts: {
            account: String(contracts['account'] || ''),
            depository: String(contracts['depository']),
            entityProvider: String(contracts['entityProvider']),
            deltaTransformer: String(contracts['deltaTransformer'] || ''),
          },
          chainId: Number(predeployedConfig.chainId ?? 31337),
          entityProviderDeploymentBlock: Number(predeployedConfig.entityProviderDeploymentBlock),
        } as JAdapterConfig['fromReplica'];
        serverLog.info('anvil.predeployed.loaded');
      } catch (err) {
        serverLog.error('anvil.predeployed.load_failed', { error: (err as Error).message });
        throw err;
      }
    } else {
      serverLog.info('anvil.fresh_deploy_mode');
    }

    // Wait for ANVIL to be ready (retry up to 30s)
    let detectedChainId = 31337;
    const maxRetries = 30;
    let anvilReady = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const probe = createXlnJsonRpcProvider(anvilRpc);
        const network = await probe.getNetwork();
        if (network?.chainId) detectedChainId = Number(network.chainId);
        anvilReady = true;
        serverLog.info('anvil.ready', { chainId: detectedChainId });
        break;
      } catch (err) {
        if (i === 0) serverLog.info('anvil.wait', { rpc: anvilRpc });
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!anvilReady) {
      throw new Error(
        `❌ FAIL-FAST: ANVIL not reachable at ${anvilRpc} after ${maxRetries}s. Is anvil running?`,
      );
    }
    if (detectedChainId !== 31337) {
      throw new Error(`❌ FAIL-FAST: expected ANVIL chainId=31337, got ${detectedChainId} at ${anvilRpc}`);
    }

    // Ensure fromReplica carries correct chainId (override if stale)
    if (fromReplica && fromReplica.chainId !== detectedChainId) {
      serverLog.warn('anvil.from_replica_chainid_override', {
        fromReplicaChainId: fromReplica.chainId,
        detectedChainId,
      });
      fromReplica.chainId = detectedChainId;
    }

    const fromReplicaDepositoryAddress = fromReplica?.depositoryAddress;
    const fromReplicaEntityProviderAddress = fromReplica?.entityProviderAddress;
    if (fromReplicaDepositoryAddress && fromReplicaEntityProviderAddress) {
      serverLog.info('anvil.predeployed.precheck.start');
      const [depositoryCode, entityProviderCode] = await withStartupStepTimeout(
        'precheckPredeployedCode',
        (async () => {
          const depCode = await fetchRpcCode(anvilRpc, fromReplicaDepositoryAddress);
          const entityProviderCode = await fetchRpcCode(anvilRpc, fromReplicaEntityProviderAddress);
          return [depCode, entityProviderCode] as const;
        })(),
      );
      serverLog.info('anvil.predeployed.precheck.complete');
      if (depositoryCode === '0x' || entityProviderCode === '0x') {
        throw new Error(`PREDEPLOYED_CONTRACT_CODE_MISSING:${fromReplicaDepositoryAddress}:${fromReplicaEntityProviderAddress}`);
      }
    }

    const rpcAdapterConfig: JAdapterConfig = {
      mode: 'rpc',
      chainId: detectedChainId,
      rpcUrl: anvilRpc,
    };
    if (fromReplica) {
      rpcAdapterConfig.fromReplica = fromReplica;
    }
    globalJAdapter = await withStartupStepTimeout(
      'createJAdapter(rpc)',
      createJAdapter(rpcAdapterConfig),
    );

    const deployFreshLocalStack = async (reason: string): Promise<void> => {
      if (usePredeployedAddresses) {
        throw new Error(`PREDEPLOYED_STACK_DEPLOY_FORBIDDEN:${reason}`);
      }
      serverLog.warn('anvil.stack_incompatible', { reason });
      await globalJAdapter?.close();
      globalJAdapter = await withStartupStepTimeout(
        'createJAdapter(rpc:fresh)',
        createJAdapter({
          mode: 'rpc',
          chainId: detectedChainId,
          rpcUrl: anvilRpc,
        }),
      );
      await withStartupStepTimeout('deployStack', globalJAdapter.deployStack(), Math.max(STARTUP_STEP_TIMEOUT_MS, 60_000));
      serverLog.info('anvil.contracts.deployed');
    };

    const hasAddresses = !!globalJAdapter.addresses?.depository && !!globalJAdapter.addresses?.entityProvider;
    if (!hasAddresses) {
      serverLog.info('anvil.contracts.deploy_missing');
      await deployFreshLocalStack('MISSING_ADDRESSES');
    } else {
      const compatibility = await withStartupStepTimeout(
        'probeLocalAnvilContractStack',
        probeLocalAnvilContractStack(globalJAdapter),
      );
      if (!compatibility.ok) {
        await deployFreshLocalStack(compatibility.reason);
      } else if (fromReplica) {
        serverLog.info('anvil.contracts.use_predeployed');
      } else {
        serverLog.info('anvil.contracts.use_existing');
      }
    }
    const block = await withStartupStepTimeout('provider.getBlockNumber', globalJAdapter.provider.getBlockNumber());
    serverLog.info('anvil.connected', { block });

    let updatedRuntimeJurisdiction: Awaited<ReturnType<typeof updateJurisdictionsJson>> = null;
    if (globalJAdapter.addresses?.depository && globalJAdapter.addresses?.entityProvider) {
      updatedRuntimeJurisdiction = await withStartupStepTimeout(
        'updateJurisdictionsJson',
        updateJurisdictionsJson(
          globalJAdapter.addresses,
          anvilRpc,
          detectedChainId,
          predeployedJurisdictionKey,
          globalJAdapter.entityProviderDeploymentBlock,
        ),
      );
    }

    // Ensure env has a J-replica for this RPC jurisdiction (required for j_broadcast → j-mempool)
    if (globalJAdapter && env) {
      if (!env.jReplicas) env.jReplicas = new Map();
      const jName = updatedRuntimeJurisdiction?.key || 'primary';
      if (!env.jReplicas.has(jName)) {
        const stateRoot = await (globalJAdapter.captureStateRoot?.() ?? Promise.resolve(null));
        env.jReplicas.set(jName, {
          name: jName,
          blockNumber: 0n,
          stateRoot,
          mempool: [],
          blockDelayMs: 300,
          blockTimeMs: 300,
          lastBlockTimestamp: env.timestamp,
          position: { x: 0, y: 50, z: 0 },
          depositoryAddress: globalJAdapter.addresses.depository,
          entityProviderAddress: globalJAdapter.addresses.entityProvider,
          entityProviderDeploymentBlock: globalJAdapter.entityProviderDeploymentBlock,
          watcherConfirmationDepth: requireWatcherConfirmationDepth(globalJAdapter),
          contracts: globalJAdapter.addresses,
          rpcs: [anvilRpc],
          chainId: globalJAdapter.chainId,
          jadapter: globalJAdapter,
        });
        serverLog.info('jreplica.registered', { name: jName });
      }
      if (!env.activeJurisdiction) env.activeJurisdiction = jName;
    }
    } else {
      serverLog.info('browservm.start');
      globalJAdapter = await withStartupStepTimeout(
        'createJAdapter(browservm)',
        createJAdapter({
          mode: 'browservm',
          chainId: 31337,
        }),
      );
      await withStartupStepTimeout('deployStack(browservm)', globalJAdapter.deployStack(), Math.max(STARTUP_STEP_TIMEOUT_MS, 60_000));
      if (globalJAdapter && env) {
        if (!env.jReplicas) env.jReplicas = new Map();
        const jName = 'local';
        if (!env.jReplicas.has(jName)) {
          const stateRoot = await (globalJAdapter.captureStateRoot?.() ?? Promise.resolve(null));
          if (!(stateRoot instanceof Uint8Array && stateRoot.length === 32)) {
            throw new Error('BROWSERVM_STATE_ROOT_UNAVAILABLE: startup local jReplica cannot time-travel safely');
          }
          env.jReplicas.set(jName, {
            name: jName,
            blockNumber: 0n,
            stateRoot,
            mempool: [],
            blockDelayMs: 300,
            lastBlockTimestamp: env.timestamp,
            position: { x: 0, y: 50, z: 0 },
            depositoryAddress: globalJAdapter.addresses.depository,
            entityProviderAddress: globalJAdapter.addresses.entityProvider,
            entityProviderDeploymentBlock: globalJAdapter.entityProviderDeploymentBlock,
            watcherConfirmationDepth: requireWatcherConfirmationDepth(globalJAdapter),
            contracts: globalJAdapter.addresses,
            rpcs: [],
            chainId: globalJAdapter.chainId,
            jadapter: globalJAdapter,
          });
          serverLog.info('jreplica.registered', { name: jName });
        }
        if (!env.activeJurisdiction) env.activeJurisdiction = jName;
      }
    }

    if (LOCAL_RUNTIME_OWNER) {
      const jurisdictionName = String(env.activeJurisdiction || 'local');
      const jurisdiction = env.jReplicas.get(jurisdictionName);
      if (!jurisdiction) throw new Error(`LOCAL_RUNTIME_OWNER_JURISDICTION_MISSING:${jurisdictionName}`);
      const owner = buildLocalRuntimeOwner({
        signerId: deriveSignerAddressSync(SERVER_RUNTIME_SEED, LOCAL_RUNTIME_OWNER.label),
        profileName: LOCAL_RUNTIME_OWNER.profileName,
        jurisdictionName,
        jurisdiction,
      });
      const result = await ensureLocalRuntimeOwner(env, owner, {
        enqueue: enqueueRuntimeInput,
        onFrameCommit: (targetEnv, callback) => registerRuntimeFrameCommitCallback(
          targetEnv,
          ({ height }) => callback(height),
        ),
        timeoutMs: STARTUP_STEP_TIMEOUT_MS,
      });
      relayStore.activeHubEntityIds = [];
      serverLog.info('local_owner.ready', {
        entityId: shortId(result.entityId, 10),
        created: result.created,
        height: result.height,
      });
    }

    // J-event watching belongs to the unified runtime loop. The server should
    // wire jReplicas only; startRuntimeLoop() owns startJurisdictionWatchers().

    // Wire relay-router + local delivery as soon as env exists.
    // Relay WS can receive early hello/gossip traffic during bootstrap.
    const localDeliver = createLocalDeliveryHandler(env, relayStore, getEntityReplicaById);
    serverSession.routerConfig = {
      store: relayStore,
      localRuntimeId: String(env.runtimeId),
      localDeliver,
      send: (ws, data) => ws.send(data),
      consumeHelloChallenge: (ws, challenge) => serverSession.relayHelloChallenges.consume(ws, challenge),
      onGossipStore: profile => {
        try {
          runtimeEnv.gossip?.announce?.(profile);
        } catch (error) {
          serverLog.warn('gossip.profile_announce_failed', {
            entityId: profile.entityId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };

    serverBootPhase = 'bootstrap';
    let hubEntityIds: string[];
    if (SKIP_SERVER_BOOTSTRAP) {
      serverLog.info('bootstrap.skip');
      relayStore.activeHubEntityIds = [];
      stopMarketMakerLoop();
      hubEntityIds = [];
    } else {
      throw new Error('SHARED_HUB_BOOTSTRAP_REMOVED: use runtime/orchestrator/orchestrator.ts');
    }

    // Start P2P overlay after WS /relay is actually listening.
    // Plain daemons stay connected even before they own a routing entity;
    // routing capability is an entity-level setting announced later.
    const advertisedEntityIds = [
      ...hubEntityIds,
      ...(marketMakerState.entityId ? [marketMakerState.entityId.toLowerCase()] : []),
    ];
    startP2P(env, {
      relayUrls: [internalRelayUrl],
      ...(advertisedEntityIds.length > 0 ? { advertiseEntityIds: advertisedEntityIds } : {}),
      isHub: hubEntityIds.length > 0,
      gossipPollMs: 250,
    });
    serverBootPhase = 'ready';
    serverBootCompletedAt = Date.now();
  } catch (error) {
    serverBootPhase = 'failed';
    serverBootCompletedAt = Date.now();
    serverBootError = (error as Error)?.message || String(error);
    serverLog.error('startup.failed_after_bind', { error: getErrorMessage(error) });
    return closeFailedStartup(error);
  } finally {
    resolveServerStartupBarrier?.();
    resolveServerStartupBarrier = null;
  }

  serverLog.info('ready', {
    port: options.port,
    host: options.host || '127.0.0.1',
    mode: globalJAdapter ? globalJAdapter.mode : 'no-jadapter',
  });

  return;
}

if (import.meta.main) {
  const managedParentPid = process.env['XLN_MANAGED_PARENT_PID'];
  const stopParentWatch = managedParentPid
    ? startParentLivenessWatch('runtime-server', managedParentPid, () => {
        process.kill(process.pid, 'SIGTERM');
      }, 250)
    : () => {};
  process.once('exit', stopParentWatch);
  const args = process.argv.slice(2);

  const getArg = (name: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] || fallback;
  };

  const options: Partial<XlnServerOptions> = {
    port: Number(getArg('--port', '8080')),
    host: getArg('--host', '127.0.0.1'),
    staticDir: getArg('--static-dir', './frontend/build'),
    serverId: getArg('--server-id', 'xln-server'),
  };

  serverLog.info('cli.start', {
    useAnvil: process.env['USE_ANVIL'] === 'true',
    anvilRpc: process.env['ANVIL_RPC'] || null,
    args,
  });

  startXlnServer(options)
    .then(() => {
      serverLog.info('cli.ready');
    })
    .catch(error => {
      serverLog.error('cli.failed', { error: getErrorMessage(error), stack: error.stack });
      process.exit(1);
    });
}
