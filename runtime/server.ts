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

import { main, process as runtimeProcess, applyRuntimeInput } from './runtime';
import { safeStringify } from './serialization-utils';
import type { Env, EntityInput, RuntimeInput } from './types';
import { encodeBoard, hashBoard } from './entity-factory';
import { deriveSignerKeySync } from './account-crypto';
import { createJAdapter, type JAdapter } from './jadapter';
import type { JTokenInfo } from './jadapter/types';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from './jadapter/default-tokens';
import { resolveEntityProposerId } from './state-helpers';
import { ethers } from 'ethers';
import { ERC20Mock__factory } from '../jurisdictions/typechain-types/factories/ERC20Mock__factory';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
let jWatcherStarted = false;
let jWatcher: any = null;
const HUB_SEED = process.env.HUB_SEED ?? 'xln-main-hub-2026';

let tokenCatalogCache: JTokenInfo[] | null = null;
let tokenCatalogPromise: Promise<JTokenInfo[]> | null = null;

const getHubWallet = async (env: Env): Promise<{ hubEntityId: string; hubSignerId: string; wallet: ethers.Wallet } | null> => {
  if (!globalJAdapter) return null;
  const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true) || [];
  if (hubs.length === 0) return null;
  const hubEntityId = hubs[0].entityId;
  const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'hub-wallet');
  const hubPrivateKeyBytes = deriveSignerKeySync(HUB_SEED, hubSignerId);
  const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
  const wallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);
  return { hubEntityId, hubSignerId, wallet };
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

    // Pack token reference: tokenType (8 bits) | address (160 bits) | externalTokenId (96 bits)
    const packedToken = await depository.packTokenReference(0, tokenAddress, 0); // tokenType=0 (ERC20), externalTokenId=0
    const registerTx = await depository.connect(signer as any).externalTokenToReserve({
      entity: ethers.ZeroHash,
      packedToken,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    });
    await registerTx.wait();
    console.log(`[XLN] Token registered: ${token.symbol} @ ${tokenAddress.slice(0, 10)}...`);
  }
};

