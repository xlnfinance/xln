#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeBoard, hashBoard } from '../entity-factory';
import { safeStringify } from '../serialization-utils';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { deriveSignerAddressSync } from '../account-crypto';
import {
  startCustodySupport,
  stopManagedChild,
  type ManagedChild,
  type ManagedIdentity,
} from './custody-bootstrap';
import {
  createRelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
  removeClient,
  type RelayStore,
} from '../relay-store';
import { relayRoute, type RelayRouterConfig } from '../relay-router';
import {
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
  RPC_MARKET_PUBLISH_MS,
  type MarketSnapshotPayload,
} from '../market-snapshot';
import { normalizeLoopbackUrl } from '../loopback-url';
import { assertMinDiskFree, getStorageHealth, getStorageHealthSnapshotSync, type StorageHealth } from './storage-monitor';
import { maybeHandleQaRequest } from '../qa/api';

type Args = {
  host: string;
  port: number;
  publicWsBaseUrl: string;
  nodeApiPortBase: number;
  nodePublicPortBase: number;
  rpcUrl: string;
  dbRoot: string;
  mmEnabled: boolean;
  resetAllowed: boolean;
  custodyEnabled: boolean;
  custodyPort: number;
  custodyDaemonPort: number;
  custodyDbRoot: string;
  walletUrl: string;
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
};

type HubProcessSpec = {
  name: 'H1' | 'H2' | 'H3';
  region: string;
  seed: string;
  signerLabel: string;
  apiPort: number;
  publicPort: number;
  dbPath: string;
  deployTokens: boolean;
};

type HubChild = HubProcessSpec & {
  proc: ChildProcessWithoutNullStreams | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartCount: number;
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
  directWsUrl?: string;
  p2p?: {
    directPeers?: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
  };
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
  marketMaker?: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    expectedOffersPerHub: number;
    expectedOffersPerPair?: number;
    hubs: Array<{
      hubEntityId: string;
      offers: number;
      ready: boolean;
      pairs?: Array<{
        pairId: string;
        offers: number;
        ready: boolean;
      }>;
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
  startupPhase?: string;
};

type MarketMakerHealthPayload = {
  ok?: boolean;
  name?: string;
  entityId?: string | null;
  runtimeId?: string | null;
  relayUrl?: string;
  apiUrl?: string;
  directWsUrl?: string;
  startupPhase?: string;
  p2p?: {
    directPeers?: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
  };
  gossip?: {
    visibleHubNames?: string[];
    visibleHubIds?: string[];
    ready?: boolean;
  };
  marketMaker?: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    expectedOffersPerHub: number;
    expectedOffersPerPair?: number;
    hubs: Array<{
      hubEntityId: string;
      offers: number;
      ready: boolean;
      pairs?: Array<{
        pairId: string;
        offers: number;
        ready: boolean;
      }>;
    }>;
  };
};

type MarketMakerInfoPayload = HubInfoPayload;

type RpcMarketSubscription = {
  hubIds: Set<string>;
  pairIds: Set<string>;
  depth: number;
  seq: number;
};

type AggregatedHealth = {
  timestamp: number;
  reset: ResetState;
  system: {
    runtime: boolean;
    relay: boolean;
  };
  storage: StorageHealth;
  hubMesh: {
    ok: boolean;
    hubIds: string[];
    pairs: Array<{ left: string; right: string; ok: boolean }>;
    direct: {
      openLinkCount: number;
      links: Array<{ fromRuntimeId: string; toRuntimeId: string; endpoint: string }>;
    };
  };
  marketMaker: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    expectedOffersPerHub: number;
    hubs: Array<{
      hubEntityId: string;
      offers: number;
      ready: boolean;
      pairs: Array<{ pairId: string; offers: number; ready: boolean }>;
    }>;
  };
  custody: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    daemonPort: number | null;
    servicePort: number | null;
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

type MarketMakerChild = {
  name: 'MM';
  seed: string;
  signerLabel: string;
  apiPort: number;
  publicPort: number;
  dbPath: string;
  proc: ChildProcessWithoutNullStreams | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartCount: number;
  lastHealth: MarketMakerHealthPayload | null;
  lastInfo: MarketMakerInfoPayload | null;
  lastStartupPhase: string | null;
};

type CustodySupportState = {
  daemonChild: ManagedChild;
  custodyChild: ManagedChild;
  identity: ManagedIdentity;
  hubIds: string[];
};

const HUB_NAMES = ['H1', 'H2', 'H3'] as const;
const HUB_REQUIRED_TOKEN_COUNT = 3;
const UNEXPECTED_EXIT_RESTART_MS = 1_000;

const argsRaw = process.argv.slice(2);

const getArg = (name: string, fallback = ''): string => {
  const eq = argsRaw.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argsRaw.indexOf(name);
  if (index === -1) return fallback;
  return argsRaw[index + 1] || fallback;
};

const hasFlag = (name: string): boolean => argsRaw.includes(name);

