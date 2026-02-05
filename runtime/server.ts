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

import { main, process as runtimeProcess, applyRuntimeInput, startP2P, startRuntimeLoop } from './runtime';
import { safeStringify } from './serialization-utils';
import type { Env, EntityInput, RuntimeInput } from './types';
import { encodeBoard, hashBoard } from './entity-factory';
import { deriveSignerKeySync } from './account-crypto';
import { createJAdapter, type JAdapter } from './jadapter';
import type { JEvent, JTokenInfo } from './jadapter/types';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from './jadapter/default-tokens';
import { TIMING } from './constants';
import { resolveEntityProposerId } from './state-helpers';
import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../jurisdictions/typechain-types/factories/ERC20Mock__factory';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
let jWatcherStarted = false;
let jWatcher: any = null;
let jWatcherProcessInterval: ReturnType<typeof setInterval> | null = null;
let runtimeTickInterval: ReturnType<typeof setInterval> | null = null;
let runtimeTickInFlight = false;
const HUB_SEED = process.env.HUB_SEED ?? 'xln-main-hub-2026';

let tokenCatalogCache: JTokenInfo[] | null = null;
let tokenCatalogPromise: Promise<JTokenInfo[]> | null = null;

 

const summarizeJWatcherEvents = (inputs: EntityInput[]): { totalEvents: number; summary: string } => {
  const counts = new Map<string, number>();
  let totalEvents = 0;
  for (const input of inputs) {
    const txs = input.entityTxs || [];
    for (const tx of txs) {
      if (tx?.type === 'j_event' && tx?.data?.events) {
        for (const ev of tx.data.events) {
          const name = ev?.type || ev?.name || 'Unknown';
          counts.set(name, (counts.get(name) ?? 0) + 1);
          totalEvents += 1;
        }
      }
    }
  }
  const summary = Array.from(counts.entries())
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  return { totalEvents, summary };
};

const drainJWatcherQueue = async (env: Env, label = 'J-WATCHER'): Promise<void> => {
  const allPending = env.runtimeInput?.entityInputs ?? [];
  if (allPending.length === 0) return;

  // CRITICAL FIX: Only process inputs that contain J-events (j_event type)
  // Leave P2P inputs (openAccount, accountInput, etc.) for the runtime tick to process
  const jEventInputs: typeof allPending = [];
  const otherInputs: typeof allPending = [];

  for (const input of allPending) {
    const hasJEvents = input.entityTxs?.some(tx => tx.type === 'j_event');
    if (hasJEvents) {
      jEventInputs.push(input);
    } else {
      otherInputs.push(input);
    }
  }

  if (jEventInputs.length === 0) return;

  // Only drain J-event inputs, keep others in queue
  env.runtimeInput.entityInputs = otherInputs;

  const { totalEvents, summary } = summarizeJWatcherEvents(jEventInputs);
  console.log(`[${label}] Applying ${jEventInputs.length} queued inputs (${totalEvents} events${summary ? `: ${summary}` : ''})`);
  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: jEventInputs });
  console.log(`[${label}] Applied ${jEventInputs.length} queued inputs`);
};

const applyJEventsToEnv = async (env: Env, events: JEvent[], label = 'J-EVENTS'): Promise<void> => {
  if (!events || events.length === 0) return;
  const grouped = new Map<string, { events: Array<{ type: string; data: Record<string, unknown> }>; blockNumber: number; blockHash: string; transactionHash: string }>();

  for (const ev of events) {
    const entity = (ev as any)?.args?.entity || (ev as any)?.args?.entityId || (ev as any)?.args?.leftEntity;
    if (!entity) continue;
    const key = String(entity).toLowerCase();
    const entry = grouped.get(key) ?? {
      events: [],
      blockNumber: Number(ev.blockNumber ?? 0),
      blockHash: ev.blockHash ?? '0x',
      transactionHash: ev.transactionHash ?? '0x',
    };
    entry.events.push({ type: ev.name ?? (ev as any).type ?? 'Unknown', data: (ev as any).args ?? {} });
    grouped.set(key, entry);
  }

  const observedAt = Date.now();
  const entityInputs: EntityInput[] = [];
  for (const [entityId, entry] of grouped.entries()) {
    entityInputs.push({
      entityId,
      signerId: 'j-event',
      entityTxs: [{
        type: 'j_event',
        data: {
          from: 'j-event',
          events: entry.events,
          observedAt,
          blockNumber: entry.blockNumber,
          blockHash: entry.blockHash,
          transactionHash: entry.transactionHash,
        },
      }],
    });
  }

  if (entityInputs.length === 0) return;
  console.log(`[${label}] Applying ${entityInputs.length} J-events directly to env`);
  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs });
};

const startJWatcherProcessingLoop = (env: Env): void => {
  if (jWatcherProcessInterval) return;
  jWatcherProcessInterval = setInterval(() => {
    if (!env.runtimeInput?.entityInputs?.length) return;
    drainJWatcherQueue(env, 'J-WATCHER').catch((err) => {
      console.warn('[J-WATCHER] Failed to apply queued events:', (err as Error).message);
    });
  }, 100);
};

