#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { safeStringify } from '../serialization-utils';
import {
  createRelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
  removeClient,
  type RelayStore,
} from '../relay-store';
import { relayRoute, type RelayRouterConfig } from '../relay-router';

type Args = {
  host: string;
  port: number;
  rpcUrl: string;
  dbRoot: string;
  mmEnabled: boolean;
};

type StageTiming = {
  startedAt: number | null;
  completedAt: number | null;
  ms: number | null;
};

type TimingMap = Record<string, StageTiming>;

type ResetState = {
  inProgress: boolean;
  lastError: string | null;
  startedAt: number | null;
  completedAt: number | null;
  requestedMarketMaker: boolean;
};

type HubProcessSpec = {
  name: 'H1' | 'H2' | 'H3';
  region: string;
  seed: string;
  signerLabel: string;
  apiPort: number;
  dbPath: string;
  deployTokens: boolean;
};

type HubChild = HubProcessSpec & {
  proc: ChildProcessWithoutNullStreams | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  lastHealth: HubHealthPayload | null;
  lastInfo: HubInfoPayload | null;
};

type HubHealthPayload = {
  ok?: boolean;
  name?: string;
  entityId?: string | null;
  runtimeId?: string | null;
  relayUrl?: string;
  apiUrl?: string;
  gossip?: {
    visibleHubNames?: string[];
    visibleHubIds?: string[];
    ready?: boolean;
  };
  mesh?: {
    ready?: boolean;
    pairs?: Array<{
      counterpartyId: string;
      counterpartyName: string;
      hasAccount: boolean;
      grantedByMe: string;
      grantedByPeer: string;
      ready: boolean;
    }>;
  };
  bootstrapReserves?: {
    ok: boolean;
    tokens: Array<{
      tokenId: number;
      symbol: string;
      decimals: number;
      current: string;
      expectedMin: string;
      ready: boolean;
    }>;
  };
  timings?: TimingMap;
};

type HubInfoPayload = {
  name?: string;
  entityId?: string;
  runtimeId?: string;
  apiUrl?: string;
  relayUrl?: string;
};

type AggregatedHealth = {
  timestamp: number;
  reset: ResetState;
  system: {
    runtime: boolean;
    relay: boolean;
  };
  hubMesh: {
    ok: boolean;
    hubIds: string[];
    pairs: Array<{ left: string; right: string; ok: boolean }>;
  };
  marketMaker: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    expectedOffersPerHub: number;
    hubs: Array<{ hubEntityId: string; offers: number; ready: boolean }>;
  };
  bootstrapReserves: {
    ok: boolean;
    requiredTokenCount: number;
    entityCount: number;
    entities: Array<{
      entityId: string;
      role: 'hub' | 'market-maker';
      ready: boolean;
      tokens: Array<{
        tokenId: number;
        symbol: string;
        decimals: number;
        current: string;
        expectedMin: string;
        ready: boolean;
      }>;
    }>;
  };
  hubs: Array<{
    entityId: string;
    name: string;
    online: boolean;
    runtimeId: string;
    activeClients: string[];
  }>;
  timings: TimingMap;
};

const HUB_NAMES = ['H1', 'H2', 'H3'] as const;
const HUB_REQUIRED_TOKEN_COUNT = 3;

const argsRaw = process.argv.slice(2);

const getArg = (name: string, fallback = ''): string => {
  const eq = argsRaw.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argsRaw.indexOf(name);
  if (index === -1) return fallback;
  return argsRaw[index + 1] || fallback;
};

const hasFlag = (name: string): boolean => argsRaw.includes(name);