const normalizeWsBaseUrl = (raw: string, fallbackHost: string, fallbackPort: number): string => {
  const fallback = `ws://${fallbackHost}:${fallbackPort}`;
  const value = String(raw || '').trim() || fallback;
  const parsed = new URL(value);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Invalid --public-ws-base-url: ${value}`);
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
};

const parseArgs = (): Args => {
  const port = Number(getArg('--port', '20002'));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port: ${String(port)}`);
  }
  const host = getArg('--host', '127.0.0.1');
  const nodeApiPortBase = Number(getArg('--node-api-port-base', String(port + 10)));
  if (!Number.isFinite(nodeApiPortBase) || nodeApiPortBase <= 0) {
    throw new Error(`Invalid --node-api-port-base: ${String(nodeApiPortBase)}`);
  }
  const nodePublicPortBase = Number(getArg('--node-public-port-base', String(nodeApiPortBase)));
  if (!Number.isFinite(nodePublicPortBase) || nodePublicPortBase <= 0) {
    throw new Error(`Invalid --node-public-port-base: ${String(nodePublicPortBase)}`);
  }
  return {
    host,
    port,
    publicWsBaseUrl: normalizeWsBaseUrl(getArg('--public-ws-base-url', ''), host, port),
    nodeApiPortBase,
    nodePublicPortBase,
    rpcUrl: normalizeLoopbackUrl(getArg('--rpc-url', process.env.ANVIL_RPC || 'http://localhost:8545')),
    dbRoot: resolve(getArg('--db-root', join(process.cwd(), '.e2e-mesh-db'))),
    mmEnabled: hasFlag('--mm'),
    resetAllowed: hasFlag('--allow-reset') || process.env.XLN_MESH_RESET_ALLOWED === '1',
    custodyEnabled: hasFlag('--custody'),
    custodyPort: Number(getArg('--custody-port', String(port + 7))),
    custodyDaemonPort: Number(getArg('--custody-daemon-port', String(port + 8))),
    custodyDbRoot: resolve(getArg('--custody-db-root', join(getArg('--db-root', join(process.cwd(), '.e2e-mesh-db')), 'custody'))),
    walletUrl: getArg('--wallet-url', `https://localhost:${port + 4}/app`),
  };
};

const args = parseArgs();
const relayUrl = (() => {
  const url = new URL(args.publicWsBaseUrl);
  url.pathname = '/relay';
  url.search = '';
  url.hash = '';
  return url.toString();
})();
const shardJurisdictionsPath = join(args.dbRoot, 'jurisdictions.json');

const relayStore: RelayStore = createRelayStore('mesh-relay');
const routerConfig: RelayRouterConfig = {
  store: relayStore,
  localRuntimeId: 'mesh-relay',
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
};

const hubChildren: HubChild[] = HUB_NAMES.map((name, index) => ({
  name,
  region: 'global',
  seed: `xln-e2e-${name.toLowerCase()}`,
  signerLabel: `${name.toLowerCase()}-hub`,
  apiPort: args.nodeApiPortBase + index,
  publicPort: args.nodePublicPortBase + index,
  dbPath: join(args.dbRoot, name.toLowerCase()),
  deployTokens: index === 0,
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  restartTimer: null,
  restartCount: 0,
  lastHealth: null,
  lastInfo: null,
}));

const marketMakerChild: MarketMakerChild = {
  name: 'MM',
  seed: 'xln-mesh-mm',
  signerLabel: 'mm-1',
  apiPort: args.nodeApiPortBase + 3,
  publicPort: args.nodePublicPortBase + 3,
  dbPath: join(args.dbRoot, 'mm'),
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  exitSignal: null,
  restartTimer: null,
  restartCount: 0,
  lastHealth: null,
  lastInfo: null,
  lastStartupPhase: null,
};

const buildPublicDirectWsUrl = (publicPort: number): string => {
  const url = new URL(args.publicWsBaseUrl);
  url.port = String(publicPort);
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
};

let custodySupport: CustodySupportState | null = null;
const rpcMarketSubscriptions = new Map<any, RpcMarketSubscription>();
let rpcMarketPublisherTimer: ReturnType<typeof setInterval> | null = null;
let rpcMarketPublisherInFlight = false;

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
  console.log(`[MESH-TIMING] ${stage} ${timings[stage].ms}ms`);
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
    const insecureLocalHttps = url.startsWith('https://localhost:') || url.startsWith('https://127.0.0.1:');
    const prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (insecureLocalHttps) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    const response = await fetch(url, { signal: controller.signal });
    if (insecureLocalHttps) {
      if (prevTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsReject;
    }
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

const postJson = async (url: string, timeoutMs = 1_000): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'POST',
      signal: controller.signal,
    });
  } catch {
    // best effort before hard stop
  } finally {
    clearTimeout(timer);
  }
};

const getHubChildByEntityId = (hubEntityId: string): HubChild | null => {
  const normalized = String(hubEntityId || '').trim().toLowerCase();
  if (!normalized) return null;
  return hubChildren.find((child) =>
    String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim().toLowerCase() === normalized
  ) || null;
};

const fetchHubMarketSnapshots = async (
  child: HubChild,
  pairIds: string[],
  depth: number,
): Promise<MarketSnapshotPayload[]> => {
  const params = new URLSearchParams();
  params.set('depth', String(depth));
  for (const pairId of pairIds) params.append('pair', pairId);
  const response = await fetchJson<{ snapshots?: MarketSnapshotPayload[] }>(
    `http://${args.host}:${child.apiPort}/api/market/snapshots?${params.toString()}`,
    2_000,
  );
  return Array.isArray(response?.snapshots) ? response!.snapshots : [];
};

const cleanupRpcMarketSubscription = (ws: any): void => {
  rpcMarketSubscriptions.delete(ws);
  if (rpcMarketSubscriptions.size > 0) return;
  if (!rpcMarketPublisherTimer) return;
  clearInterval(rpcMarketPublisherTimer);
  rpcMarketPublisherTimer = null;
};