const ensureTokenCatalog = async (): Promise<JTokenInfo[]> => {
  if (!globalJAdapter) return [];
  if (tokenCatalogCache && tokenCatalogCache.length > 0) return tokenCatalogCache;
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

const updateJurisdictionsJson = async (contracts: JAdapter['addresses'], rpcUrl?: string): Promise<void> => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const candidates = [
      path.join(process.cwd(), 'jurisdictions.json'),
      path.join(process.cwd(), 'frontend', 'static', 'jurisdictions.json'),
      path.join(process.cwd(), 'frontend', 'build', 'jurisdictions.json'),
      '/var/www/html/jurisdictions.json',
    ];

    for (const filePath of candidates) {
      try {
        await fs.access(filePath);
      } catch {
        continue;
      }
      let data: any = {};
      try {
        data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      } catch {
        data = {};
      }
      data.testnet = {
        ...(data.testnet ?? {}),
        chainId: 31337,
        ...(rpcUrl ? { rpcs: [rpcUrl] } : {}),
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

let wsCounter = 0;
const nextWsTimestamp = () => ++wsCounter;

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
        return new Response(JSON.stringify({
          success: true,
          type: 'erc20',
          amount,
          tokenSymbol,
          userAddress,
        }), { headers });
      }

      const tokens = await ensureTokenCatalog();
      const tokenInfo = tokens.find(t => t.symbol?.toUpperCase() === tokenSymbol.toUpperCase());
      if (!tokenInfo?.address) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Token ${tokenSymbol} not found` }), { status: 404, headers });
      }
      const amountWei = ethers.parseUnits(amount, tokenInfo.decimals ?? 18);

      const hub = await getHubWallet(env!);
      if (!hub) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }

      const hubWallet = hub.wallet;

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

      // Also send ETH for gas (0.01 ETH) so user can approve/deposit
      const ethAmount = ethers.parseEther('0.01');
      const ethNonce = faucetNonce;
      const ethTx = await hubWallet.sendTransaction({
        to: userAddress,
        value: ethAmount,
        nonce: ethNonce,
      });
      faucetNonce = ethNonce + 1;
      await ethTx.wait();

      faucetLock.release();
      return new Response(JSON.stringify({
        success: true,
        type: 'erc20',
        amount,
        tokenSymbol,
        userAddress,
        txHash: tx.hash,
        ethTxHash: ethTx.hash,
        ethAmount: '0.01',
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
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userAddress, amount = '0.02' } = body;

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

      faucetLock.release();
      return new Response(JSON.stringify({
        success: true,
        type: 'gas',
        amount,
        userAddress,
        txHash: tx.hash,
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
      const { userEntityId, tokenId = 1, amount = '100' } = body;

      if (!userEntityId) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }

      // Get hub from gossip (no hardcoded hub!)
      const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true && p.capabilities?.includes('faucet')) || [];
      if (hubs.length === 0) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'No faucet hub available' }), { status: 503, headers });
      }
      const hubEntityId = hubs[0].entityId;

      const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-reserve');
      const amountWei = ethers.parseUnits(amount, 18);
      console.log(`[FAUCET/RESERVE] Request: hub=${hubEntityId.slice(0, 16)}... signer=${hubSignerId} → user=${userEntityId.slice(0, 16)}... tokenId=${tokenId} amount=${amount}`);

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
      console.log('[FAUCET/RESERVE] R2R + j_broadcast queued (waiting for J-event sync)');
      if (jWatcher?.syncOnce) {
        try {
          await jWatcher.syncOnce(env);
          console.log('[FAUCET/RESERVE] J-watcher syncOnce completed');
        } catch (err) {
          console.warn('[FAUCET/RESERVE] J-watcher syncOnce failed:', (err as Error).message);
        }
      }

      faucetLock.release();
      return new Response(JSON.stringify({
        success: true,
        type: 'reserve',
        amount,
        tokenId,
        from: hubEntityId.slice(0, 16) + '...',
        to: userEntityId.slice(0, 16) + '...',
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

  // Always initialize runtime - every node needs it
  console.log('[XLN] Initializing runtime...');
  const env = await main();
  console.log('[XLN] Runtime initialized ✓');

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
      const testnetConfig = jurisdictions.testnet;

      if (testnetConfig?.contracts) {
        fromReplica = {
          depositoryAddress: testnetConfig.contracts.depository,
          entityProviderAddress: testnetConfig.contracts.entityProvider,
          contracts: testnetConfig.contracts,
          chainId: 31337,
        } as any;
        console.log('[XLN] Loaded contract addresses from jurisdictions.json');
      }
    } catch (err) {
      console.warn('[XLN] Could not load jurisdictions.json, will deploy fresh:', (err as Error).message);
    }

    globalJAdapter = await createJAdapter({
      mode: 'rpc',
      chainId: 31337,
      rpcUrl: anvilRpc,
      fromReplica, // Pass pre-deployed addresses (if available)
    });

    const block = await globalJAdapter.provider.getBlockNumber();
    console.log(`[XLN] Anvil connected (block: ${block})`);

    const hasAddresses = !!globalJAdapter.addresses?.depository && !!globalJAdapter.addresses?.entityProvider;

    // Deploy if addresses missing (fromReplica invalid or fresh chain)
    if (!hasAddresses) {
      console.log('[XLN] Deploying contracts to anvil (missing addresses)...');
      await globalJAdapter.deployStack();
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc);
      console.log('[XLN] Contracts deployed');
    } else if (!fromReplica && block === 0) {
      console.log('[XLN] Deploying contracts to anvil (fresh chain)...');
      await globalJAdapter.deployStack();
      await updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc);
      console.log('[XLN] Contracts deployed');
    } else if (fromReplica) {
      console.log('[XLN] Using pre-deployed contracts from jurisdictions.json');
    } else {
      console.log('[XLN] Using existing contracts on anvil (block > 0)');
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
        console.log('[XLN] J-Event Watcher started ✓');
      } else {
        console.warn('[XLN] J-Event Watcher not started (missing RPC or contract addresses)');
      }
    } catch (err) {
      console.warn('[XLN] Failed to start J-Event Watcher:', (err as Error).message);
    }
  }

  // Bootstrap hub entity (idempotent - normal entity + gossip tag)
  const { bootstrapHub } = await import('../scripts/bootstrap-hub');
  await bootstrapHub(env);

  // Wait for gossip to update (gossip.announce() might be async)
  await new Promise(resolve => setTimeout(resolve, 100));

  // Get hub from gossip for funding
  const hubs = env.gossip?.getProfiles()?.filter(p => p.metadata?.isHub === true) || [];
  console.log(`[XLN] Found ${hubs.length} hubs in gossip`);

  if (hubs.length > 0 && globalJAdapter) {
    console.log('[XLN] Funding hub reserves...');

    const hub = await getHubWallet(env);
    if (!hub) {
      console.warn('[XLN] Hub wallet not available (gossip missing)');
    } else {
      const hubEntityId = hub.hubEntityId;
      const hubWallet = hub.wallet;
      const hubWalletAddress = await hubWallet.getAddress();

      console.log(`[XLN] Hub wallet address: ${hubWalletAddress}`);

      // Ensure tokens exist on RPC/anvil before funding
      const tokenCatalog = await ensureTokenCatalog();

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

        // Fund hub wallet with 1B of each token
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
          console.log(`[XLN] Hub wallet current ETH: ${ethers.formatEther(currentEth)}, target: ${ethers.formatEther(targetEth)}`);
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
          await globalJAdapter.debugFundReserves(hubEntityId, tokenId, amount);
          console.log(`[XLN] Hub reserves funded: tokenId=${tokenId} amount=${ethers.formatUnits(amount, decimals)}`);
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