const parseArgs = (): Args => {
  const port = Number(getArg('--port', '20002'));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port: ${String(port)}`);
  }
  return {
    host: getArg('--host', '127.0.0.1'),
    port,
    rpcUrl: getArg('--rpc-url', process.env.ANVIL_RPC || 'http://127.0.0.1:8545'),
    dbRoot: resolve(getArg('--db-root', join(process.cwd(), '.e2e-mesh-db'))),
    mmEnabled: hasFlag('--mm'),
  };
};

const args = parseArgs();
const relayUrl = `ws://${args.host}:${args.port}/relay`;
const shardJurisdictionsPath = join(args.dbRoot, 'jurisdictions.json');

const relayStore: RelayStore = createRelayStore('e2e-mesh-relay');
const routerConfig: RelayRouterConfig = {
  store: relayStore,
  localRuntimeId: 'e2e-mesh-relay',
  localDeliver: async () => {},
  send: (ws, data) => ws.send(data),
};

const timings: TimingMap = {
  reset_total: { startedAt: null, completedAt: null, ms: null },
  reset_stop_children: { startedAt: null, completedAt: null, ms: null },
  reset_clear_state: { startedAt: null, completedAt: null, ms: null },
  reset_spawn_h1: { startedAt: null, completedAt: null, ms: null },
  reset_wait_h1: { startedAt: null, completedAt: null, ms: null },
  reset_spawn_h23: { startedAt: null, completedAt: null, ms: null },
  reset_wait_hubs: { startedAt: null, completedAt: null, ms: null },
};

const resetState: ResetState = {
  inProgress: false,
  lastError: null,
  startedAt: null,
  completedAt: null,
  requestedMarketMaker: args.mmEnabled,
};

const hubChildren: HubChild[] = HUB_NAMES.map((name, index) => ({
  name,
  region: 'global',
  seed: `xln-e2e-${name.toLowerCase()}`,
  signerLabel: `${name.toLowerCase()}-hub`,
  apiPort: args.port + 10 + index,
  dbPath: join(args.dbRoot, name.toLowerCase()),
  deployTokens: index === 0,
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  lastHealth: null,
  lastInfo: null,
}));

let resetPromise: Promise<void> | null = null;

const startTiming = (stage: keyof typeof timings): number => {
  const now = Date.now();
  timings[stage].startedAt = now;
  timings[stage].completedAt = null;
  timings[stage].ms = null;
  return now;
};

const finishTiming = (stage: keyof typeof timings, startedAt: number): void => {
  const completedAt = Date.now();
  timings[stage].completedAt = completedAt;
  timings[stage].ms = completedAt - startedAt;
  console.log(`[E2E-TIMING] ${stage} ${timings[stage].ms}ms`);
};

const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const stopProcess = async (proc: ChildProcessWithoutNullStreams | null): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 4_000;
  while (proc.exitCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
  }
};

const clearRelayState = (): void => {
  for (const [, client] of relayStore.clients.entries()) {
    try {
      client.ws.close(4000, 'mesh-reset');
    } catch {
      try { client.ws.close(); } catch {}
    }
  }
  relayStore.clients.clear();
  relayStore.pendingMessages.clear();
  relayStore.gossipProfiles.clear();
  relayStore.runtimeEncryptionKeys.clear();
  relayStore.activeHubEntityIds = [];
  relayStore.debugEvents.length = 0;
  relayStore.debugId = 0;
  relayStore.wsCounter = 0;
};

const fetchJson = async <T>(url: string, timeoutMs = 2_000): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const fetchText = async (url: string, timeoutMs = 2_000): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const readShardJurisdictions = (): string => {
  if (!existsSync(shardJurisdictionsPath)) {
    throw new Error(`JURISDICTIONS_JSON_MISSING path=${shardJurisdictionsPath}`);
  }
  return readFileSync(shardJurisdictionsPath, 'utf8');
};

const pollHubHealth = async (child: HubChild): Promise<void> => {
  const apiBase = `http://${args.host}:${child.apiPort}`;
  child.lastInfo = await fetchJson<HubInfoPayload>(`${apiBase}/api/info`, 1_500);
  child.lastHealth = await fetchJson<HubHealthPayload>(`${apiBase}/api/health`, 1_500);
  const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').toLowerCase();
  if (entityId) {
    relayStore.activeHubEntityIds = Array.from(
      new Set([...relayStore.activeHubEntityIds, entityId]),
    );
  }
};

const pollAllHubHealth = async (): Promise<void> => {
  await Promise.all(hubChildren.map(child => pollHubHealth(child)));
};

const getHubSpecsArg = (): string => HUB_NAMES.join(',');