const sendRpcMarketSnapshot = async (
  ws: any,
  subscription: RpcMarketSubscription,
): Promise<boolean> => {
  let sentAny = false;
  const pairIds = Array.from(subscription.pairIds);
  for (const hubEntityId of subscription.hubIds) {
    const child = getHubChildByEntityId(hubEntityId);
    if (!child) continue;
    const snapshots = await fetchHubMarketSnapshots(child, pairIds, subscription.depth);
    for (const payload of snapshots) {
      subscription.seq += 1;
      ws.send(
        safeStringify({
          type: 'market_snapshot',
          id: `market_${Date.now()}_${subscription.seq}`,
          timestamp: Date.now(),
          payload,
        }),
      );
      sentAny = true;
    }
  }
  return sentAny;
};

const publishRpcMarketSnapshots = async (): Promise<void> => {
  if (rpcMarketPublisherInFlight || rpcMarketSubscriptions.size === 0) return;
  rpcMarketPublisherInFlight = true;
  try {
    for (const [ws, subscription] of rpcMarketSubscriptions.entries()) {
      try {
        await sendRpcMarketSnapshot(ws, subscription);
      } catch {
        cleanupRpcMarketSubscription(ws);
      }
    }
  } finally {
    rpcMarketPublisherInFlight = false;
  }
};

const ensureRpcMarketPublisher = (): void => {
  if (rpcMarketPublisherTimer) return;
  rpcMarketPublisherTimer = setInterval(() => {
    void publishRpcMarketSnapshots();
  }, RPC_MARKET_PUBLISH_MS);
};

const isMarketMessageType = (type: unknown): type is 'market_subscribe' | 'market_unsubscribe' | 'market_snapshot_request' =>
  type === 'market_subscribe' || type === 'market_unsubscribe' || type === 'market_snapshot_request';

const handleMarketMessage = async (ws: any, msg: any): Promise<void> => {
  const { type, id } = msg;
  if (!isMarketMessageType(type)) return;

  if (type === 'market_subscribe') {
    const hubValues = Array.isArray(msg?.hubEntityIds)
      ? msg.hubEntityIds
      : msg?.hubEntityId
        ? [msg.hubEntityId]
        : [];
    const pairValues = Array.isArray(msg?.pairs)
      ? msg.pairs
      : msg?.pairId
        ? [msg.pairId]
        : [];
    const hubIds = Array.from(new Set(hubValues.map(normalizeMarketEntityId).filter(Boolean))) as string[];
    const pairIds = Array.from(new Set(pairValues.map(normalizeMarketPairId).filter(Boolean))) as string[];
    if (hubIds.length === 0 || pairIds.length === 0) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'market_subscribe requires valid hubEntityId(s) and pair(s)' }));
      return;
    }

    const replace = msg?.replace === true;
    const depthRaw = Number(msg?.depth);
    const depth = Number.isFinite(depthRaw)
      ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
      : RPC_MARKET_DEFAULT_DEPTH;
    const subscription = rpcMarketSubscriptions.get(ws) || {
      hubIds: new Set<string>(),
      pairIds: new Set<string>(),
      depth,
      seq: 0,
    };
    if (replace) {
      subscription.hubIds.clear();
      subscription.pairIds.clear();
    }
    for (const hubEntityId of hubIds) subscription.hubIds.add(hubEntityId);
    for (const pairId of pairIds) subscription.pairIds.add(pairId);
    subscription.depth = depth;
    rpcMarketSubscriptions.set(ws, subscription);
    ensureRpcMarketPublisher();

    ws.send(
      safeStringify({
        type: 'ack',
        inReplyTo: id,
        status: 'market_subscribed',
        data: {
          hubEntityIds: Array.from(subscription.hubIds),
          pairs: Array.from(subscription.pairIds),
          depth: subscription.depth,
          intervalMs: RPC_MARKET_PUBLISH_MS,
        },
      }),
    );

    try {
      await sendRpcMarketSnapshot(ws, subscription);
    } catch {
      cleanupRpcMarketSubscription(ws);
    }
    return;
  }

  if (type === 'market_unsubscribe') {
    const existing = rpcMarketSubscriptions.get(ws);
    if (!existing) {
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
      return;
    }

    const hubValues = Array.isArray(msg?.hubEntityIds)
      ? msg.hubEntityIds
      : msg?.hubEntityId
        ? [msg.hubEntityId]
        : [];
    const pairValues = Array.isArray(msg?.pairs)
      ? msg.pairs
      : msg?.pairId
        ? [msg.pairId]
        : [];
    const hubIds = Array.from(new Set(hubValues.map(normalizeMarketEntityId).filter(Boolean))) as string[];
    const pairIds = Array.from(new Set(pairValues.map(normalizeMarketPairId).filter(Boolean))) as string[];
    if (hubIds.length === 0 && pairIds.length === 0) {
      cleanupRpcMarketSubscription(ws);
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
      return;
    }
    for (const hubEntityId of hubIds) existing.hubIds.delete(hubEntityId);
    for (const pairId of pairIds) existing.pairIds.delete(pairId);
    if (existing.hubIds.size === 0 || existing.pairIds.size === 0) {
      cleanupRpcMarketSubscription(ws);
    }
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
    return;
  }

  const existing = rpcMarketSubscriptions.get(ws);
  if (!existing) {
    ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'No active market subscription' }));
    return;
  }
  try {
    await sendRpcMarketSnapshot(ws, existing);
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_snapshot_sent' }));
  } catch {
    cleanupRpcMarketSubscription(ws);
    ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Failed to send market snapshot' }));
  }
};