const hasPendingRuntimeWork = (env: Env): boolean => {
  if (env.pendingOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  if (env.pendingNetworkOutputs?.length) return true;
  if (env.runtimeInput?.runtimeTxs?.length) return true;
  // Check P2P mempool (where enqueueRuntimeInputs puts inbound messages)
  if ((env as any).runtimeMempool?.entityInputs?.length) return true;
  if ((env as any).runtimeMempool?.runtimeTxs?.length) return true;

  if (env.jReplicas) {
    for (const replica of env.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

const waitForJBatchClear = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = Array.from(env.jReplicas?.values?.() || []).some(j => (j.mempool?.length ?? 0) > 0);
    if (!pending) return true;
    try {
      await runtimeProcess(env, []);
    } catch (err) {
      console.warn('[FAUCET] Runtime tick failed while waiting for J-batch:', (err as Error).message);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

const waitForReserveUpdate = async (
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 10000
): Promise<bigint | null> => {
  if (!globalJAdapter) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await globalJAdapter.getReserves(entityId, tokenId);
      if (current >= expectedMin) return current;
    } catch (err) {
      console.warn('[FAUCET] getReserves failed while waiting:', (err as Error).message);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return null;
};

const startRuntimeTickLoop = (env: Env): void => {
  if (runtimeTickInterval) return;
  runtimeTickInterval = setInterval(async () => {
    if (runtimeTickInFlight) return;
    if (!hasPendingRuntimeWork(env)) return;
    runtimeTickInFlight = true;
    try {
      await runtimeProcess(env, []);
    } catch (err) {
      console.warn('[RUNTIME-TICK] Failed to process tick:', (err as Error).message);
    } finally {
      runtimeTickInFlight = false;
    }
  }, TIMING.TICK_INTERVAL_MS);
  console.log(`[XLN] Runtime tick loop started (${TIMING.TICK_INTERVAL_MS}ms)`);
};

const hubSignerLabels = new Map<string, string>();
const hubSignerAddresses = new Map<string, string>();

const getHubWallet = async (env: Env, hubEntityId?: string): Promise<{ hubEntityId: string; hubSignerId: string; wallet: ethers.Wallet } | null> => {
  if (!globalJAdapter) return null;
  const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true) || [];
  if (hubs.length === 0) return null;
  const selectedHub = hubEntityId ? hubs.find(h => h.entityId === hubEntityId) || hubs[0] : hubs[0];
  const targetEntityId = selectedHub.entityId;
  const signerLabel = hubSignerLabels.get(targetEntityId);
  if (!signerLabel) {
    console.warn(`[XLN] Hub signer label missing for ${targetEntityId.slice(0, 12)}...`);
    return null;
  }
  const hubSignerAddress = hubSignerAddresses.get(targetEntityId);
  const hubPrivateKeyBytes = deriveSignerKeySync(HUB_SEED, signerLabel);
  const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
  const wallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);
  if (hubSignerAddress && wallet.address.toLowerCase() !== hubSignerAddress.toLowerCase()) {
    console.error(`[XLN] Hub signer address mismatch for ${targetEntityId.slice(0, 12)}... expected=${hubSignerAddress} got=${wallet.address}`);
    return null;
  }
  return { hubEntityId: targetEntityId, hubSignerId: hubSignerAddress ?? wallet.address, wallet };
};

const deployDefaultTokensOnRpc = async (): Promise<void> => {
  if (!globalJAdapter || globalJAdapter.mode === 'browservm') return;
  const existing = await globalJAdapter.getTokenRegistry().catch(() => []);
  if (existing.length > 0) return;

  const signer = globalJAdapter.signer;
  const depository = globalJAdapter.depository;
  const depositoryAddress = globalJAdapter.addresses?.depository;
  if (!depositoryAddress) {
    throw new Error('Depository address not available for token deployment');
  }

  console.log('[XLN] Deploying default ERC20 tokens to RPC...');
  const erc20Factory = new ERC20Mock__factory(signer as any);

  for (const token of DEFAULT_TOKEN_CATALOG) {
    const tokenContract = await erc20Factory.deploy(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
    await tokenContract.waitForDeployment();
    const tokenAddress = await tokenContract.getAddress();
    console.log(`[XLN] ${token.symbol} deployed at ${tokenAddress}`);

    const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
    await approveTx.wait();

    const registerTx = await depository.connect(signer as any).externalTokenToReserve({
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    });
    await registerTx.wait();
    console.log(`[XLN] Token registered: ${token.symbol} @ ${tokenAddress.slice(0, 10)}...`);
  }
};

const ensureTokenCatalog = async (): Promise<JTokenInfo[]> => {
  if (!globalJAdapter) return [];
  if (tokenCatalogCache && tokenCatalogCache.length > 0) {
    if (globalJAdapter.mode !== 'browservm') {
      const firstToken = tokenCatalogCache[0];
      if (firstToken?.address) {
        const code = await globalJAdapter.provider.getCode(firstToken.address).catch(() => '0x');
        if (code !== '0x' && code.length > 10) {
          return tokenCatalogCache;
        }
        console.warn('[ensureTokenCatalog] Cached token registry appears stale - refreshing');
        tokenCatalogCache = null;
      }
    } else {
      return tokenCatalogCache;
    }
  }
  if (tokenCatalogPromise) return tokenCatalogPromise;

  tokenCatalogPromise = (async () => {
    const current = await globalJAdapter.getTokenRegistry().catch(() => []);

    // Verify tokens have actual code on-chain (not stale addresses)
    if (current.length > 0 && globalJAdapter.mode !== 'browservm') {
      const firstToken = current[0];
      if (firstToken?.address) {
        const code = await globalJAdapter.provider.getCode(firstToken.address).catch(() => '0x');
        if (code === '0x' || code.length < 10) {
          console.warn(`[ensureTokenCatalog] Token ${firstToken.symbol} at ${firstToken.address} has no code - deploying fresh tokens`);
          await deployDefaultTokensOnRpc();
          const refreshed = await globalJAdapter.getTokenRegistry().catch(() => []);
          return refreshed;
        }
      }
      return current;
    }

    if (current.length > 0 || globalJAdapter.mode === 'browservm') {
      return current;
    }

    await deployDefaultTokensOnRpc();
    const refreshed = await globalJAdapter.getTokenRegistry().catch(() => []);
    return refreshed;
  })();

  const tokens = await tokenCatalogPromise;
  tokenCatalogPromise = null;
  if (tokens.length > 0) tokenCatalogCache = tokens;
  return tokens;
};

const updateJurisdictionsJson = async (
  contracts: JAdapter['addresses'],
  rpcUrl?: string,
  chainIdOverride?: number
): Promise<void> => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const candidates = [
      path.join(process.cwd(), 'jurisdictions.json'),
      path.join(process.cwd(), 'frontend', 'static', 'jurisdictions.json'),
      path.join(process.cwd(), 'frontend', 'build', 'jurisdictions.json'),
      '/var/www/html/jurisdictions.json',
    ];

    const publicRpc = process.env.PUBLIC_RPC ?? rpcUrl ?? '/rpc';

    for (const filePath of candidates) {
      try {
        await fs.access(path.dirname(filePath));
      } catch {
        continue;
      }
      let data: any = {};
      try {
        data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      } catch {
        data = {};
      }
      data.version = data.version ?? '1.0.0';
      data.lastUpdated = new Date().toISOString();
      data.defaults = data.defaults ?? {
        timeout: 30000,
        retryAttempts: 3,
        gasLimit: 1_000_000,
      };
      if (data.testnet) delete data.testnet;
      data.jurisdictions = data.jurisdictions ?? {};
      data.jurisdictions.arrakis = {
        name: 'Arrakis (Shared Anvil)',
        chainId: chainIdOverride ?? 31337,
        rpc: publicRpc,
        contracts: {
          account: contracts.account,
          depository: contracts.depository,
          entityProvider: contracts.entityProvider,
          deltaTransformer: contracts.deltaTransformer,
        },
      };
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      console.log(`[XLN] Updated jurisdictions.json: ${filePath}`);
    }
  } catch (err) {
    console.warn('[XLN] Failed to update jurisdictions.json:', (err as Error).message);
  }
};

// ============================================================================
// SERVER OPTIONS
// ============================================================================

export type XlnServerOptions = {
  port: number;
  host?: string;
  staticDir?: string;
  relaySeeds?: string[];
  serverId?: string;
};

const DEFAULT_OPTIONS: XlnServerOptions = {
  port: 8080,
  host: '0.0.0.0',
  staticDir: './frontend/build',
  relaySeeds: ['wss://xln.finance/relay'],
  serverId: 'xln-server',
};
const DEFAULT_TOKEN_CATALOG = DEFAULT_TOKENS.map((token) => ({ ...token }));

// ============================================================================
// WEBSOCKET STATE
// ============================================================================

type WsClient = {
  ws: any; // Bun.ServerWebSocket
  runtimeId: string;
  lastSeen: number;
  topics: Set<string>;
};

const clients = new Map<string, WsClient>();
const pendingMessages = new Map<string, any[]>();
const gossipProfiles = new Map<string, { profile: any; timestamp: number }>();
let relayServerId = DEFAULT_OPTIONS.serverId ?? 'xln-server';

let wsCounter = 0;
const nextWsTimestamp = () => ++wsCounter;

const storeGossipProfile = (profile: any): boolean => {
  const entityId = profile?.entityId;
  if (!entityId) return false;
  const newTs = profile?.metadata?.lastUpdated || 0;
  const existing = gossipProfiles.get(entityId);
  if (existing && existing.timestamp >= newTs) return false;
  gossipProfiles.set(entityId, { profile, timestamp: newTs });
  return true;
};

const getAllGossipProfiles = (): any[] => Array.from(gossipProfiles.values()).map(v => v.profile);

// ============================================================================
// FAUCET MUTEX (prevent nonce collisions from parallel requests)
// ============================================================================
const faucetLock = {
  locked: false,
  queue: [] as Array<() => void>,

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  },

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
};
let faucetNonce: number | null = null;

// ============================================================================
// STATIC FILE SERVING
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const getMimeType = (path: string): string | undefined => {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return undefined;
  return MIME_TYPES[path.slice(idx)];
};

const serveStatic = async (pathname: string, staticDir: string): Promise<Response | null> => {
  // Try exact path
  const exactPath = `${staticDir}${pathname}`;
  let file = Bun.file(exactPath);
  if (await file.exists()) {
    const ct = getMimeType(pathname);
    return new Response(file, ct ? { headers: { 'content-type': ct } } : undefined);
  }

  // Try with .html extension
  if (!pathname.includes('.')) {
    const htmlPath = `${staticDir}${pathname}.html`;
    file = Bun.file(htmlPath);
    if (await file.exists()) {
      return new Response(file, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  }

  return null;
};

// ============================================================================
// RELAY PROTOCOL
// ============================================================================

const handleRelayMessage = async (ws: any, msg: any, env: Env | null) => {
  const { type, to, from, payload, id } = msg;

  // Hello - register client
  if (type === 'hello' && from) {
    const existing = clients.get(from);
    if (existing && existing.ws !== ws) {
      existing.ws.close();
    }
    clients.set(from, { ws, runtimeId: from, lastSeen: nextWsTimestamp(), topics: new Set() });

    // Flush pending messages
    const pending = pendingMessages.get(from) || [];
    for (const pendingMsg of pending) {
      ws.send(safeStringify(pendingMsg));
    }
    pendingMessages.delete(from);

    ws.send(safeStringify({ type: 'ack', inReplyTo: 'hello', status: 'delivered' }));
    return;
  }

  // Gossip announce: store profiles locally in relay
  if (type === 'gossip_announce') {
    const profiles = (payload?.profiles || []) as any[];
    let stored = 0;
    for (const profile of profiles) {
      if (storeGossipProfile(profile)) stored += 1;
    }
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'stored', count: stored }));
    return;
  }

  // Gossip request: return all stored profiles
  if (type === 'gossip_request') {
    const profiles = getAllGossipProfiles();
    ws.send(safeStringify({
      type: 'gossip_response',
      id: `gossip_${Date.now()}`,
      from: relayServerId,
      to: from,
      timestamp: Date.now(),
      payload: { profiles },
      inReplyTo: id,
    }));
    return;
  }

  // Ping/pong
  if (type === 'ping') {
    ws.send(safeStringify({ type: 'pong', inReplyTo: id }));
    return;
  }

  // Routable messages
  if (type === 'entity_input' || type === 'runtime_input' || type === 'gossip_request' || type === 'gossip_response' || type === 'gossip_announce') {
    if (!to) {
      ws.send(safeStringify({ type: 'error', error: 'Missing target runtimeId' }));
      return;
    }

    const target = clients.get(to);
    if (target) {
      target.ws.send(safeStringify(msg));
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'delivered' }));
      return;
    }

    // Local delivery for entity_input if we're running runtime
    if (type === 'entity_input' && env && payload) {
      try {
        const input = payload as EntityInput;
        // Queue to runtime's entity input handling
        await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ ...input, from }] });
        ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'delivered' }));
        return;
      } catch (error) {
        console.log(`[RELAY] Local delivery failed: ${(error as Error).message}`);
      }
    }

    // Queue for later
    const queue = pendingMessages.get(to) || [];
    queue.push(msg);
    if (queue.length > 200) queue.shift();
    pendingMessages.set(to, queue);
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'queued' }));
    return;
  }

  ws.send(safeStringify({ type: 'error', error: `Unknown message type: ${type}` }));
};