const spawnHub = (child: HubChild): void => {
  mkdirSync(child.dbPath, { recursive: true });
  const cmd = [
    'runtime/scripts/e2e-hub-node.ts',
    '--name', child.name,
    '--region', child.region,
    '--seed', child.seed,
    '--signer-label', child.signerLabel,
    '--relay-url', relayUrl,
    '--api-host', args.host,
    '--api-port', String(child.apiPort),
    '--rpc-url', args.rpcUrl,
    '--mesh-hub-names', getHubSpecsArg(),
    '--db-path', child.dbPath,
    ...(child.deployTokens ? ['--deploy-tokens'] : []),
  ];
  child.startedAt = Date.now();
  child.exitedAt = null;
  child.exitCode = null;
  child.lastHealth = null;
  child.lastInfo = null;
  child.proc = spawn('bun', cmd, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XLN_DB_PATH: child.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ANVIL_RPC: args.rpcUrl,
      USE_ANVIL: 'true',
    },
  });
  child.proc.stdout.on('data', chunk => {
    process.stdout.write(`[${child.name}] ${chunk.toString()}`);
  });
  child.proc.stderr.on('data', chunk => {
    process.stderr.write(`[${child.name}:err] ${chunk.toString()}`);
  });
  child.proc.once('exit', code => {
    child.exitedAt = Date.now();
    child.exitCode = code;
    if (!resetState.inProgress) {
      console.error(`[E2E-MESH] ${child.name} exited unexpectedly with code=${String(code)}`);
    }
  });
};

const stopAllChildren = async (): Promise<void> => {
  await Promise.all(hubChildren.map(async child => {
    const proc = child.proc;
    child.proc = null;
    await stopProcess(proc);
  }));
};