const readShardJurisdictions = (): string => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  if (!existsSync(canonicalPath)) {
    throw new Error(`CANONICAL_JURISDICTIONS_MISSING path=${canonicalPath}`);
  }
  if (!existsSync(shardJurisdictionsPath)) {
    throw new Error(`JURISDICTIONS_JSON_MISSING path=${shardJurisdictionsPath}`);
  }
  const canonical = readFileSync(canonicalPath, 'utf8');
  const shard = readFileSync(shardJurisdictionsPath, 'utf8');
  try {
    const canonicalVersion = String((JSON.parse(canonical) as { version?: unknown }).version || '').trim() || '1';
    const shardPayload = JSON.parse(shard) as { version?: unknown };
    const shardVersion = String(shardPayload.version || '').trim();
    if (shardVersion !== canonicalVersion) {
      shardPayload.version = canonicalVersion;
      const next = `${JSON.stringify(shardPayload, null, 2)}\n`;
      writeFileSync(shardJurisdictionsPath, next, 'utf8');
      return next;
    }
  } catch {
    // If either payload is malformed, just return the shard payload unchanged.
  }
  return shard;
};

const seedShardJurisdictions = (): void => {
  const canonicalPath = resolveJurisdictionsJsonPath();
  if (!existsSync(canonicalPath)) {
    throw new Error(`CANONICAL_JURISDICTIONS_MISSING path=${canonicalPath}`);
  }
  writeFileSync(shardJurisdictionsPath, readFileSync(canonicalPath, 'utf8'), 'utf8');
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

const pollMarketMakerHealth = async (): Promise<void> => {
  if (!marketMakerChild.proc || marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
    return;
  }
  const apiBase = `http://${args.host}:${marketMakerChild.apiPort}`;
  marketMakerChild.lastInfo = await fetchJson<MarketMakerInfoPayload>(`${apiBase}/api/info`, 1_500);
  marketMakerChild.lastHealth = await fetchJson<MarketMakerHealthPayload>(`${apiBase}/api/health`, 1_500);
  marketMakerChild.lastStartupPhase = String(
    marketMakerChild.lastHealth?.startupPhase ||
    marketMakerChild.lastInfo?.startupPhase ||
    '',
  ).trim() || null;
};

const getHubSpecsArg = (): string => HUB_NAMES.join(',');

const getMarketMakerIdentity = (): { name: string; entityId: string; signerId: string; creditAmount: string } => {
  const signerId = deriveSignerAddressSync(marketMakerChild.seed, marketMakerChild.signerLabel).toLowerCase();
  const entityId = hashBoard(encodeBoard({
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
  })).toLowerCase();
  return {
    name: marketMakerChild.name,
    entityId,
    signerId,
    creditAmount: '50000000000000000000000000',
  };
};

const getMeshHubIdentitiesArg = (): string => JSON.stringify(
  hubChildren
    .map((child) => ({
      name: child.name,
      entityId: String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim().toLowerCase(),
      signerId: deriveSignerAddressSync(child.seed, child.signerLabel).toLowerCase(),
    }))
    .filter((entry) => entry.entityId.length > 0),
);

const sanitizeChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...env };
  if (next['FORCE_COLOR'] && next['NO_COLOR']) {
    delete next['NO_COLOR'];
  }
  return next;
};

const clearChildRestartTimer = (child: { restartTimer: ReturnType<typeof setTimeout> | null }): void => {
  if (!child.restartTimer) return;
  clearTimeout(child.restartTimer);
  child.restartTimer = null;
};

const scheduleHubRestart = (child: HubChild): void => {
  if (resetState.inProgress || child.restartTimer) return;
  child.restartTimer = setTimeout(() => {
    child.restartTimer = null;
    if (resetState.inProgress || (child.proc && child.proc.exitCode === null)) return;
    console.warn(`[MESH] restarting ${child.name} after unexpected exit`);
    spawnHub(child);
  }, UNEXPECTED_EXIT_RESTART_MS);
};

const scheduleMarketMakerRestart = (): void => {
  if (resetState.inProgress || marketMakerChild.restartTimer) return;
  marketMakerChild.restartTimer = setTimeout(() => {
    marketMakerChild.restartTimer = null;
    if (resetState.inProgress || (marketMakerChild.proc && marketMakerChild.proc.exitCode === null)) return;
    console.warn('[MESH] restarting MM after unexpected exit');
    spawnMarketMaker();
  }, UNEXPECTED_EXIT_RESTART_MS);
};

const spawnHub = (child: HubChild): void => {
  mkdirSync(child.dbPath, { recursive: true });
  clearChildRestartTimer(child);
  const cmd = [
    'runtime/orchestrator/hub-node.ts',
    '--name', child.name,
    '--region', child.region,
    '--seed', child.seed,
    '--signer-label', child.signerLabel,
    '--relay-url', relayUrl,
    '--api-host', args.host,
    '--api-port', String(child.apiPort),
    '--direct-ws-url', buildPublicDirectWsUrl(child.publicPort),
    '--rpc-url', args.rpcUrl,
    '--mesh-hub-names', getHubSpecsArg(),
    '--support-peer-identities-json', JSON.stringify([getMarketMakerIdentity()]),
    '--db-path', child.dbPath,
    ...(child.deployTokens ? ['--deploy-tokens'] : []),
  ];
  child.startedAt = Date.now();
  child.exitedAt = null;
  child.exitCode = null;
  child.restartCount += 1;
  child.lastHealth = null;
  child.lastInfo = null;
  child.proc = spawn('bun', cmd, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildEnv({
      ...process.env,
      XLN_DB_PATH: child.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ANVIL_RPC: args.rpcUrl,
      USE_ANVIL: 'true',
    }),
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
    if (!resetState.inProgress && code !== 0) {
      console.error(`[MESH] ${child.name} exited unexpectedly with code=${String(code)}`);
      scheduleHubRestart(child);
    }
  });
};

