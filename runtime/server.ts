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
 *   bun runtime/server.ts                    # Server on :8080
 *   bun runtime/server.ts --port 9000        # Custom port
 */

import {
  main,
  enqueueRuntimeInput,
  startP2P,
  startRuntimeLoop,
  ensureGossipProfiles,
  registerEnvChangeCallback,
} from './runtime.ts';
import { safeStringify, serializeTaggedJson } from './serialization-utils';
import type { DeliverableEntityInput, Env, RuntimeInput } from './types';
import { createExternalWalletApi } from './api/external-wallet-api';
import { maybeHandleQaRequest } from './qa/api';
import { registerSignerKey } from './account-crypto';
import { createJAdapter, type JAdapter } from './jadapter';
import type { JAdapterConfig } from './jadapter/types';
import {
  createMarketMakerServerState,
  resetMarketMakerServerState,
} from './server/market-maker-health';
import { serveRuntimeBundle, serveStatic } from './server/static-assets';
import { parseTaggedControlBody, requireDaemonControlAuth } from './server/auth';
import { listLocalControlEntities } from './server/control-entities';
import {
  getAccountMachine,
  getEntityReplicaById,
} from './server/entity-lookup';
import { createRuntimeIngressReceiptStore } from './server/ingress-receipts';
import {
  createRelayStore,
  pushDebugEvent,
  removeClient,
} from './relay-store';
import { forgetRelaySocketRuntimeId, relayRoute, type RelayRouterConfig } from './relay-router';
import { createLocalDeliveryHandler } from './relay-local-delivery';
import { resolveJurisdictionsJsonPath } from './jurisdictions-path';
import { createStructuredLogger, shortId } from './logger';
import {
  buildMarketSnapshotForReplica,
  type MarketSnapshotPayload,
} from './market-snapshot';
import { createMarketSubscriptionStack, isMarketMessageType } from './relay/market-subscriptions';
import {
  JSON_HEADERS,
  getErrorMessage,
  resolveRequiredAnvilRpc,
} from './server-utils';
import { ethers } from 'ethers';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
} from './radapter/server';
import { decodeRuntimeAdapterMessage, runtimeAdapterMessageByteLength } from './radapter/codec';
import {
  getRelayClientIp,
  hasConnectedEncryptedRelayClient as hasConnectedEncryptedRelayClientInStore,
  resolveRequestClientIp,
  sendEntityInputDirectViaRelaySocket as sendEntityInputDirectViaRelaySocketInStore,
  type RelaySocket,
} from './server/relay-direct';
import { createServerRpcMessageHandler } from './server/rpc-ws';
import {
  buildRuntimeJurisdictionsJson,
  readCanonicalJurisdictionsJson,
  updateJurisdictionsJson,
} from './server/jurisdictions';
import { createTokenCatalogController } from './server/token-catalog';
import { buildHubDiscoveryPayload } from './server/hub-discovery';
import { buildDebugEntitiesPayload, buildKnownProfileBundle } from './server/gossip-profiles';
import { maybeHandleDebugDumpsRequest } from './server/debug-dumps';
import { handleCreditRequest } from './server/credit-request';
import { handleOffchainFaucet } from './server/offchain-faucet';
import { handleReserveFaucet } from './server/reserve-faucet';
import { handleRuntimeHealth, type RuntimeHealthCacheEntry } from './server/health-api';
import { handleRuntimeRpcProxy } from './server/rpc-proxy';
import { handleP2PControl } from './server/p2p-control';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
let serverEnv: Env | null = null;
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
const STACK_COMPATIBILITY_PROBE_ENTITY = `0x${'11'.repeat(32)}`;
const serverLog = createStructuredLogger('server');
const tokenCatalogController = createTokenCatalogController({
  getAdapter: () => globalJAdapter,
});