const computeAggregatedHealth = (): AggregatedHealth => {
  const hubs = hubChildren.map((child) => {
    const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '');
    const runtimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '');
    const online = child.proc?.exitCode === null && Boolean(child.lastHealth);
    return {
      entityId,
      name: child.name,
      online,
      runtimeId,
      activeClients: runtimeId ? [runtimeId] : [],
    };
  });

  const hubIds = hubs
    .map(hub => hub.entityId.toLowerCase())
    .filter(entityId => entityId.length > 0);

  const pairSet = new Map<string, { left: string; right: string; ok: boolean }>();
  for (const child of hubChildren) {
    const left = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').toLowerCase();
    for (const pair of child.lastHealth?.mesh?.pairs ?? []) {
      const right = String(pair.counterpartyId || '').toLowerCase();
      if (!left || !right) continue;
      const key = [left, right].sort().join(':');
      pairSet.set(key, {
        left: [left, right].sort()[0]!,
        right: [left, right].sort()[1]!,
        ok: pair.ready === true,
      });
    }
  }

  const reserveEntities = hubChildren
    .map((child) => {
      const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '');
      if (!entityId) return null;
      return {
        entityId,
        role: 'hub' as const,
        ready: child.lastHealth?.bootstrapReserves?.ok === true,
        tokens: child.lastHealth?.bootstrapReserves?.tokens ?? [],
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  return {
    timestamp: Date.now(),
    reset: { ...resetState },
    system: {
      runtime: true,
      relay: true,
    },
    hubMesh: {
      ok:
        hubIds.length === HUB_NAMES.length &&
        hubChildren.every((child) => child.lastHealth?.mesh?.ready === true),
      hubIds,
      pairs: Array.from(pairSet.values()).sort((left, right) =>
        `${left.left}:${left.right}`.localeCompare(`${right.left}:${right.right}`),
      ),
    },
    marketMaker: {
      enabled: resetState.requestedMarketMaker,
      ok: resetState.requestedMarketMaker ? false : true,
      entityId: null,
      expectedOffersPerHub: 0,
      hubs: hubIds.map((hubEntityId) => ({
        hubEntityId,
        offers: 0,
        ready: !resetState.requestedMarketMaker,
      })),
    },
    bootstrapReserves: {
      ok:
        reserveEntities.length === HUB_NAMES.length &&
        reserveEntities.every((entity) => entity.ready),
      requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
      entityCount: reserveEntities.length,
      entities: reserveEntities,
    },
    hubs,
    timings,
  };
};

const getDebugEntityEntries = (requestUrl: URL): Array<{
  entityId: string;
  runtimeId?: string;
  name: string;
  isHub: boolean;
  online: boolean;
  lastUpdated: number;
  capabilities: string[];
  accounts: unknown[];
  publicAccounts: unknown[];
  metadata: Record<string, unknown>;
}> => {
  const q = (requestUrl.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(5000, Number(requestUrl.searchParams.get('limit') || '1000')));
  const onlineOnly = requestUrl.searchParams.get('online') === 'true';

  const entities = new Map<string, {
    entityId: string;
    runtimeId?: string;
    name: string;
    isHub: boolean;
    online: boolean;
    lastUpdated: number;
    capabilities: string[];
    accounts: unknown[];
    publicAccounts: unknown[];
    metadata: Record<string, unknown>;
  }>();

  for (const [entityId, entry] of relayStore.gossipProfiles.entries()) {
    const profile = entry.profile || {};
    const runtimeId = typeof profile.runtimeId === 'string' ? profile.runtimeId : undefined;
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    const metadata =
      profile?.metadata && typeof profile.metadata === 'object'
        ? profile.metadata as Record<string, unknown>
        : {};
    const capabilities = Array.isArray(profile?.capabilities) ? profile.capabilities : [];
    const isHub =
      profile?.metadata?.isHub === true ||
      capabilities.includes('hub') ||
      capabilities.includes('routing');
    const name =
      typeof profile?.metadata?.name === 'string' && profile.metadata.name.trim().length > 0
        ? profile.metadata.name.trim()
        : entityId;
    const online = normalizedRuntimeId ? relayStore.clients.has(normalizedRuntimeId) : false;
    entities.set(entityId.toLowerCase(), {
      entityId,
      runtimeId: normalizedRuntimeId || runtimeId,
      name,
      isHub,
      online,
      lastUpdated: Number(profile?.metadata?.lastUpdated || entry.timestamp || 0),
      capabilities,
      accounts: Array.isArray(profile?.accounts) ? profile.accounts : [],
      publicAccounts: Array.isArray(profile?.publicAccounts) ? profile.publicAccounts : [],
      metadata,
    });
  }

  for (const child of hubChildren) {
    const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '');
    if (!entityId) continue;
    const key = entityId.toLowerCase();
    const runtimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '') || undefined;
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    const existing = entities.get(key);
    const online = child.proc?.exitCode === null && Boolean(child.lastHealth);
    entities.set(key, {
      entityId,
      runtimeId: normalizedRuntimeId || runtimeId || existing?.runtimeId,
      name: existing?.name || child.name,
      isHub: true,
      online: existing?.online === true || online,
      lastUpdated: Math.max(existing?.lastUpdated || 0, Date.now()),
      capabilities: existing?.capabilities || ['hub', 'routing'],
      accounts: existing?.accounts || [],
      publicAccounts: existing?.publicAccounts || [],
      metadata: {
        ...(existing?.metadata || {}),
        name: existing?.metadata?.name || child.name,
        isHub: true,
      },
    });
  }

  return Array.from(entities.values())
    .filter((entity) => {
      if (onlineOnly && !entity.online) return false;
      if (!q) return true;
      const blob =
        `${entity.entityId} ${entity.runtimeId || ''} ${entity.name} ${JSON.stringify(entity.capabilities || [])}`.toLowerCase();
      return blob.includes(q);
    })
    .sort((left, right) => (right.lastUpdated || 0) - (left.lastUpdated || 0))
    .slice(0, limit);
};

const waitForHubBaseline = async (): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await pollAllHubHealth();
    const health = computeAggregatedHealth();
    if (
      health.hubMesh.ok &&
      health.bootstrapReserves.ok &&
      health.hubs.every(hub => hub.online)
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`HUB_BASELINE_TIMEOUT ${safeStringify(computeAggregatedHealth())}`);
};

const waitForSingleHubReady = async (child: HubChild): Promise<void> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await pollHubHealth(child);
    if (
      child.lastHealth?.bootstrapReserves?.ok === true &&
      typeof child.lastInfo?.entityId === 'string' &&
      child.lastInfo.entityId.length > 0
    ) {
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(`${child.name}_EXITED_EARLY code=${String(child.proc?.exitCode)}`);
    }
    await delay(250);
  }
  throw new Error(`${child.name}_READY_TIMEOUT ${safeStringify(child.lastHealth)}`);
};