// ============================================================================
// RPC PROTOCOL (for remote UI)
// ============================================================================

const handleRpcMessage = (ws: any, msg: any, env: Env | null) => {
  const { type, id } = msg;

  if (type === 'subscribe') {
    const client = Array.from(clients.values()).find(c => c.ws === ws);
    if (client && msg.topics) {
      for (const topic of msg.topics) {
        client.topics.add(topic);
      }
    }
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'subscribed' }));
    return;
  }

  if (type === 'get_env' && env) {
    // Serialize env for remote UI
    ws.send(safeStringify({
      type: 'env_snapshot',
      inReplyTo: id,
      data: {
        height: env.height,
        timestamp: env.timestamp,
        runtimeId: env.runtimeId,
        entityCount: env.eReplicas?.size || 0,
        // Add more fields as needed
      }
    }));
    return;
  }

  ws.send(safeStringify({ type: 'error', error: `Unknown RPC type: ${type}` }));
};

// ============================================================================
// REST API
// ============================================================================

const handleApi = async (req: Request, pathname: string, env: Env | null): Promise<Response> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  // Health check
  if (pathname === '/api/health') {
    const { getHealthStatus } = await import('./health.js');
    const health = await getHealthStatus(env);
    return new Response(JSON.stringify(health), { headers });
  }

  // Runtime state
  if (pathname === '/api/state' && env) {
    return new Response(JSON.stringify({
      height: env.height,
      timestamp: env.timestamp,
      runtimeId: env.runtimeId,
      entityCount: env.eReplicas?.size || 0,
    }), { headers });
  }

  // Connected clients
  if (pathname === '/api/clients') {
    return new Response(JSON.stringify({
      count: clients.size,
      clients: Array.from(clients.keys()),
    }), { headers });
  }

  // J-watcher status / manual sync (ops/debug)
  if (pathname === '/api/jwatcher/status') {
    return new Response(JSON.stringify({
      started: jWatcherStarted,
      status: jWatcher?.getStatus?.() ?? null,
    }), { headers });
  }
  if (pathname === '/api/jwatcher/sync' && req.method === 'POST') {
    if (!env || !jWatcher?.syncOnce) {
      return new Response(JSON.stringify({ error: 'J-watcher not initialized' }), { status: 503, headers });
    }
    await jWatcher.syncOnce(env);
    return new Response(JSON.stringify({ success: true }), { headers });
  }

  // Token catalog (for UI token list + deposits)
  if (pathname === '/api/tokens') {
    try {
      if (!globalJAdapter) {
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }

      const tokens = await ensureTokenCatalog();
      return new Response(JSON.stringify({ tokens }), { headers });
    } catch (error: any) {
      console.error('[API/TOKENS] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // ============================================================================
  // FAUCET ENDPOINTS
  // ============================================================================

  // Faucet A: External ERC20 → user wallet
  if (pathname === '/api/faucet/erc20' && req.method === 'POST') {
    // Acquire mutex to prevent nonce collisions
    await faucetLock.acquire();
    try {
      const requestId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      const logPrefix = `FAUCET/ERC20 ${requestId}`;
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userAddress, tokenSymbol = 'USDC', amount = '100' } = body;
      console.log(`[${logPrefix}] Request: to=${userAddress} token=${tokenSymbol} amount=${amount}`);

      if (!userAddress || !ethers.isAddress(userAddress)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid userAddress' }), { status: 400, headers });
      }

      if (globalJAdapter.mode === 'browservm') {
        const browserVM = globalJAdapter.getBrowserVM();
        if (!browserVM?.fundSignerWallet) {
          faucetLock.release();
          return new Response(JSON.stringify({ error: 'BrowserVM faucet unavailable' }), { status: 503, headers });
        }
        const amountWei = ethers.parseUnits(amount, 18);
        await (browserVM as any).fundSignerWallet(userAddress, amountWei);
        faucetLock.release();
        console.log(`[${logPrefix}] BrowserVM funded ${userAddress} amount=${amount}`);
        return new Response(JSON.stringify({
          success: true,
          type: 'erc20',
          amount,
          tokenSymbol,
          userAddress,
          requestId,
        }), { headers });
      }

      if (tokenSymbol?.toUpperCase?.() === 'ETH') {
        const hub = await getHubWallet(env!);
        if (!hub) {
          faucetLock.release();
          return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
        }
        const hubWallet = hub.wallet;
        const topupAmount = ethers.parseEther(amount);
        const pendingNonce = await hubWallet.getNonce('pending');
        if (faucetNonce === null || pendingNonce > faucetNonce) {
          faucetNonce = pendingNonce;
        }
        const nonce = faucetNonce;
        const tx = await hubWallet.sendTransaction({
          to: userAddress,
          value: topupAmount,
          nonce,
        });
        faucetNonce = nonce + 1;
        await tx.wait();
        faucetLock.release();
        console.log(`[${logPrefix}] ETH-only faucet tx=${tx.hash}`);
        return new Response(JSON.stringify({
          success: true,
          type: 'gas',
          amount,
          tokenSymbol: 'ETH',
          userAddress,
          txHash: tx.hash,
          requestId,
        }), { headers });
      }

      const tokens = await ensureTokenCatalog();
      const tokenInfo = tokens.find(t => t.symbol?.toUpperCase() === tokenSymbol.toUpperCase());
      if (!tokenInfo?.address) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Token ${tokenSymbol} not found` }), { status: 404, headers });
      }
      const amountWei = ethers.parseUnits(amount, tokenInfo.decimals ?? 18);
      console.log(`[${logPrefix}] Token resolved: ${tokenInfo.symbol} @ ${tokenInfo.address}`);

      const hub = await getHubWallet(env!);
      if (!hub) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }

      const hubWallet = hub.wallet;
      console.log(`[${logPrefix}] Hub wallet: ${await hubWallet.getAddress()}`);

      // Transfer ERC20 from hub to user (with explicit nonce for safety)
      const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
      const erc20 = new ethers.Contract(tokenInfo.address, ERC20_ABI, hubWallet);
      const pendingNonce = await hubWallet.getNonce('pending');
      if (faucetNonce === null || pendingNonce > faucetNonce) {
        faucetNonce = pendingNonce;
      }
      const nonce = faucetNonce;
      const tx = await erc20.transfer(userAddress, amountWei, { nonce });
      faucetNonce = nonce + 1;
      await tx.wait();
      console.log(`[${logPrefix}] ERC20 transfer tx=${tx.hash}`);

      // Only top up ETH if user is low on gas
      let ethTxHash: string | undefined;
      try {
        const userEth = await globalJAdapter.provider.getBalance(userAddress);
        const minBalance = ethers.parseEther('0.01');
        const targetBalance = ethers.parseEther('0.1');
        if (userEth < minBalance) {
          const topup = targetBalance - userEth;
          const ethNonce = faucetNonce;
          const ethTx = await hubWallet.sendTransaction({
            to: userAddress,
            value: topup,
            nonce: ethNonce,
          });
          faucetNonce = ethNonce + 1;
          await ethTx.wait();
          ethTxHash = ethTx.hash;
          console.log(`[${logPrefix}] ETH topup tx=${ethTx.hash} topup=${ethers.formatEther(topup)}`);
        } else {
          console.log(`[${logPrefix}] ETH topup skipped (balance=${ethers.formatEther(userEth)})`);
        }
      } catch (err) {
        console.warn(`[${logPrefix}] ETH topup check failed:`, (err as Error).message);
      }

      faucetLock.release();
      return new Response(JSON.stringify({
        success: true,
        type: 'erc20',
        amount,
        tokenSymbol,
        userAddress,
        txHash: tx.hash,
        ...(ethTxHash ? { ethTxHash } : {}),
        requestId,
      }), { headers });
    } catch (error: any) {
      faucetLock.release();
      console.error('[FAUCET/ERC20] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet A2: Gas-only topup (for approve/deposit)
  if (pathname === '/api/faucet/gas' && req.method === 'POST') {
    await faucetLock.acquire();
    try {
      const requestId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      const logPrefix = `FAUCET/GAS ${requestId}`;
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userAddress, amount = '0.1' } = body;
      console.log(`[${logPrefix}] Request: to=${userAddress} amount=${amount}`);

      if (!userAddress || !ethers.isAddress(userAddress)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid userAddress' }), { status: 400, headers });
      }

      // Use hub wallet for gas topups (already funded on startup)
      const hub = await getHubWallet(env);
      if (!hub) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }
      const hubWallet = hub.wallet;

      const topupAmount = ethers.parseEther(amount);
      const pendingNonce = await hubWallet.getNonce('pending');
      if (faucetNonce === null || pendingNonce > faucetNonce) {
        faucetNonce = pendingNonce;
      }
      const nonce = faucetNonce;
      const tx = await hubWallet.sendTransaction({
        to: userAddress,
        value: topupAmount,
        nonce,
      });
      faucetNonce = nonce + 1;
      await tx.wait();
      console.log(`[${logPrefix}] ETH topup tx=${tx.hash}`);

      faucetLock.release();
      return new Response(JSON.stringify({
        success: true,
        type: 'gas',
        amount,
        userAddress,
        txHash: tx.hash,
        requestId,
      }), { headers });
    } catch (error: any) {
      faucetLock.release();
      console.error('[FAUCET/GAS] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet B: Hub reserve → user reserve via processBatch
  if (pathname === '/api/faucet/reserve' && req.method === 'POST') {
    // Acquire mutex to prevent nonce collisions
    await faucetLock.acquire();
    try {
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const userEntityId = body?.userEntityId;
      const rawTokenId = body?.tokenId ?? 1;
      let tokenId = typeof rawTokenId === 'number' ? rawTokenId : Number(rawTokenId);
      const tokenSymbol = typeof body?.tokenSymbol === 'string' ? body.tokenSymbol : undefined;
      const amount = typeof body?.amount === 'string' ? body.amount : String(body?.amount ?? '100');
      const requestId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      const logPrefix = `FAUCET/RESERVE ${requestId}`;

      if (!userEntityId) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }
      if (!Number.isFinite(tokenId)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
      }

      // Get hub from gossip (no hardcoded hub!)
      const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true && p.capabilities?.includes('faucet')) || [];
      if (hubs.length === 0) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }
      const hubEntityId = hubs[0].entityId;

      const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-reserve');
      const tokenCatalog = await ensureTokenCatalog();
      let tokenMeta = tokenCatalog.find(t => Number(t.tokenId) === Number(tokenId));
      if (!tokenMeta && tokenSymbol) {
        tokenMeta = tokenCatalog.find(t => t.symbol?.toUpperCase?.() === tokenSymbol.toUpperCase());
        if (tokenMeta?.tokenId !== undefined && tokenMeta?.tokenId !== null) {
          tokenId = Number(tokenMeta.tokenId);
        }
      }
      if (!tokenMeta) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Unknown token for faucet`, tokenId, tokenSymbol }), { status: 400, headers });
      }
      const decimals = typeof tokenMeta.decimals === 'number' ? tokenMeta.decimals : 18;
      const amountWei = ethers.parseUnits(amount, decimals);
      console.log(`[${logPrefix}] Request: hub=${hubEntityId.slice(0, 16)}... signer=${hubSignerId} → user=${userEntityId.slice(0, 16)}... tokenId=${tokenId} symbol=${tokenMeta.symbol} amount=${amount} decimals=${decimals}`);

      const prevUserReserve = await globalJAdapter.getReserves(userEntityId, tokenId).catch(() => 0n);
      let hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
      let hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
      const hubReserve = hubReplica?.state?.reserves?.get(String(tokenId)) ?? 0n;
      console.log(`[${logPrefix}] Hub reserve before R2R: token ${tokenId} = ${hubReserve.toString()}`);
      if (hubReserve < amountWei) {
        faucetLock.release();
        return new Response(JSON.stringify({
          error: `Hub has insufficient reserves for token ${tokenId}`,
          have: hubReserve.toString(),
          need: amountWei.toString(),
          requestId,
        }), { status: 409, headers });
      }

      // Use entity txs (R2R + j_broadcast) instead of direct admin call
      await runtimeProcess(env, [{
        entityId: hubEntityId,
        signerId: hubSignerId,
        entityTxs: [
          {
            type: 'reserve_to_reserve',
            data: {
              toEntityId: userEntityId,
              tokenId,
              amount: amountWei,
            },
          },
          {
            type: 'j_broadcast',
            data: {},
          },
        ],
      }]);
      // Log hub jBatchState summary after queuing
      hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
      hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
      if (hubReplica?.state?.jBatchState?.batch) {
        const batch = hubReplica.state.jBatchState.batch as any;
        console.log(`[${logPrefix}] Hub jBatch: r2r=${batch.reserveToReserve?.length || 0}, r2c=${batch.reserveToCollateral?.length || 0}, c2r=${batch.collateralToReserve?.length || 0}, settlements=${batch.settlements?.length || 0}, pending=${hubReplica.state.jBatchState.pendingBroadcast ? 'yes' : 'no'}`);
      }
      if (env.jReplicas) {
        for (const [name, replica] of env.jReplicas.entries()) {
          if ((replica.mempool?.length ?? 0) > 0) {
            console.log(`[${logPrefix}] J-mempool "${name}": size=${replica.mempool.length}, block=${replica.blockNumber ?? 0}, lastTs=${replica.lastBlockTimestamp ?? 0}`);
          }
        }
      }
      console.log(`[${logPrefix}] R2R + j_broadcast queued (waiting for J-event sync)`);
      if (jWatcher?.getStatus) {
        console.log(`[${logPrefix}] J-watcher status:`, jWatcher.getStatus());
      }
      if (jWatcher?.syncOnce) {
        try {
          await jWatcher.syncOnce(env);
          console.log(`[${logPrefix}] J-watcher syncOnce completed`);
        } catch (err) {
          console.warn(`[${logPrefix}] J-watcher syncOnce failed:`, (err as Error).message);
        }
      }
      await drainJWatcherQueue(env, logPrefix);

      const jBatchCleared = await waitForJBatchClear(env, 5000);
      if (!jBatchCleared) {
        faucetLock.release();
        return new Response(JSON.stringify({
          error: 'J-batch did not broadcast in time',
          requestId,
        }), { status: 504, headers });
      }

      const expectedMin = prevUserReserve + amountWei;
      const updatedReserve = await waitForReserveUpdate(userEntityId, tokenId, expectedMin, 10000);
      if (updatedReserve === null) {
        faucetLock.release();
        return new Response(JSON.stringify({
          error: 'Reserve update not confirmed on-chain',
          requestId,
        }), { status: 504, headers });
      }

      faucetLock.release();
      return new Response(JSON.stringify({
        success: true,
        type: 'reserve',
        amount,
        tokenId,
        from: hubEntityId.slice(0, 16) + '...',
        to: userEntityId.slice(0, 16) + '...',
        requestId,
      }), { headers });
    } catch (error: any) {
      faucetLock.release();
      console.error('[FAUCET/RESERVE] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet C: Offchain payment via bilateral account
  if (pathname === '/api/faucet/offchain' && req.method === 'POST') {
    try {
      if (!env) {
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userEntityId, tokenId = 1, amount = '100' } = body;

      if (!userEntityId) {
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }

      // Get hub from gossip (no hardcoded hub!)
      const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true && p.capabilities?.includes('faucet')) || [];
      if (hubs.length === 0) {
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }
      const hubEntityId = hubs[0].entityId;
      // Get actual signerId from entity's validators (not runtimeId!)
      const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-offchain');

      const amountWei = ethers.parseUnits(amount, 18);

      // Send payment from hub to user via account
      await runtimeProcess(env, [{
        entityId: hubEntityId,
        signerId: hubSignerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: userEntityId,
            tokenId,
            amount: amountWei,
            route: [hubEntityId, userEntityId], // Direct route
            description: 'faucet-offchain',
          },
        }],
      }]);

      return new Response(JSON.stringify({
        success: true,
        type: 'offchain',
        amount,
        tokenId,
        from: hubEntityId.slice(0, 16) + '...',
        to: userEntityId.slice(0, 16) + '...',
      }), { headers });
    } catch (error: any) {
      console.error('[FAUCET/OFFCHAIN] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
};

// ============================================================================
// MAIN SERVER
// ============================================================================

export async function startXlnServer(opts: Partial<XlnServerOptions> = {}): Promise<void> {
  console.log('═══ startXlnServer() CALLED ═══');
  console.log('Options:', opts);
  const options = { ...DEFAULT_OPTIONS, ...opts };
  relayServerId = options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server';
  const relaySeeds =
    opts.relaySeeds?.length
      ? opts.relaySeeds
      : process.env.RELAY_URL
        ? [process.env.RELAY_URL]
        : options.relaySeeds;

  // Always initialize runtime - every node needs it
  console.log('[XLN] Initializing runtime...');
  const env = await main(HUB_SEED);
  console.log('[XLN] Runtime initialized ✓');
  startRuntimeLoop(env);
  console.log('[XLN] Runtime event loop started ✓');

  // Initialize J-adapter (anvil for testnet, browserVM for local)
  const anvilRpc = process.env.ANVIL_RPC || 'http://localhost:8545';
  const useAnvil = process.env.USE_ANVIL === 'true';

  console.log('[XLN] J-adapter mode check:');
  console.log('  USE_ANVIL =', useAnvil);
  console.log('  ANVIL_RPC =', anvilRpc);

  if (useAnvil) {
    console.log('[XLN] Connecting to Anvil testnet...');

    // Fetch deployed contract addresses from jurisdictions.json
    const fs = await import('fs/promises');
    const path = await import('path');
    let fromReplica = undefined;
    try {
      // Try cwd first, then fallback to /root/xln (prod)
      const cwdPath = path.join(process.cwd(), 'jurisdictions.json');
      const prodPath = '/root/xln/jurisdictions.json';
      const jurisdictionsPath = await fs.access(cwdPath).then(() => cwdPath).catch(() => prodPath);
      console.log(`[XLN] Loading jurisdictions from: ${jurisdictionsPath}`);
      const jurisdictionsData = await fs.readFile(jurisdictionsPath, 'utf-8');
      const jurisdictions = JSON.parse(jurisdictionsData);
      const arrakisConfig = jurisdictions?.jurisdictions?.arrakis;

      if (arrakisConfig?.contracts) {
        fromReplica = {
          depositoryAddress: arrakisConfig.contracts.depository,
          entityProviderAddress: arrakisConfig.contracts.entityProvider,
          contracts: arrakisConfig.contracts,
          chainId: arrakisConfig.chainId ?? 31337,
        } as any;
        console.log('[XLN] Loaded contract addresses from jurisdictions.json');
      }
    } catch (err) {
      console.warn('[XLN] Could not load jurisdictions.json, will deploy fresh:', (err as Error).message);
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
        console.log(`[XLN] ✅ ANVIL ready (chainId: ${detectedChainId})`);
        break;
      } catch (err) {
        if (i === 0) console.log(`[XLN] ⏳ Waiting for ANVIL at ${anvilRpc}...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!anvilReady) {
      throw new Error(`❌ FAIL-FAST: ANVIL not reachable at ${anvilRpc} after ${maxRetries}s. Is hardhat node running?`);
    }

    // Ensure fromReplica carries correct chainId (override if stale)
    if (fromReplica && fromReplica.chainId !== detectedChainId) {
      console.warn(`[XLN] fromReplica chainId (${fromReplica.chainId}) does not match RPC chainId (${detectedChainId}) - overriding`);
      fromReplica.chainId = detectedChainId as any;
    }

    globalJAdapter = await createJAdapter({
      mode: 'rpc',
      chainId: detectedChainId,
      rpcUrl: anvilRpc,
      fromReplica, // Pass pre-deployed addresses (if available)
    });

    const block = await globalJAdapter.provider.getBlockNumber();
    console.log(`[XLN] Anvil connected (block: ${block})`);

    // Ensure jurisdictions.json reflects current RPC + addresses (even if using fromReplica)
    if (globalJAdapter.addresses?.depository && globalJAdapter.addresses?.entityProvider) {
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId);
    }

    const hasAddresses = !!globalJAdapter.addresses?.depository && !!globalJAdapter.addresses?.entityProvider;

    // Deploy if addresses missing (fromReplica invalid or fresh chain)
    if (!hasAddresses) {
      console.log('[XLN] Deploying contracts to anvil (missing addresses)...');
      await globalJAdapter.deployStack();
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId);
      console.log('[XLN] Contracts deployed');
    } else if (!fromReplica && block === 0) {
      console.log('[XLN] Deploying contracts to anvil (fresh chain)...');
      await globalJAdapter.deployStack();
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId);
      console.log('[XLN] Contracts deployed');
    } else if (fromReplica) {
      console.log('[XLN] Using pre-deployed contracts from jurisdictions.json');
    } else {
      console.log('[XLN] Using existing contracts on anvil (block > 0)');
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
        console.log(`[XLN] J-replica "${jName}" registered in env`);
      }
      if (!env.activeJurisdiction) env.activeJurisdiction = jName;
    }
  } else {
    console.log('[XLN] Using BrowserVM (local mode)');
    globalJAdapter = await createJAdapter({
      mode: 'browservm',
      chainId: 1337,
    });
    await globalJAdapter.deployStack();
  }

  // Start J-Event Watcher for RPC mode (required to sync ReserveUpdated into entityState)
  if (!jWatcherStarted && globalJAdapter && globalJAdapter.mode !== 'browservm') {
    try {
      const { setupJEventWatcher } = await import('./j-event-watcher');
      const entityProviderAddress = globalJAdapter.addresses.entityProvider;
      const depositoryAddress = globalJAdapter.addresses.depository;
      if (anvilRpc && entityProviderAddress && depositoryAddress) {
        console.log(`[XLN] Starting J-Event Watcher (rpc=${anvilRpc})`);
        jWatcher = await setupJEventWatcher(env, anvilRpc, entityProviderAddress, depositoryAddress);
        jWatcherStarted = true;
        startJWatcherProcessingLoop(env);
        console.log('[XLN] J-Event Watcher started ✓');
      } else {
        console.warn('[XLN] J-Event Watcher not started (missing RPC or contract addresses)');
      }
    } catch (err) {
      console.warn('[XLN] Failed to start J-Event Watcher:', (err as Error).message);
    }
  }

  // Start runtime tick loop for J-mempool + pending outputs
  startRuntimeTickLoop(env);

  // Bootstrap hub entities (idempotent - normal entity + gossip tag)
  const { bootstrapHubs } = await import('../scripts/bootstrap-hub');
  const relayUrl = relaySeeds?.[0] ?? 'wss://xln.finance/relay';
  const publicRpc = process.env.PUBLIC_RPC ?? anvilRpc;
  const publicHttp = process.env.PUBLIC_HTTP ?? '';
  const hubConfigs = [
    {
      name: 'H1',
      region: 'global',
      signerId: 'hub-1',
      seed: HUB_SEED,
      routingFeePPM: 100,
      relayUrl,
      rpcUrl: publicRpc,
      httpUrl: publicHttp,
      port: options.port,
      serverId: options.serverId,
      capabilities: ['hub', 'routing', 'faucet'],
      position: { x: -80, y: 0, z: 0 },
    },
    {
      name: 'H2',
      region: 'global',
      signerId: 'hub-2',
      seed: HUB_SEED,
      routingFeePPM: 100,
      relayUrl,
      rpcUrl: publicRpc,
      httpUrl: publicHttp,
      port: options.port,
      serverId: options.serverId,
      capabilities: ['hub', 'routing', 'faucet'],
      position: { x: 0, y: 0, z: 0 },
    },
    {
      name: 'H3',
      region: 'global',
      signerId: 'hub-3',
      seed: HUB_SEED,
      routingFeePPM: 100,
      relayUrl,
      rpcUrl: publicRpc,
      httpUrl: publicHttp,
      port: options.port,
      serverId: options.serverId,
      capabilities: ['hub', 'routing', 'faucet'],
      position: { x: 80, y: 0, z: 0 },
    },
  ];

  const hubBootstraps = await bootstrapHubs(env, hubConfigs);
  const hubEntityIds = hubBootstraps.map(h => h.entityId);
  for (const hub of hubBootstraps) {
    hubSignerLabels.set(hub.entityId, hub.signerLabel);
    hubSignerAddresses.set(hub.entityId, hub.signerId);
  }

  // Start P2P overlay for hub announcements
  if (hubEntityIds.length > 0) {
    startP2P(env, {
      relayUrls: relaySeeds,
      advertiseEntityIds: hubEntityIds,
      isHub: true,  // CRITICAL: Mark as hub so profiles get isHub metadata
    });
  }

  // Wait for gossip to update (gossip.announce() might be async)
  await new Promise(resolve => setTimeout(resolve, 100));

  // Get hubs from gossip for funding
  const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true) || [];
  console.log(`[XLN] Found ${hubs.length} hubs in gossip`);

  if (hubs.length > 0 && globalJAdapter) {
    console.log('[XLN] Funding hub reserves...');

    // Ensure tokens exist on RPC/anvil before funding
    const tokenCatalog = await ensureTokenCatalog();

    // Ensure deployer has ETH on anvil (avoids faucet/deploy gas failures)
    try {
      if (globalJAdapter.chainId === 31337 && 'send' in globalJAdapter.provider) {
        const provider = globalJAdapter.provider as ethers.JsonRpcProvider;
        const deployerAddress = await globalJAdapter.signer.getAddress();
        const targetDeployerEth = ethers.parseEther('10000');
        await provider.send('anvil_setBalance', [deployerAddress, ethers.toBeHex(targetDeployerEth)]);
        console.log('[XLN] Anvil deployer balance topped up');
      }
    } catch (err) {
      console.warn('[XLN] Failed to top up anvil deployer:', (err as Error).message);
    }

    for (const hubProfile of hubs) {
      const hub = await getHubWallet(env, hubProfile.entityId);
      if (!hub) {
        console.warn('[XLN] Hub wallet not available (gossip missing)');
        continue;
      }
      const hubEntityId = hub.hubEntityId;
      const hubWallet = hub.wallet;
      const hubWalletAddress = await hubWallet.getAddress();

      console.log(`[XLN] Hub wallet address (${hubEntityId.slice(0, 10)}...): ${hubWalletAddress}`);

      // Fund hub wallet if using BrowserVM
      if (globalJAdapter.mode === 'browservm') {
        const browserVM = globalJAdapter.getBrowserVM();
        if (browserVM) {
          await (browserVM as any).fundSignerWallet(hubWalletAddress, 1_000_000_000n * 10n ** 18n); // 1B tokens
          console.log('[XLN] Hub wallet funded with ERC20 + ETH');
        }
      } else {
        // RPC/anvil: Fund hub wallet with ERC20 tokens + ETH from deployer
        const deployer = globalJAdapter.signer;
        const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

        for (const token of tokenCatalog) {
          if (!token?.address) continue;
          try {
            const erc20 = new ethers.Contract(token.address, ERC20_ABI, deployer);
            const hubBalance = await erc20.balanceOf(hubWalletAddress);
            const targetBalance = 1_000_000_000n * 10n ** BigInt(token.decimals ?? 18);
            if (hubBalance < targetBalance) {
              const transferAmount = targetBalance - hubBalance;
              const tx = await erc20.transfer(hubWalletAddress, transferAmount);
              await tx.wait();
              console.log(`[XLN] Hub wallet funded with ${token.symbol}: ${ethers.formatUnits(transferAmount, token.decimals ?? 18)}`);
            }
          } catch (err) {
            console.warn(`[XLN] Hub wallet funding failed (${token.symbol}):`, (err as Error).message);
          }
        }

        // Fund hub wallet with ETH for gas (huge amount for faucet operations)
        try {
          const currentEth = await globalJAdapter.provider.getBalance(hubWalletAddress);
          const targetEth = ethers.parseEther('1000'); // 1000 ETH for faucet operations
          if (currentEth < targetEth) {
            const topup = targetEth - currentEth;
            const ethTx = await deployer.sendTransaction({ to: hubWalletAddress, value: topup });
            await ethTx.wait();
            console.log(`[XLN] Hub wallet funded with ${ethers.formatEther(topup)} ETH for gas`);
          } else {
            console.log('[XLN] Hub wallet already has sufficient ETH');
          }
        } catch (err) {
          console.error('[XLN] Hub wallet ETH funding failed:', (err as Error).message);
        }
      }

      // Fund hub entity reserves in Depository (all registered tokens)
      const reserveTokens = tokenCatalog.length > 0 ? tokenCatalog : await globalJAdapter.getTokenRegistry().catch(() => []);
      for (const token of reserveTokens) {
        const tokenId = typeof token.tokenId === 'number' ? token.tokenId : undefined;
        if (!tokenId) continue;
        const decimals = typeof token.decimals === 'number' ? token.decimals : 18;
        const amount = 1_000_000_000n * 10n ** BigInt(decimals);
        try {
          const events = await globalJAdapter.debugFundReserves(hubEntityId, tokenId, amount);
          console.log(`[XLN] Hub reserves funded: tokenId=${tokenId} amount=${ethers.formatUnits(amount, decimals)} for ${hubEntityId.slice(0, 10)}...`);
          await applyJEventsToEnv(env, events, 'HUB-FUND');
        } catch (err) {
          console.warn(`[XLN] Hub reserve funding failed (tokenId=${tokenId}):`, (err as Error).message);
        }
      }
    }
  }

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade
      if (req.headers.get('upgrade') === 'websocket') {
        const wsType = pathname === '/relay' ? 'relay' : pathname === '/rpc' ? 'rpc' : null;
        if (wsType) {
          const upgraded = server.upgrade(req, { data: { type: wsType, env } });
          if (upgraded) return undefined as any;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // REST API
      if (pathname.startsWith('/api/')) {
        return handleApi(req, pathname, env);
      }

      // Static files
      if (options.staticDir) {
        // Root → index.html
        if (pathname === '/') {
          const index = await serveStatic('/index.html', options.staticDir);
          if (index) return index;
        }

        // Try static file
        const file = await serveStatic(pathname, options.staticDir);
        if (file) return file;

        // SPA fallback
        const fallback = await serveStatic('/index.html', options.staticDir);
        if (fallback) return fallback;
      }

      return new Response('Not found', { status: 404 });
    },

    websocket: {
      open(ws) {
        const data = (ws as any).data;
        console.log(`[WS] New ${data.type} connection`);
      },

      message(ws, message) {
        const data = (ws as any).data;
        try {
          const msg = JSON.parse(message.toString());
          if (data.type === 'relay') {
            handleRelayMessage(ws, msg, data.env);
          } else if (data.type === 'rpc') {
            handleRpcMessage(ws, msg, data.env);
          }
        } catch (error) {
          console.error('[WS] Parse error:', error);
          ws.send(safeStringify({ type: 'error', error: 'Invalid JSON' }));
        }
      },

      close(ws) {
        // Remove from clients
        for (const [id, client] of clients) {
          if (client.ws === ws) {
            clients.delete(id);
            break;
          }
        }
      },
    },
  });

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                      XLN Unified Server                          ║
╠══════════════════════════════════════════════════════════════════╣
║  Port: ${String(options.port).padEnd(10)}                                       ║
║  Host: ${(options.host || '0.0.0.0').padEnd(10)}                                       ║
║  Mode: ${(globalJAdapter ? globalJAdapter.mode : 'no-jadapter').padEnd(10)}                                       ║
╠══════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                      ║
║    GET  /                     → SPA                              ║
║    WS   /relay                → P2P relay                        ║
║    WS   /rpc                  → Remote UI                        ║
║    GET  /api/health           → Health check                     ║
║    GET  /api/state            → Runtime state                    ║
║    GET  /api/clients          → Connected clients                ║
║    POST /api/faucet/erc20     → Faucet A (wallet ERC20)          ║
║    POST /api/faucet/reserve   → Faucet B (reserve transfer)      ║
║    POST /api/faucet/offchain  → Faucet C (account payment)       ║
╚══════════════════════════════════════════════════════════════════╝
  `);

  return;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (import.meta.main) {
  console.log('═══ SERVER.TS ENTRY POINT ═══');
  console.log('ENV: USE_ANVIL =', process.env.USE_ANVIL);
  console.log('ENV: ANVIL_RPC =', process.env.ANVIL_RPC);
  console.log('Args:', process.argv.slice(2));

  const args = process.argv.slice(2);

  const getArg = (name: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] || fallback;
  };

  const options: Partial<XlnServerOptions> = {
    port: Number(getArg('--port', '8080')),
    host: getArg('--host', '0.0.0.0'),
    staticDir: getArg('--static-dir', './frontend/build'),
    serverId: getArg('--server-id', 'xln-server'),
  };

  console.log('Calling startXlnServer with options:', options);

  startXlnServer(options).then(() => {
    console.log('[XLN] Server started successfully');
  }).catch(error => {
    console.error('[XLN] Server failed:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
  });
}