const probeLocalAnvilContractStack = async (adapter: JAdapter): Promise<{ ok: boolean; reason: string }> => {
  const depositoryAddress = String(adapter.addresses?.depository || '').trim();
  if (!depositoryAddress) {
    return { ok: false, reason: 'DEPOSITORY_ADDRESS_MISSING' };
  }

  const code = await adapter.provider.getCode(depositoryAddress);
  if (!code || code === '0x') {
    return { ok: false, reason: 'DEPOSITORY_CODE_MISSING' };
  }

  const probe = new ethers.Contract(
    depositoryAddress,
    [
      'function getTokensLength() view returns(uint256)',
      'function mintToReserve(bytes32,uint256,uint256)',
      'function mintToReserveBatch((bytes32,uint256,uint256)[])',
    ],
    adapter.signer as ethers.ContractRunner,
  );
  const getTokensLength = probe.getFunction('getTokensLength') as unknown as () => Promise<bigint>;
  const mintToReserve = probe.getFunction('mintToReserve') as unknown as {
    estimateGas(entityId: string, tokenId: bigint, amount: bigint): Promise<bigint>;
  };
  const mintToReserveBatch = probe.getFunction('mintToReserveBatch') as unknown as {
    estimateGas(mints: Array<[string, bigint, bigint]>): Promise<bigint>;
  };

  let tokensLength = 0n;
  try {
    tokensLength = await getTokensLength();
  } catch (error) {
    return {
      ok: false,
      reason: `DEPOSITORY_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (tokensLength < 1n) {
    return { ok: false, reason: 'TOKEN_REGISTRY_EMPTY' };
  }

  try {
    await mintToReserve.estimateGas(STACK_COMPATIBILITY_PROBE_ENTITY, 1n, 1n);
  } catch (error) {
    return {
      ok: false,
      reason: `MINT_TO_RESERVE_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    await mintToReserveBatch.estimateGas([[STACK_COMPATIBILITY_PROBE_ENTITY, 1n, 1n]]);
  } catch (error) {
    return {
      ok: false,
      reason: `MINT_TO_RESERVE_BATCH_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, reason: 'OK' };
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

const fetchRpcCode = async (
  rpcUrl: string,
  address: string,
  timeoutMs = Math.min(STARTUP_STEP_TIMEOUT_MS, 10_000),
): Promise<string> => {
  if (!ethers.isAddress(address)) {
    throw new Error(`INVALID_PREDEPLOYED_ADDRESS:${String(address)}`);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ETH_GET_CODE_HTTP_${response.status}`);
    }

    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`ETH_GET_CODE_RPC:${body.error.message || 'unknown'}`);
    }
    if (typeof body.result !== 'string') {
      throw new Error('ETH_GET_CODE_INVALID_RESULT');
    }
    return body.result;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`ETH_GET_CODE_TIMEOUT:${address}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const isServerBootInProgress = (): boolean =>
  serverBootPhase === 'starting' || serverBootPhase === 'runtime' || serverBootPhase === 'bootstrap';

const oneShotLogs = new Map<string, number>();
const ONE_SHOT_TTL_MS = 60_000;
const logOneShot = (key: string, message: string) => {
  const nowMs = Date.now();
  const last = oneShotLogs.get(key) ?? 0;
  if (nowMs - last < ONE_SHOT_TTL_MS) return;
  oneShotLogs.set(key, nowMs);
  serverLog.warn(message);
};

const currentRuntimeHeight = (env: Env | null): number =>
  Math.max(0, Math.floor(Number(env?.height ?? 0)));

const runtimeInputStatusUrl = (id: string): string =>
  `/api/control/runtime-input/${encodeURIComponent(id)}/status`;

const SERVER_RUNTIME_SEED = (() => {
  const seed = process.env['XLN_RUNTIME_SEED']?.trim();
  if (!seed) {
    throw new Error('XLN_RUNTIME_SEED is required for runtime/server.ts');
  }
  return seed;
})();
const FAUCET_SIGNER_LABEL = process.env['FAUCET_SIGNER_LABEL'] ?? 'faucet-1';
const FAUCET_SEED = process.env['FAUCET_SEED'] ?? `${SERVER_RUNTIME_SEED}:faucet`;
const FAUCET_WALLET_ETH_TARGET = ethers.parseEther('100');
const FAUCET_TOKEN_TARGET_UNITS = 1_000_000n;
const SKIP_SERVER_BOOTSTRAP = /^(1|true)$/i.test(process.env['XLN_SKIP_SERVER_BOOTSTRAP'] ?? '');
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
  fundBrowserVmWallet: async (address: string, amount: bigint): Promise<boolean> => {
    if (!globalJAdapter?.fundSignerWallet) return false;
    await globalJAdapter.fundSignerWallet(address, amount);
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
type ServerBootPhase = 'starting' | 'runtime' | 'bootstrap' | 'ready' | 'failed';
let serverBootPhase: ServerBootPhase = 'starting';
let serverBootError: string | null = null;
let serverBootStartedAt = 0;
let serverBootCompletedAt: number | null = null;

const sendEntityInputDirectViaRelaySocket = (
  env: Env,
  targetRuntimeId: string,
  input: DeliverableEntityInput,
  ingressTimestamp?: number,
): boolean => sendEntityInputDirectViaRelaySocketInStore(relayStore, env, targetRuntimeId, input, logOneShot, ingressTimestamp);

const hasConnectedEncryptedRelayClient = (targetRuntimeId: string): boolean =>
  hasConnectedEncryptedRelayClientInStore(relayStore, targetRuntimeId);

const installProcessSafetyGuards = (): void => {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    serverLog.error('process.unhandled_rejection', { message });
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'UNHANDLED_REJECTION',
      details: { message, stack },
    });
  });

  process.on('uncaughtException', error => {
    const message = getErrorMessage(error, 'Unknown uncaught exception');
    serverLog.error('process.uncaught_exception', { message });
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'UNCAUGHT_EXCEPTION',
      details: { message, stack: error?.stack },
    });
  });
};

const buildMarketSnapshot = (
  env: Env,
  hubEntityId: string,
  pairId: string,
  depth: number,
): MarketSnapshotPayload => {
  const hubReplica = getEntityReplicaById(env, hubEntityId);
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
  getRelayStore: () => relayStore,
});

const handleApi = async (req: Request, pathname: string, env: Env | null): Promise<Response> => {
  const headers = JSON_HEADERS;

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

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
    try {
      const body = await parseTaggedControlBody<{ signerId?: unknown; privateKeyHex?: unknown }>(req);
      const signerId = typeof body?.signerId === 'string' ? body.signerId.trim().toLowerCase() : '';
      const privateKeyHex = typeof body?.privateKeyHex === 'string' ? body.privateKeyHex.trim().toLowerCase() : '';
      if (!ethers.isAddress(signerId)) {
        return new Response(
          serializeTaggedJson({ ok: false, error: 'signerId must be an EOA address' }),
          { status: 400, headers },
        );
      }
      if (!ethers.isHexString(privateKeyHex, 32)) {
        return new Response(
          serializeTaggedJson({ ok: false, error: 'privateKeyHex must be a 32-byte hex string' }),
          { status: 400, headers },
        );
      }
      registerSignerKey(signerId, ethers.getBytes(privateKeyHex));
      return new Response(
        serializeTaggedJson({
          ok: true,
          signerId,
        }),
        { headers },
      );
    } catch (error) {
      return new Response(
        serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to register signer' }),
        { status: 500, headers },
      );
    }
  }

  if (pathname === '/api/control/runtime-input' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    if (!env) {
      return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
    }
    try {
      const body = await parseTaggedControlBody<Partial<RuntimeInput>>(req);
      const runtimeTxs = Array.isArray(body?.runtimeTxs) ? body.runtimeTxs : [];
      const entityInputs = Array.isArray(body?.entityInputs) ? body.entityInputs : [];
      const jInputs = Array.isArray(body?.jInputs) ? body.jInputs : [];
      if (runtimeTxs.length === 0 && entityInputs.length === 0 && jInputs.length === 0) {
        return new Response(
          serializeTaggedJson({ ok: false, error: 'runtimeTxs, entityInputs, or jInputs are required' }),
          { status: 400, headers },
        );
      }
      enqueueRuntimeInput(env, {
        runtimeTxs,
        entityInputs,
        ...(jInputs.length > 0 ? { jInputs } : {}),
      });
      const receipt = runtimeIngressReceipts.register({
        kind: 'control-runtime-input',
        counts: {
          runtimeTxs: runtimeTxs.length,
          entityInputs: entityInputs.length,
          jInputs: jInputs.length,
        },
        enqueuedHeight: currentRuntimeHeight(env),
      });
      return new Response(
        serializeTaggedJson({
          ok: true,
          accepted: {
            runtimeTxs: runtimeTxs.length,
            entityInputs: entityInputs.length,
            jInputs: jInputs.length,
          },
          receipt,
          statusUrl: runtimeInputStatusUrl(receipt.id),
        }),
        { headers },
      );
    } catch (error) {
      return new Response(
        serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to queue runtime input' }),
        { status: 500, headers },
      );
    }
  }

  const runtimeInputStatusMatch = pathname.match(/^\/api\/control\/runtime-input\/([^/]+)\/status$/);
  if (runtimeInputStatusMatch && req.method === 'GET') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    const receiptId = decodeURIComponent(runtimeInputStatusMatch[1] || '');
    const receipt = runtimeIngressReceipts.get(receiptId);
    if (!receipt) {
      return new Response(
        serializeTaggedJson({ ok: false, error: 'Runtime input receipt not found' }),
        { status: 404, headers },
      );
    }
    return new Response(
      serializeTaggedJson({
        ok: true,
        receipt,
        currentHeight: currentRuntimeHeight(env),
      }),
      { headers },
    );
  }

  if (pathname === '/api/control/p2p' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req, env);
    if (authError) return authError;
    return handleP2PControl(req, headers, env, { parseTaggedControlBody, startP2P });
  }

  // JSON-RPC proxy endpoint (single canonical path: /rpc).
  // Keep /api/rpc for compatibility with older clients.
  if ((pathname === '/api/rpc' || pathname === '/rpc') && req.method === 'POST') {
    return handleRuntimeRpcProxy({ req, pathname, env, relayStore, headers });
  }

  // Health check
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
      getAccountMachine,
      ensureTokenCatalog: () => tokenCatalogController.ensureTokenCatalog(),
    });
  }

  const qaResponse = await maybeHandleQaRequest(req, pathname, headers);
  if (qaResponse) return qaResponse;

  if (pathname === '/api/hubs') {
    return new Response(safeStringify(buildHubDiscoveryPayload({ env, relayStore })), { headers });
  }

  if (pathname === '/api/gossip/profile') {
    const url = new URL(req.url);
    const targetEntityId = String(url.searchParams.get('entityId') || '').trim().toLowerCase();
    if (!targetEntityId) {
      return new Response(
        safeStringify({ ok: false, error: 'entityId is required' }),
        { status: 400, headers },
      );
    }

    try {
      await env?.runtimeState?.p2p?.syncProfiles?.();
    } catch {
      // best effort only
    }
    try {
      if (env) {
        await ensureGossipProfiles(env, [targetEntityId]);
      }
    } catch {
      // best effort only
    }

    const bundle = buildKnownProfileBundle({ env, relayStore, entityId: targetEntityId });
    return new Response(
      safeStringify({
        ok: true,
        entityId: targetEntityId,
        found: !!bundle.profile,
        profile: bundle.profile,
        peers: bundle.peers,
      }),
      { headers },
    );
  }

  if (pathname === '/api/jurisdictions') {
    try {
      const payload = await buildRuntimeJurisdictionsJson(env) ?? await readCanonicalJurisdictionsJson();
      return new Response(payload, {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    } catch (error: unknown) {
      return new Response(
        safeStringify({ error: getErrorMessage(error, 'Failed to read jurisdictions.json') }),
        { status: 500, headers },
      );
    }
  }

  // Runtime state
  if (pathname === '/api/state' && env) {
    return new Response(
      JSON.stringify({
        height: env.height,
        timestamp: env.timestamp,
        runtimeId: env.runtimeId,
        entityCount: env.eReplicas?.size || 0,
      }),
      { headers },
    );
  }

  // Connected clients
  if (pathname === '/api/clients') {
    return new Response(
      JSON.stringify({
        count: relayStore.clients.size,
        clients: Array.from(relayStore.clients.keys()),
      }),
      { headers },
    );
  }

  // Relay debug timeline (single source for network + critical runtime events)
  if (pathname === '/api/debug/events') {
    const url = new URL(req.url);
    const last = Math.max(1, Math.min(5000, Number(url.searchParams.get('last') || '200')));
    const event = url.searchParams.get('event') || undefined;
    const runtimeId = url.searchParams.get('runtimeId') || undefined;
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const msgType = url.searchParams.get('msgType') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const since = Number(url.searchParams.get('since') || '0');

    let filtered = relayStore.debugEvents;
    if (since > 0) filtered = filtered.filter(e => e.ts >= since);
    if (event) filtered = filtered.filter(e => e.event === event);
    if (runtimeId)
      filtered = filtered.filter(e => e.runtimeId === runtimeId || e.from === runtimeId || e.to === runtimeId);
    if (from) filtered = filtered.filter(e => e.from === from);
    if (to) filtered = filtered.filter(e => e.to === to);
    if (msgType) filtered = filtered.filter(e => e.msgType === msgType);
    if (status) filtered = filtered.filter(e => e.status === status);

    const events = filtered.slice(-last);
    return new Response(
      safeStringify({
        ok: true,
        total: relayStore.debugEvents.length,
        returned: events.length,
        serverTime: Date.now(),
        filters: { last, event, runtimeId, from, to, msgType, status, since: Number.isFinite(since) ? since : 0 },
        events,
      }),
      { headers },
    );
  }

  if (pathname === '/api/debug/events/mark' && req.method === 'POST') {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label) {
      return new Response(
        safeStringify({ ok: false, error: 'label is required' }),
        { status: 400, headers },
      );
    }

    const runtimeId = typeof body?.runtimeId === 'string' && body.runtimeId.trim().length > 0
      ? body.runtimeId.trim()
      : undefined;
    const entityId = typeof body?.entityId === 'string' && body.entityId.trim().length > 0
      ? body.entityId.trim()
      : undefined;
    const phase = typeof body?.phase === 'string' && body.phase.trim().length > 0
      ? body.phase.trim()
      : undefined;
    const details = body?.details && typeof body.details === 'object'
      ? body.details
      : undefined;

    pushDebugEvent(relayStore, {
      event: 'e2e_phase',
      runtimeId,
      status: 'mark',
      reason: label,
      details: {
        label,
        phase,
        entityId,
        details,
      },
    });

    return new Response(
      safeStringify({
        ok: true,
        label,
        runtimeId: runtimeId ?? null,
        entityId: entityId ?? null,
        phase: phase ?? null,
      }),
      { headers },
    );
  }

  const debugDumpsResponse = await maybeHandleDebugDumpsRequest({ req, pathname, relayStore, headers });
  if (debugDumpsResponse) return debugDumpsResponse;

  // Registered gossip entities (relay-authoritative public profile store)
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

  // J-event watching is handled by JAdapter.startWatching() per-jReplica

  // Token catalog (for UI token list + deposits)
  if (pathname === '/api/tokens') {
    return await externalWalletApi.handleTokens();
  }

  // ============================================================================
  // FAUCET ENDPOINTS
  // ============================================================================

  // Faucet A: External ERC20 → user wallet
  if (pathname === '/api/faucet/erc20' && req.method === 'POST') {
    return await externalWalletApi.handleErc20Faucet(req);
  }

  // Faucet A2: Gas-only topup (for approve/deposit)
  if (pathname === '/api/faucet/gas' && req.method === 'POST') {
    return await externalWalletApi.handleGasFaucet(req);
  }

  // Faucet B: Hub reserve → user reserve via processBatch
  if (pathname === '/api/faucet/reserve' && req.method === 'POST') {
    return handleReserveFaucet({
      req,
      env,
      headers,
      relayStore,
      getJAdapter: () => globalJAdapter,
      ensureTokenCatalog: () => tokenCatalogController.ensureTokenCatalog(),
      enqueueRuntimeInput,
    });
  }

  // Faucet C: Offchain payment via bilateral account
  if (pathname === '/api/faucet/offchain' && req.method === 'POST') {
    return handleOffchainFaucet({
      req,
      env,
      headers,
      relayStore,
      enqueueRuntimeInput,
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
    });
  }

  return new Response(safeStringify({ error: 'Not found' }), { status: 404, headers });
};

export async function startXlnServer(opts: Partial<XlnServerOptions> = {}): Promise<void> {
  installProcessSafetyGuards();
  const options = { ...DEFAULT_OPTIONS, ...opts };
  serverLog.info('start', { port: options.port, host: options.host, staticDir: options.staticDir });
  relayStore = createRelayStore(options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server');
  marketSubscriptionStack.clear();
  const internalRelayUrl = resolveConfiguredRelayUrl(options.port);
  serverBootStartedAt = Date.now();
  serverBootCompletedAt = null;
  serverBootPhase = 'starting';
  serverBootError = null;
  serverStartupBarrier = new Promise<void>(resolve => {
    resolveServerStartupBarrier = resolve;
  });

  let env: Env | null = null;
  let routerConfig: RelayRouterConfig | null = null;

  const createHttpServer = () => Bun.serve({
    port: options.port,
    hostname: options.host ?? '127.0.0.1',

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.headers.get('upgrade') === 'websocket') {
        const wsType = pathname === '/relay' ? 'relay' : pathname === '/rpc' ? 'rpc' : null;
        if (wsType) {
          const upgraded = server.upgrade(req, { data: { type: wsType, clientIp: resolveRequestClientIp(req) } });
          if (upgraded) return;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      if (
        pathname.startsWith('/api/') ||
        pathname === '/rpc'
      ) {
        try {
          return await handleApi(req, pathname, env);
        } catch (error) {
          const message = (error as Error)?.message || 'API handler failed';
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
    },

    websocket: {
      open(ws: RelaySocket) {
        const data = ws.data;
        serverLog.info('ws.open', { type: data.type });
        if (data.type === 'rpc' && env) {
          attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
        }
        pushDebugEvent(relayStore, {
          event: 'ws_open',
          details: { wsType: data.type },
        });
      },

      message(ws: RelaySocket, message) {
        const data = ws.data;
        try {
          const msg = data.type === 'rpc'
            ? decodeRuntimeAdapterMessage<Record<string, unknown>>(message)
            : JSON.parse(message.toString());
          const routeRelayMessage = () => {
            if (!routerConfig) {
              ws.send(safeStringify({ type: 'error', error: 'Runtime transport not ready' }));
              return;
            }
            Promise.resolve(relayRoute(routerConfig, ws, msg)).catch(error => {
              const reason = (error as Error).message || 'relay handler error';
              serverLog.error('ws.relay_handler_error', { reason, type: msg?.type });
              pushDebugEvent(relayStore, {
                event: 'error',
                reason: 'RELAY_HANDLER_EXCEPTION',
                details: {
                  error: reason,
                  msgType: msg?.type,
                  from: msg?.from,
                  to: msg?.to,
                },
              });
              try {
                ws.send(safeStringify({ type: 'error', error: 'Relay handler exception' }));
              } catch {
                // Socket may already be closed; ignore.
              }
            });
          };
          if (data.type === 'relay') {
            if (isMarketMessageType(msg?.type)) {
              Promise.resolve(marketSubscriptionStack.handleMessage(ws, msg as Record<string, unknown>)).catch(error => {
                const reason = (error as Error).message || 'market handler error';
                serverLog.error('ws.market_handler_error', { reason, type: msg?.type });
                pushDebugEvent(relayStore, {
                  event: 'error',
                  reason: 'MARKET_HANDLER_EXCEPTION',
                  details: { error: reason, msgType: msg?.type },
                });
                try {
                  ws.send(safeStringify({ type: 'error', error: reason }));
                } catch {}
              });
              return;
            }
            if (!routerConfig) {
              if (isServerBootInProgress()) {
                void serverStartupBarrier.then(() => {
                  routeRelayMessage();
                });
                return;
              }
              ws.send(safeStringify({ type: 'error', error: 'Runtime transport not ready' }));
              return;
            }
            routeRelayMessage();
          } else if (data.type === 'rpc') {
            Promise.resolve(handleRpcMessage(ws, msg, env)).catch(error => {
              const reason = (error as Error).message || 'rpc handler error';
              serverLog.error('ws.rpc_handler_error', { reason, type: msg?.type });
              pushDebugEvent(relayStore, {
                event: 'error',
                reason: 'RPC_HANDLER_EXCEPTION',
                details: { error: reason, msgType: msg?.type },
              });
              try {
                ws.send(safeStringify({ type: 'error', error: 'RPC handler exception' }));
              } catch {
                // Socket may already be closed; ignore.
              }
            });
          }
        } catch (error) {
          const byteLength = data.type === 'rpc' ? runtimeAdapterMessageByteLength(message) : message.toString().length;
          serverLog.error('ws.parse_error', {
            type: data.type,
            len: byteLength,
            error: getErrorMessage(error),
          });
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: data.type === 'rpc' ? 'Invalid runtime adapter message' : 'Invalid JSON',
            details: { wsType: data.type, len: byteLength, error: (error as Error).message },
          });
          if (data.type === 'rpc') {
            closeInvalidRuntimeAdapterMessage(ws, error);
          } else {
            ws.send(safeStringify({ type: 'error', error: 'Invalid JSON' }));
          }
        }
      },

      close(ws: RelaySocket, code, reason) {
        cleanupRpcMarketSubscription(ws);
        forgetRuntimeAdapterClient(ws);
        forgetRelaySocketRuntimeId(ws);
        const removedId = removeClient(relayStore, ws);
        const wsType = ws.data.type;
        const reasonText =
          typeof reason === 'string'
            ? reason
            : reason
              ? String(reason)
              : '';
        serverLog.warn('ws.close', {
          type: wsType,
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
              wsType,
              code: Number(code || 0),
              reason: reasonText || null,
            },
          });
        }
      },
    },
  });
  const server = createHttpServer();
  void server;

  try {
    serverBootPhase = 'runtime';
    serverLog.info('runtime.init.start');
    env = await main(SERVER_RUNTIME_SEED);
    serverEnv = env;
    registerEnvChangeCallback(env, (nextEnv) => {
      runtimeIngressReceipts.observeHeight(currentRuntimeHeight(nextEnv));
    });
    serverLog.info('runtime.init.ready', { runtimeId: shortId(env.runtimeId, 10) });
    const runtimeEnv = env;
    const verboseRuntimeLogs = /^(1|true)$/i.test(process.env['RUNTIME_VERBOSE_LOGS'] ?? '');
    env.quietRuntimeLogs = !verboseRuntimeLogs;
    serverLog.info('runtime.log_mode', { mode: env.quietRuntimeLogs ? 'quiet' : 'verbose' });
    env.runtimeState = env.runtimeState ?? {};
    env.runtimeState.directEntityInputDispatch = (targetRuntimeId, input, ingressTimestamp) =>
      sendEntityInputDirectViaRelaySocket(runtimeEnv, targetRuntimeId, input, ingressTimestamp);
    env.runtimeState.canUseConnectedRelayFallback = hasConnectedEncryptedRelayClient;
    startRuntimeLoop(env);
    serverLog.info('runtime.loop.started');

    // Initialize J-adapter (anvil for testnet, browserVM for local)
    const useAnvil = process.env['USE_ANVIL'] === 'true';
    const anvilRpc = useAnvil ? resolveRequiredAnvilRpc() : '';

    serverLog.info('jadapter.mode', { useAnvil, anvilRpc: useAnvil ? anvilRpc : null });

    if (useAnvil) {
      serverLog.info('anvil.connect.start', { rpc: anvilRpc });
      const usePredeployedAddresses = process.env['XLN_USE_PREDEPLOYED_ADDRESSES'] === 'true';

    // Optional: reuse addresses from jurisdictions.json (disabled by default).
    const fs = await import('fs/promises');
    let fromReplica: JAdapterConfig['fromReplica'] | undefined = undefined;
    if (usePredeployedAddresses) {
      try {
        const jurisdictionsPath = resolveJurisdictionsJsonPath();
        serverLog.info('anvil.predeployed.load', { path: jurisdictionsPath });
        const jurisdictionsData = await fs.readFile(jurisdictionsPath, 'utf-8');
        const jurisdictions = JSON.parse(jurisdictionsData);
        const arrakisConfig = jurisdictions?.jurisdictions?.arrakis;

        if (arrakisConfig?.contracts) {
          fromReplica = {
            depositoryAddress: arrakisConfig.contracts.depository,
            entityProviderAddress: arrakisConfig.contracts.entityProvider,
            contracts: arrakisConfig.contracts,
            chainId: arrakisConfig.chainId ?? 31337,
          } as JAdapterConfig['fromReplica'];
          serverLog.info('anvil.predeployed.loaded');
        }
      } catch (err) {
        serverLog.warn('anvil.predeployed.load_failed', { error: (err as Error).message });
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
        const probe = new ethers.JsonRpcProvider(anvilRpc);
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
        serverLog.warn('anvil.predeployed.stale_code', {
          depository: fromReplicaDepositoryAddress,
          depositoryCode,
          entityProvider: fromReplicaEntityProviderAddress,
          entityProviderCode,
        });
        fromReplica = undefined;
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
      serverLog.warn('anvil.stack_incompatible', { reason });
      await globalJAdapter?.close().catch(() => undefined);
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

    if (globalJAdapter.addresses?.depository && globalJAdapter.addresses?.entityProvider) {
      await withStartupStepTimeout(
        'updateJurisdictionsJson',
        updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId),
      );
    }

    // Ensure env has a J-replica for this RPC jurisdiction (required for j_broadcast → j-mempool)
    if (globalJAdapter && env) {
      if (!env.jReplicas) env.jReplicas = new Map();
      const jName = 'arrakis';
      if (!env.jReplicas.has(jName)) {
        env.jReplicas.set(jName, {
          name: jName,
          blockNumber: 0n,
          stateRoot: new Uint8Array(32),
          mempool: [],
          blockDelayMs: 300,
          lastBlockTimestamp: env.timestamp,
          position: { x: 0, y: 50, z: 0 },
          depositoryAddress: globalJAdapter.addresses.depository,
          entityProviderAddress: globalJAdapter.addresses.entityProvider,
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
          env.jReplicas.set(jName, {
            name: jName,
            blockNumber: 0n,
            stateRoot: new Uint8Array(32),
            mempool: [],
            blockDelayMs: 300,
            lastBlockTimestamp: env.timestamp,
            position: { x: 0, y: 50, z: 0 },
            depositoryAddress: globalJAdapter.addresses.depository,
            entityProviderAddress: globalJAdapter.addresses.entityProvider,
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

    // J-event watching belongs to the unified runtime loop. The server should
    // wire jReplicas only; startRuntimeLoop() owns startJurisdictionWatchers().

    // Wire relay-router + local delivery as soon as env exists.
    // Relay WS can receive early hello/gossip traffic during bootstrap.
    const localDeliver = createLocalDeliveryHandler(env, relayStore, getEntityReplicaById);
    routerConfig = {
      store: relayStore,
      localRuntimeId: String(env.runtimeId),
      localDeliver,
      send: (ws, data) => ws.send(data),
      onGossipStore: profile => {
        try {
          runtimeEnv.gossip?.announce?.(profile);
        } catch {
          /* best effort */
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
    return;
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
      if (serverBootPhase === 'ready') {
        serverLog.info('cli.ready');
        return;
      }
      serverLog.warn('cli.http_listening_startup_not_ready', {
        phase: serverBootPhase,
        error: serverBootError,
      });
    })
    .catch(error => {
      serverLog.error('cli.failed', { error: getErrorMessage(error), stack: error.stack });
      process.exit(1);
    });
}