const waitForShardJurisdictions = async (child: HubChild): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(shardJurisdictionsPath)) {
      return;
    }
    const payload = await fetchText(`http://${args.host}:${child.apiPort}/api/jurisdictions`);
    if (payload) {
      writeFileSync(shardJurisdictionsPath, payload, 'utf8');
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(`${child.name}_EXITED_BEFORE_JURISDICTIONS code=${String(child.proc?.exitCode)}`);
    }
    await delay(150);
  }
  throw new Error(`${child.name}_JURISDICTIONS_TIMEOUT path=${shardJurisdictionsPath}`);
};

const runReset = async (requestedMarketMaker: boolean): Promise<void> => {
  resetState.inProgress = true;
  resetState.lastError = null;
  resetState.startedAt = Date.now();
  resetState.completedAt = null;
  resetState.requestedMarketMaker = requestedMarketMaker;

  const resetTotalStartedAt = startTiming('reset_total');
  try {
    const stopStartedAt = startTiming('reset_stop_children');
    await stopAllChildren();
    finishTiming('reset_stop_children', stopStartedAt);

    const clearStartedAt = startTiming('reset_clear_state');
    clearRelayState();
    if (existsSync(args.dbRoot)) {
      rmSync(args.dbRoot, { recursive: true, force: true });
    }
    mkdirSync(args.dbRoot, { recursive: true });
    finishTiming('reset_clear_state', clearStartedAt);

    const h1 = hubChildren[0]!;
    const h23 = hubChildren.slice(1);

    const spawnH1StartedAt = startTiming('reset_spawn_h1');
    spawnHub(h1);
    finishTiming('reset_spawn_h1', spawnH1StartedAt);

    const waitH1StartedAt = startTiming('reset_wait_h1');
    await waitForSingleHubReady(h1);
    finishTiming('reset_wait_h1', waitH1StartedAt);
    await waitForShardJurisdictions(h1);

    const spawnH23StartedAt = startTiming('reset_spawn_h23');
    for (const child of h23) {
      spawnHub(child);
    }
    finishTiming('reset_spawn_h23', spawnH23StartedAt);

    const waitStartedAt = startTiming('reset_wait_hubs');
    await waitForHubBaseline();
    finishTiming('reset_wait_hubs', waitStartedAt);

    finishTiming('reset_total', resetTotalStartedAt);
    resetState.completedAt = Date.now();
  } catch (error) {
    resetState.lastError = serializeError(error);
    resetState.completedAt = Date.now();
    throw error;
  } finally {
    resetState.inProgress = false;
  }
};

const ensureReset = async (requestedMarketMaker: boolean): Promise<void> => {
  if (resetPromise) {
    await resetPromise;
    if (resetState.requestedMarketMaker === requestedMarketMaker && !resetState.lastError) {
      return;
    }
  }
  resetPromise = runReset(requestedMarketMaker).finally(() => {
    resetPromise = null;
  });
  await resetPromise;
};

const parseResetRequest = async (request: Request): Promise<boolean> => {
  const url = new URL(request.url);
  const mmParam = url.searchParams.get('mm');
  if (mmParam === '1' || mmParam === 'true') return true;
  if (mmParam === '0' || mmParam === 'false') return false;
  if (request.method !== 'POST') return args.mmEnabled;
  try {
    const body = await request.clone().json() as { marketMaker?: boolean; requireMarketMaker?: boolean };
    if (typeof body.marketMaker === 'boolean') return body.marketMaker;
    if (typeof body.requireMarketMaker === 'boolean') return body.requireMarketMaker;
  } catch {
    // ignore invalid body
  }
  return args.mmEnabled;
};

const proxyRpc = async (request: Request): Promise<Response> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };
  try {
    const bodyText = await request.text();
    const response = await fetch(args.rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type') || 'application/json',
      },
      body: bodyText,
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        ...headers,
        'content-type': response.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: serializeError(error), upstream: args.rpcUrl }),
      { status: 502, headers },
    );
  }
};