const spawnMarketMaker = (): void => {
  mkdirSync(marketMakerChild.dbPath, { recursive: true });
  clearChildRestartTimer(marketMakerChild);
  const cmd = [
    'runtime/orchestrator/mm-node.ts',
    '--name', marketMakerChild.name,
    '--seed', marketMakerChild.seed,
    '--signer-label', marketMakerChild.signerLabel,
    '--relay-url', relayUrl,
    '--api-host', args.host,
    '--api-port', String(marketMakerChild.apiPort),
    '--direct-ws-url', buildPublicDirectWsUrl(marketMakerChild.publicPort),
    '--rpc-url', args.rpcUrl,
    '--mesh-hub-names', getHubSpecsArg(),
    '--mesh-hub-identities-json', getMeshHubIdentitiesArg(),
    '--db-path', marketMakerChild.dbPath,
  ];
  marketMakerChild.startedAt = Date.now();
  marketMakerChild.exitedAt = null;
  marketMakerChild.exitCode = null;
  marketMakerChild.exitSignal = null;
  marketMakerChild.restartCount += 1;
  marketMakerChild.lastHealth = null;
  marketMakerChild.lastInfo = null;
  marketMakerChild.lastStartupPhase = null;
  marketMakerChild.proc = spawn('bun', cmd, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeChildEnv({
      ...process.env,
      XLN_DB_PATH: marketMakerChild.dbPath,
      XLN_JURISDICTIONS_PATH: shardJurisdictionsPath,
      ANVIL_RPC: args.rpcUrl,
      USE_ANVIL: 'true',
    }),
  });
  marketMakerChild.proc.stdout.on('data', chunk => {
    process.stdout.write(`[MM] ${chunk.toString()}`);
  });
  marketMakerChild.proc.stderr.on('data', chunk => {
    process.stderr.write(`[MM:err] ${chunk.toString()}`);
  });
  marketMakerChild.proc.once('exit', (code, signal) => {
    marketMakerChild.exitedAt = Date.now();
    marketMakerChild.exitCode = code ?? null;
    marketMakerChild.exitSignal = signal ?? null;
    if (!resetState.inProgress && code !== 0) {
      console.error(
        `[MESH] MM exited unexpectedly code=${String(code)} signal=${String(signal)} phase=${String(marketMakerChild.lastStartupPhase)}`,
      );
      scheduleMarketMakerRestart();
    }
  });
};

const stopAllChildren = async (): Promise<void> => {
  for (const child of hubChildren) clearChildRestartTimer(child);
  clearChildRestartTimer(marketMakerChild);
  await Promise.all([
    ...hubChildren.map((child) => postJson(`http://${args.host}:${child.apiPort}/api/control/p2p/stop`)),
    postJson(`http://${args.host}:${marketMakerChild.apiPort}/api/control/p2p/stop`),
  ]);
  await delay(150);

  const hubProcs = hubChildren.map((child) => {
    const proc = child.proc;
    child.proc = null;
    return proc;
  });
  const mmProc = marketMakerChild.proc;
  marketMakerChild.proc = null;
  const currentCustody = custodySupport;
  custodySupport = null;

  await Promise.all([
    ...hubProcs.map((proc) => stopProcess(proc)),
    stopProcess(mmProc),
    currentCustody ? stopManagedChild(currentCustody.custodyChild) : Promise.resolve(),
    currentCustody ? stopManagedChild(currentCustody.daemonChild) : Promise.resolve(),
  ]);
};