const proxyHubApi = async (
  request: Request,
  endpoint: '/api/faucet/offchain',
): Promise<Response> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };
  let bodyText = '';
  let bodyJson: { hubEntityId?: string } | null = null;
  try {
    bodyText = await request.text();
    bodyJson = bodyText ? JSON.parse(bodyText) as { hubEntityId?: string } : {};
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: `Invalid JSON: ${serializeError(error)}` }), {
      status: 400,
      headers,
    });
  }

  await pollAllHubHealth();
  const requestedHubId = String(bodyJson?.hubEntityId || '').toLowerCase();
  const child = hubChildren.find((candidate) => {
    const entityId = String(candidate.lastInfo?.entityId || candidate.lastHealth?.entityId || '').toLowerCase();
    return entityId.length > 0 && entityId === requestedHubId;
  });
  if (!child) {
    return new Response(JSON.stringify({
      success: false,
      error: `Hub not found for hubEntityId=${requestedHubId || 'missing'}`,
      code: 'FAUCET_HUB_NOT_FOUND',
    }), {
      status: 404,
      headers,
    });
  }

  try {
    const response = await fetch(`http://${args.host}:${child.apiPort}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type') || 'application/json',
      },
      body: bodyText,
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        ...headers,
        'content-type': response.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: serializeError(error),
      code: 'FAUCET_PROXY_FAILED',
    }), {
      status: 502,
      headers,
    });
  }
};

const server = Bun.serve({
  hostname: args.host,
  port: args.port,
  async fetch(request, serverRef) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.headers.get('upgrade') === 'websocket' && pathname === '/relay') {
      const upgraded = serverRef.upgrade(request, { data: { type: 'relay' } });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    if ((pathname === '/rpc' || pathname === '/api/rpc') && request.method === 'POST') {
      return await proxyRpc(request);
    }

    if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
      return await proxyHubApi(request, '/api/faucet/offchain');
    }

    if (pathname === '/api/health') {
      await pollAllHubHealth();
      return new Response(JSON.stringify(computeAggregatedHealth()), { headers });
    }

    if (pathname === '/api/debug/entities') {
      await pollAllHubHealth();
      const entities = getDebugEntityEntries(url).map((entity) => {
        const hubChild = hubChildren.find((child) => {
          const childEntityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').toLowerCase();
          return childEntityId === entity.entityId.toLowerCase();
        });
        return {
          ...entity,
          apiPort: hubChild?.apiPort ?? null,
          exitCode: hubChild?.exitCode ?? null,
          dbPath: hubChild?.dbPath ?? null,
        };
      });
      return new Response(JSON.stringify({ entities }), { headers });
    }

    if (pathname === '/api/debug/events') {
      const last = Math.max(1, Math.min(5000, Number(url.searchParams.get('last') || '200')));
      const event = url.searchParams.get('event') || undefined;
      const runtimeId = url.searchParams.get('runtimeId') || undefined;
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const msgType = url.searchParams.get('msgType') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const since = Number(url.searchParams.get('since') || '0');

      let filtered = relayStore.debugEvents;
      if (since > 0) filtered = filtered.filter((entry) => entry.ts >= since);
      if (event) filtered = filtered.filter((entry) => entry.event === event);
      if (runtimeId) {
        filtered = filtered.filter((entry) =>
          entry.runtimeId === runtimeId || entry.from === runtimeId || entry.to === runtimeId,
        );
      }
      if (from) filtered = filtered.filter((entry) => entry.from === from);
      if (to) filtered = filtered.filter((entry) => entry.to === to);
      if (msgType) filtered = filtered.filter((entry) => entry.msgType === msgType);
      if (status) filtered = filtered.filter((entry) => entry.status === status);

      const events = filtered.slice(-last);
      return new Response(safeStringify({
        ok: true,
        total: relayStore.debugEvents.length,
        returned: events.length,
        serverTime: Date.now(),
        filters: {
          last,
          event,
          runtimeId,
          from,
          to,
          msgType,
          status,
          since: Number.isFinite(since) ? since : 0,
        },
        events,
      }), { headers });
    }

    if (pathname === '/api/debug/events/mark' && request.method === 'POST') {
      const body = await request.json().catch(() => ({} as Record<string, unknown>));
      const label = typeof body?.label === 'string' ? body.label.trim() : '';
      if (!label) {
        return new Response(safeStringify({ ok: false, error: 'label is required' }), {
          status: 400,
          headers,
        });
      }
      const runtimeId =
        typeof body?.runtimeId === 'string' && body.runtimeId.trim().length > 0
          ? body.runtimeId.trim()
          : undefined;
      const entityId =
        typeof body?.entityId === 'string' && body.entityId.trim().length > 0
          ? body.entityId.trim()
          : undefined;
      const phase =
        typeof body?.phase === 'string' && body.phase.trim().length > 0
          ? body.phase.trim()
          : undefined;
      const details =
        body?.details && typeof body.details === 'object'
          ? body.details
          : undefined;
      pushDebugEvent(relayStore, {
        event: 'e2e_phase',
        runtimeId,
        status: 'marked',
        details: {
          label,
          ...(entityId ? { entityId } : {}),
          ...(phase ? { phase } : {}),
          ...(details ? { details } : {}),
        },
      });
      return new Response(safeStringify({ ok: true, label }), { headers });
    }

    if (pathname === '/api/debug/relay') {
      return new Response(JSON.stringify({
        clients: Array.from(relayStore.clients.keys()),
        profiles: Array.from(relayStore.gossipProfiles.values()).map(entry => ({
          entityId: entry.profile.entityId,
          runtimeId: entry.profile.runtimeId,
          name: entry.profile.metadata?.name ?? null,
          isHub: entry.profile.metadata?.isHub === true,
          lastUpdated: entry.profile.metadata?.lastUpdated ?? 0,
        })),
        activeHubEntityIds: relayStore.activeHubEntityIds,
        debugEvents: relayStore.debugEvents.slice(-200),
      }), { headers });
    }

    if (
      (pathname === '/api/reset' || pathname === '/reset' || pathname === '/api/debug/reset')
      && (request.method === 'POST' || request.method === 'GET')
    ) {
      const requestedMarketMaker = await parseResetRequest(request);
      try {
        await ensureReset(requestedMarketMaker);
        await pollAllHubHealth();
        return new Response(JSON.stringify(computeAggregatedHealth()), { headers });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: serializeError(error), health: computeAggregatedHealth() }),
          { status: 500, headers },
        );
      }
    }

    if (pathname === '/api/info') {
      return new Response(JSON.stringify({
        name: 'e2e-mesh-control',
        relayUrl,
        rpcUrl: args.rpcUrl,
        host: args.host,
        port: args.port,
        mmEnabled: args.mmEnabled,
      }), { headers });
    }

    if (pathname === '/api/jurisdictions') {
      try {
        const payload = readShardJurisdictions();
        return new Response(payload, {
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: serializeError(error) }), {
          status: 500,
          headers,
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, service: 'e2e-mesh-control' }), { headers });
  },
  websocket: {
    open() {
      pushDebugEvent(relayStore, {
        event: 'ws_open',
        details: { wsType: 'relay' },
      });
    },
    message(ws, raw) {
      const msgStr = raw.toString();
      try {
        const msg = JSON.parse(msgStr);
        Promise.resolve(relayRoute(routerConfig, ws, msg)).catch(error => {
          const reason = serializeError(error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'RELAY_HANDLER_EXCEPTION',
            details: { error: reason, msgType: msg?.type, from: msg?.from, to: msg?.to },
          });
          try {
            ws.send(safeStringify({ type: 'error', error: reason }));
          } catch {}
        });
      } catch (error) {
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'INVALID_JSON',
          details: { error: serializeError(error) },
        });
        try {
          ws.send(safeStringify({ type: 'error', error: 'Invalid JSON' }));
        } catch {}
      }
    },
    close(ws) {
      removeClient(relayStore, ws);
    },
  },
});

const shutdown = async (): Promise<void> => {
  await stopAllChildren();
  server.stop(true);
  process.exit(0);
};

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

console.log(
  `[E2E-MESH] CONTROL ready host=${args.host} port=${args.port} relay=${relayUrl} rpc=${args.rpcUrl} mm=${args.mmEnabled ? 'on' : 'off'}`,
);

void ensureReset(args.mmEnabled).catch(error => {
  console.error('[E2E-MESH] initial reset failed:', serializeError(error));
});