const computeAggregatedHealth = (): AggregatedHealth => {
  const storage = getStorageHealthSnapshotSync();
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
  const directLinkMap = new Map<string, { fromRuntimeId: string; toRuntimeId: string; endpoint: string }>();
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
    const fromRuntimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '').toLowerCase();
    for (const peer of child.lastHealth?.p2p?.directPeers ?? []) {
      const toRuntimeId = String(peer.runtimeId || '').toLowerCase();
      const endpoint = String(peer.endpoint || '');
      if (!fromRuntimeId || !toRuntimeId || !endpoint || peer.open !== true) continue;
      directLinkMap.set(`${fromRuntimeId}->${toRuntimeId}`, {
        fromRuntimeId,
        toRuntimeId,
        endpoint,
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

  const mmEntityId = String(marketMakerChild.lastInfo?.entityId || marketMakerChild.lastHealth?.entityId || '').trim() || null;
  const mmExpectedOffersPerHub = Number(marketMakerChild.lastHealth?.marketMaker?.expectedOffersPerHub || 0);
  const mmHubsById = new Map<string, {
    hubEntityId: string;
    offers: number;
    ready: boolean;
    pairs: Array<{ pairId: string; offers: number; ready: boolean }>;
  }>();
  for (const hub of marketMakerChild.lastHealth?.marketMaker?.hubs ?? []) {
    const hubEntityId = String(hub.hubEntityId || '').toLowerCase();
    if (!hubEntityId) continue;
    mmHubsById.set(hubEntityId, {
      hubEntityId,
      offers: Number(hub.offers || 0),
      ready: hub.ready === true,
      pairs: Array.isArray(hub.pairs)
        ? hub.pairs.map((pair) => ({
            pairId: String(pair.pairId || ''),
            offers: Number(pair.offers || 0),
            ready: pair.ready === true,
          }))
        : [],
    });
  }
  const mmHubs = hubIds.map((hubEntityId) => {
    const existing = mmHubsById.get(hubEntityId);
    return {
      hubEntityId,
      offers: existing?.offers ?? 0,
      ready: existing?.ready === true || (!!mmExpectedOffersPerHub && (existing?.offers ?? 0) >= mmExpectedOffersPerHub),
      pairs: existing?.pairs ?? [],
    };
  });
  const mmOk = !args.mmEnabled
    ? true
    : mmHubs.length === HUB_NAMES.length && mmHubs.every((hub) => hub.ready);

  return {
    timestamp: Date.now(),
    reset: { ...resetState },
    system: {
      runtime: true,
      relay: true,
    },
    storage,
    hubMesh: {
      ok:
        hubIds.length === HUB_NAMES.length &&
        hubChildren.every((child) => child.lastHealth?.mesh?.ready === true),
      hubIds,
      pairs: Array.from(pairSet.values()).sort((left, right) =>
        `${left.left}:${left.right}`.localeCompare(`${right.left}:${right.right}`),
      ),
      direct: {
        openLinkCount: directLinkMap.size,
        links: Array.from(directLinkMap.values()).sort((left, right) =>
          `${left.fromRuntimeId}:${left.toRuntimeId}`.localeCompare(`${right.fromRuntimeId}:${right.toRuntimeId}`),
        ),
      },
    },
    marketMaker: {
      enabled: args.mmEnabled,
      ok: mmOk,
      entityId: mmEntityId,
      startupPhase: marketMakerChild.lastStartupPhase,
      expectedOffersPerHub: mmExpectedOffersPerHub,
      hubs: mmHubs,
    },
    custody: {
      enabled: args.custodyEnabled,
      ok: args.custodyEnabled
        ? Boolean(custodySupport?.identity.entityId && custodySupport?.daemonChild.proc.exitCode === null && custodySupport?.custodyChild.proc.exitCode === null)
        : true,
      entityId: custodySupport?.identity.entityId ?? null,
      daemonPort: args.custodyEnabled ? args.custodyDaemonPort : null,
      servicePort: args.custodyEnabled ? args.custodyPort : null,
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

type CustodyMePayload = {
  custody?: {
    entityId?: string | null;
  };
};

const buildAggregatedHealthResponse = async (): Promise<AggregatedHealth> => {
  const health = computeAggregatedHealth();
  if (!health.custody.enabled || health.custody.ok || !health.custody.servicePort) {
    return health;
  }

  const liveCustody =
    await fetchJson<CustodyMePayload>(`https://127.0.0.1:${health.custody.servicePort}/api/me`, 1_500)
    ?? await fetchJson<CustodyMePayload>(`http://127.0.0.1:${health.custody.servicePort}/api/me`, 1_500);
  const liveEntityId = String(liveCustody?.custody?.entityId || '').trim();
  if (!liveEntityId) {
    return health;
  }

  return {
    ...health,
    custody: {
      ...health.custody,
      ok: true,
      entityId: liveEntityId,
    },
  };
};

const buildPublicHubDiscoveryPayload = (): {
  ok: true;
  count: number;
  serverTime: number;
  hubs: Array<{
    entityId: string;
    runtimeId: string | null;
    name: string;
    bio: null;
    website: null;
    wsUrl: string | null;
    publicAccounts: [];
    metadata: { isHub: true };
    lastUpdated: number;
    online: boolean;
  }>;
} => {
  const serverTime = Date.now();
  const hubs = hubChildren
    .map((child) => {
      const entityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').trim();
      if (!entityId) return null;
      const runtimeId = String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '').trim();
      const directWsUrl = String(child.lastHealth?.directWsUrl || '').trim();
      return {
        entityId,
        runtimeId: runtimeId || null,
        name: child.name,
        bio: null,
        website: null,
        wsUrl: directWsUrl || null,
        publicAccounts: [] as [],
        metadata: { isHub: true as const },
        lastUpdated: serverTime,
        online: child.proc?.exitCode === null && Boolean(child.lastHealth),
      };
    })
    .filter((hub): hub is NonNullable<typeof hub> => Boolean(hub))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    ok: true,
    count: hubs.length,
    serverTime,
    hubs,
  };
};

const getDebugEntityEntries = (requestUrl: URL): Array<{
  entityId: string;
  runtimeId?: string;
  name: string;
  isHub: boolean;
  online: boolean;
  lastUpdated: number;
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
    const isHub = profile?.metadata?.isHub === true;
    const name =
      typeof profile?.name === 'string' && profile.name.trim().length > 0
        ? profile.name.trim()
        : entityId;
    const online = normalizedRuntimeId ? relayStore.clients.has(normalizedRuntimeId) : false;
    entities.set(entityId.toLowerCase(), {
      entityId,
      runtimeId: normalizedRuntimeId || runtimeId,
      name,
      isHub,
      online,
      lastUpdated: Number(profile?.lastUpdated || entry.timestamp || 0),
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
      accounts: existing?.accounts || [],
      publicAccounts: existing?.publicAccounts || [],
      metadata: {
        ...(existing?.metadata || {}),
        isHub: true,
      },
    });
  }

  return Array.from(entities.values())
    .filter((entity) => {
      if (onlineOnly && !entity.online) return false;
      if (!q) return true;
      const blob = `${entity.entityId} ${entity.runtimeId || ''} ${entity.name}`.toLowerCase();
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
      health.hubMesh.direct.openLinkCount >= HUB_NAMES.length * Math.max(0, HUB_NAMES.length - 1) &&
      health.bootstrapReserves.ok &&
      health.hubs.every(hub => hub.online)
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`HUB_BASELINE_TIMEOUT ${safeStringify(computeAggregatedHealth())}`);
};

const waitForHubProfilesReady = async (): Promise<void> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await pollAllHubHealth();
    const allVisible = hubChildren.every((child) => {
      const visibleNames = new Set(child.lastHealth?.gossip?.visibleHubNames ?? []);
      return HUB_NAMES.every((name) => visibleNames.has(name));
    });
    if (allVisible) {
      return;
    }
    if (hubChildren.some((child) => child.proc?.exitCode !== null)) {
      throw new Error(`HUB_PROFILES_READY_EXIT ${safeStringify(computeAggregatedHealth().hubs)}`);
    }
    await delay(250);
  }
  throw new Error(`HUB_PROFILES_READY_TIMEOUT ${safeStringify(computeAggregatedHealth())}`);
};

const waitForMarketMakerReady = async (): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await pollMarketMakerHealth();
    const health = computeAggregatedHealth();
    if (
      !args.mmEnabled ||
      (health.marketMaker.ok && marketMakerChild.lastStartupPhase === 'offers-ready')
    ) {
      return;
    }
    if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
      throw new Error(
        `MM_EXITED_EARLY code=${String(marketMakerChild.exitCode)} signal=${String(marketMakerChild.exitSignal)} phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify(health.marketMaker)}`,
      );
    }
    await delay(250);
  }
  throw new Error(
    `MM_READY_TIMEOUT phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify(computeAggregatedHealth().marketMaker)}`,
  );
};

const waitForHubSelfReady = async (child: HubChild): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await pollHubHealth(child);
    if (
      typeof child.lastInfo?.entityId === 'string' &&
      child.lastInfo.entityId.length > 0 &&
      child.lastHealth?.timings?.import_j?.completedAt &&
      child.lastHealth?.timings?.hub_bootstrap?.completedAt &&
      child.lastHealth?.timings?.orderbook_init?.completedAt
    ) {
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(`${child.name}_SELF_READY_EXITED_EARLY code=${String(child.proc?.exitCode)}`);
    }
    await delay(250);
  }
  throw new Error(`${child.name}_SELF_READY_TIMEOUT ${safeStringify(child.lastHealth)}`);
};

const waitForHubApiReady = async (child: HubChild): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await pollHubHealth(child);
    if (child.lastInfo || child.lastHealth) {
      return;
    }
    if (child.proc?.exitCode !== null) {
      throw new Error(`${child.name}_API_EXITED_EARLY code=${String(child.proc?.exitCode)}`);
    }
    await delay(250);
  }
  throw new Error(`${child.name}_API_READY_TIMEOUT`);
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

const runReset = async (): Promise<void> => {
  resetState.inProgress = true;
  resetState.lastError = null;
  resetState.startedAt = Date.now();
  resetState.completedAt = null;

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
    seedShardJurisdictions();
    finishTiming('reset_clear_state', clearStartedAt);

    const h1 = hubChildren[0]!;
    const h23 = hubChildren.slice(1);

    const spawnH1StartedAt = startTiming('reset_spawn_h1');
    spawnHub(h1);
    finishTiming('reset_spawn_h1', spawnH1StartedAt);

    const waitH1StartedAt = startTiming('reset_wait_h1');
    await waitForHubSelfReady(h1);
    finishTiming('reset_wait_h1', waitH1StartedAt);
    await waitForShardJurisdictions(h1);

    const spawnH23StartedAt = startTiming('reset_spawn_h23');
    for (const child of h23) {
      spawnHub(child);
      await waitForHubSelfReady(child);
    }
    finishTiming('reset_spawn_h23', spawnH23StartedAt);

    const waitStartedAt = startTiming('reset_wait_hubs');
    await waitForHubProfilesReady();
    await waitForHubBaseline();
    finishTiming('reset_wait_hubs', waitStartedAt);

    if (args.custodyEnabled) {
      custodySupport = await startCustodySupport({
        apiBaseUrl: `http://${args.host}:${args.port}`,
        daemonPort: args.custodyDaemonPort,
        custodyPort: args.custodyPort,
        relayUrl,
        rpcUrl: args.rpcUrl,
        walletUrl: args.walletUrl,
        dbRoot: args.custodyDbRoot,
        seed: 'xln-mesh-custody-seed',
        signerLabel: 'custody-mesh-1',
        profileName: 'Custody',
        jurisdictionId: 'arrakis',
      });
    }

    if (args.mmEnabled) {
      spawnMarketMaker();
      await waitForMarketMakerReady();
    }

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

const ensureReset = async (): Promise<void> => {
  if (resetPromise) {
    await resetPromise;
    if (!resetState.lastError) {
      return;
    }
  }
  resetPromise = runReset().finally(() => {
    resetPromise = null;
  });
  await resetPromise;
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

const proxyAnyHubGet = async (request: Request, endpointWithQuery: string): Promise<Response> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };

  await pollAllHubHealth();
  const child = hubChildren.find((candidate) => candidate.proc?.exitCode === null && candidate.lastHealth);
  if (!child) {
    return new Response(JSON.stringify({ error: 'No healthy hub API available' }), {
      status: 503,
      headers,
    });
  }

  try {
    const response = await fetch(`http://${args.host}:${child.apiPort}${endpointWithQuery}`, {
      method: 'GET',
      headers: {
        'content-type': request.headers.get('content-type') || 'application/json',
      },
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
    return new Response(JSON.stringify({ error: serializeError(error) }), {
      status: 502,
      headers,
    });
  }
};

const proxyAnyHubRequest = async (
  request: Request,
  endpointWithQuery: string,
): Promise<Response> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };

  await pollAllHubHealth();
  const child = hubChildren.find((candidate) => candidate.proc?.exitCode === null && candidate.lastHealth);
  if (!child) {
    return new Response(JSON.stringify({ error: 'No healthy hub API available' }), {
      status: 503,
      headers,
    });
  }

  let bodyText = '';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    bodyText = await request.text();
  }

  try {
    const response = await fetch(`http://${args.host}:${child.apiPort}${endpointWithQuery}`, {
      method: request.method,
      headers: {
        'content-type': request.headers.get('content-type') || 'application/json',
      },
      ...(bodyText.length > 0 ? { body: bodyText } : {}),
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
    return new Response(JSON.stringify({ error: serializeError(error) }), {
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

    if (
      (pathname === '/api/faucet/erc20' || pathname === '/api/faucet/gas' || pathname === '/api/faucet/reserve')
      && request.method === 'POST'
    ) {
      return await proxyAnyHubRequest(request, pathname);
    }

    if (pathname === '/api/health') {
      await getStorageHealth();
      await pollAllHubHealth();
      await pollMarketMakerHealth();
      return new Response(safeStringify(await buildAggregatedHealthResponse()), { headers });
    }

    const qaResponse = await maybeHandleQaRequest(request, pathname, headers);
    if (qaResponse) return qaResponse;

    if (pathname === '/api/hubs') {
      await pollAllHubHealth();
      return new Response(safeStringify(buildPublicHubDiscoveryPayload()), { headers });
    }

    if (pathname === '/api/debug/entities') {
      await pollAllHubHealth();
      await pollMarketMakerHealth();
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
      if (marketMakerChild.lastInfo?.entityId || marketMakerChild.lastHealth?.entityId) {
        const entityId = String(marketMakerChild.lastInfo?.entityId || marketMakerChild.lastHealth?.entityId || '').toLowerCase();
        const existing = entities.find(entry => String(entry.entityId || '').toLowerCase() === entityId);
        if (!existing) {
          entities.unshift({
            entityId,
            runtimeId: String(marketMakerChild.lastInfo?.runtimeId || marketMakerChild.lastHealth?.runtimeId || ''),
            name: marketMakerChild.name,
            isHub: false,
            online: marketMakerChild.proc?.exitCode === null && Boolean(marketMakerChild.lastHealth),
            lastUpdated: Date.now(),
            accounts: [],
            publicAccounts: [],
            metadata: { isMarketMaker: true },
            apiPort: marketMakerChild.apiPort,
            exitCode: marketMakerChild.exitCode,
            dbPath: marketMakerChild.dbPath,
          });
        }
      }
      return new Response(safeStringify({ entities }), { headers });
    }

    if (pathname === '/api/debug/reserve' && request.method === 'GET') {
      return await proxyAnyHubGet(request, `${pathname}${url.search}`);
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
      return new Response(safeStringify({
        clients: Array.from(relayStore.clients.keys()),
        profiles: Array.from(relayStore.gossipProfiles.values()).map(entry => ({
          entityId: entry.profile.entityId,
          runtimeId: entry.profile.runtimeId,
          name: entry.profile.name ?? null,
          isHub: entry.profile.metadata?.isHub === true,
          lastUpdated: entry.profile.lastUpdated ?? 0,
        })),
        activeHubEntityIds: relayStore.activeHubEntityIds,
        debugEvents: relayStore.debugEvents.slice(-200),
      }), { headers });
    }

    if (pathname === '/api/reset' && request.method === 'POST') {
      if (!args.resetAllowed) {
        return new Response(safeStringify({ error: 'RESET_DISABLED' }), { status: 403, headers });
      }
      try {
        await ensureReset();
        await pollAllHubHealth();
        return new Response(safeStringify(computeAggregatedHealth()), { headers });
      } catch (error) {
        return new Response(
          safeStringify({ error: serializeError(error), health: computeAggregatedHealth() }),
          { status: 500, headers },
        );
      }
    }

    if (pathname === '/api/info') {
      return new Response(JSON.stringify({
        name: 'mesh-control',
        relayUrl,
        rpcUrl: args.rpcUrl,
        host: args.host,
        port: args.port,
        mmEnabled: args.mmEnabled,
        resetAllowed: args.resetAllowed,
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

    if (pathname === '/api/tokens' && request.method === 'GET') {
      return await proxyAnyHubRequest(request, `${pathname}${url.search}`);
    }

    if (pathname.startsWith('/api/')) {
      return await proxyAnyHubRequest(request, `${pathname}${url.search}`);
    }

    return new Response(JSON.stringify({
      error: `Unhandled mesh-control route: ${request.method} ${pathname}`,
    }), {
      status: 404,
      headers,
    });
  },
  websocket: {
    open(ws) {
      pushDebugEvent(relayStore, {
        event: 'ws_open',
        details: { wsType: 'relay' },
      });
    },
    message(ws, raw) {
      const msgStr = raw.toString();
      try {
        const msg = JSON.parse(msgStr);
        if (isMarketMessageType(msg?.type)) {
          Promise.resolve(handleMarketMessage(ws, msg)).catch(error => {
            const reason = serializeError(error);
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
      cleanupRpcMarketSubscription(ws);
      removeClient(relayStore, ws);
    },
  },
});

const shutdown = async (): Promise<void> => {
  await stopAllChildren();
  server.stop(true);
  process.exit(0);
};

process.on('SIGTERM', () => {
  if (resetState.inProgress) {
    console.warn('[MESH] received SIGTERM from parent during reset');
  }
  void shutdown();
});
process.on('SIGINT', () => { void shutdown(); });

console.log(
  `[MESH] CONTROL ready host=${args.host} port=${args.port} relay=${relayUrl} rpc=${args.rpcUrl} mm=${args.mmEnabled ? 'on' : 'off'} custody=${args.custodyEnabled ? 'on' : 'off'} reset=${args.resetAllowed ? 'on' : 'off'}`,
);

assertMinDiskFree();

void ensureReset(args.mmEnabled).catch(error => {
  console.error('[MESH] initial reset failed:', serializeError(error));
});
