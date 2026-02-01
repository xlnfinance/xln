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

import { main, getEnv, process as runtimeProcess, applyRuntimeInput } from './runtime';
import { safeStringify } from './serialization-utils';
import type { Env, EntityInput, RuntimeInput } from './types';
import { encodeBoard, hashBoard } from './entity-factory';
import { registerSignerKey, deriveSignerKeySync, getCachedSignerAddress } from './account-crypto';
import { createJAdapter, type JAdapter } from './jadapter';
import { ethers } from 'ethers';

// ============================================================================
// MAIN HUB CONFIGURATION
// ============================================================================

const MAIN_HUB_CONFIG = {
  name: 'Main',
  signerId: '1', // Fixed signer ID for Main hub
  seed: 'xln-main-hub-2026', // Fixed seed for deterministic key derivation
  faucetAmount: 100n * 10n ** 18n, // $100 in wei (18 decimals)
  faucetTokenId: 1, // USDC
};

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;

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
    return new Response(JSON.stringify({
      status: 'ok',
      runtime: !!env,
      clients: clients.size,
      timestamp: Date.now(),
    }), { headers });
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

  // ============================================================================
  // FAUCET ENDPOINTS
  // ============================================================================

  // Faucet A: External ERC20 → user wallet
  if (pathname === '/api/faucet/erc20' && req.method === 'POST') {
    try {
      if (!globalJAdapter) {
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userAddress, tokenSymbol = 'USDC', amount = '100' } = body;

      if (!userAddress || !ethers.isAddress(userAddress)) {
        return new Response(JSON.stringify({ error: 'Invalid userAddress' }), { status: 400, headers });
      }

      const amountWei = ethers.parseUnits(amount, 18);

      // Get hub's private key (convert Uint8Array to hex string for ethers)
      const hubPrivateKeyBytes = deriveSignerKeySync(MAIN_HUB_CONFIG.seed, MAIN_HUB_CONFIG.signerId);
      const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
      const hubWallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);

      // Get token contract
      const tokenRegistry = (globalJAdapter as any).getBrowserVM?.()?.getTokenRegistry() || [];
      const token = tokenRegistry.find((t: any) => t.symbol === tokenSymbol);

      if (!token) {
        return new Response(JSON.stringify({ error: `Token ${tokenSymbol} not found` }), { status: 404, headers });
      }

      // Transfer ERC20 from hub to user
      const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
      const erc20 = new ethers.Contract(token.address, ERC20_ABI, hubWallet);
      const tx = await erc20.transfer(userAddress, amountWei);
      await tx.wait();

      return new Response(JSON.stringify({
        success: true,
        type: 'erc20',
        amount,
        tokenSymbol,
        userAddress,
        txHash: tx.hash,
      }), { headers });
    } catch (error: any) {
      console.error('[FAUCET/ERC20] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet B: Hub reserve → user reserve via processBatch
  if (pathname === '/api/faucet/reserve' && req.method === 'POST') {
    try {
      if (!globalJAdapter) {
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env || !(env as any).mainHubEntityId) {
        return new Response(JSON.stringify({ error: 'Hub entity not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userEntityId, tokenId = 1, amount = '100' } = body;

      if (!userEntityId) {
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }

      const amountWei = ethers.parseUnits(amount, 18);
      const hubEntityId = (env as any).mainHubEntityId;

      // Use reserveToReserve via jadapter
      await globalJAdapter.reserveToReserve(hubEntityId, userEntityId, tokenId, amountWei);

      return new Response(JSON.stringify({
        success: true,
        type: 'reserve',
        amount,
        tokenId,
        from: hubEntityId.slice(0, 16) + '...',
        to: userEntityId.slice(0, 16) + '...',
      }), { headers });
    } catch (error: any) {
      console.error('[FAUCET/RESERVE] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet C: Offchain payment via bilateral account
  if (pathname === '/api/faucet/offchain' && req.method === 'POST') {
    try {
      if (!env || !(env as any).mainHubEntityId) {
        return new Response(JSON.stringify({ error: 'Hub entity not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const { userEntityId, tokenId = 1, amount = '100' } = body;

      if (!userEntityId) {
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }

      const amountWei = ethers.parseUnits(amount, 18);
      const hubEntityId = (env as any).mainHubEntityId;

      // Send payment from hub to user via account
      await runtimeProcess(env, [{
        entityId: hubEntityId,
        signerId: MAIN_HUB_CONFIG.signerId,
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

// Create Main hub entity and register in environment
async function createMainHub(env: Env): Promise<string> {
  console.log('[XLN] Creating Main hub entity...');

  // Register signer key with fixed seed
  const privateKey = deriveSignerKeySync(MAIN_HUB_CONFIG.seed, MAIN_HUB_CONFIG.signerId);
  registerSignerKey(MAIN_HUB_CONFIG.signerId, privateKey);

  // Create board config for Main hub
  const config = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [MAIN_HUB_CONFIG.signerId],
    shares: { [MAIN_HUB_CONFIG.signerId]: 1n },
    jurisdiction: 'arrakis' // Bound to arrakis J-machine
  };

  const encodedBoard = encodeBoard(config);
  const boardHash = hashBoard(encodedBoard);
  const entityId = boardHash; // Lazy entity: entityId = boardHash

  // Create the hub entity
  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
      entityId,
      signerId: MAIN_HUB_CONFIG.signerId,
      data: {
        isProposer: true,
        position: { x: 0, y: 0, z: 0 }, // Center position
        config
      }
    }],
    entityInputs: []
  });

  // Announce in gossip as hub
  if (env.gossip) {
    env.gossip.announce({
      entityId,
      runtimeId: MAIN_HUB_CONFIG.signerId,
      capabilities: ['router', 'hub', 'faucet'],
      metadata: {
        name: MAIN_HUB_CONFIG.name,
        isHub: true,
        region: 'global',
        version: '1.0.0',
      }
    });
  }

  console.log(`[XLN] ✅ Main hub created: ${entityId.slice(0, 16)}...`);
  console.log(`[XLN]    SignerId: ${MAIN_HUB_CONFIG.signerId}`);
  console.log(`[XLN]    Faucet: $${Number(MAIN_HUB_CONFIG.faucetAmount / 10n ** 18n)} USDC on account open`);

  // Store Main hub entityId for faucet logic
  (env as any).mainHubEntityId = entityId;

  return entityId;
}

export async function startXlnServer(opts: Partial<XlnServerOptions> = {}): Promise<void> {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  // Always initialize runtime - every node needs it
  console.log('[XLN] Initializing runtime...');
  const env = await main();

  // Initialize J-adapter (anvil for testnet, browserVM for local)
  const anvilRpc = process.env.ANVIL_RPC || 'http://localhost:8545';
  const useAnvil = process.env.USE_ANVIL === 'true';

  if (useAnvil) {
    console.log('[XLN] Connecting to Anvil testnet...');
    try {
      globalJAdapter = await createJAdapter({
        mode: 'rpc',
        chainId: 31337,
        rpcUrl: anvilRpc,
      });

      // Check if contracts deployed
      const block = await globalJAdapter.provider.getBlockNumber();
      console.log(`[XLN] Anvil connected (block: ${block})`);

      // Deploy contracts if block 0 (fresh anvil)
      if (block === 0) {
        console.log('[XLN] Deploying contracts to anvil...');
        await globalJAdapter.deployStack();
        console.log('[XLN] Contracts deployed');
      }
    } catch (error) {
      console.warn('[XLN] Anvil connection failed, falling back to BrowserVM:', error);
      globalJAdapter = null;
    }
  } else {
    console.log('[XLN] Using BrowserVM (local mode)');
    globalJAdapter = await createJAdapter({
      mode: 'browservm',
      chainId: 1337,
    });
    await globalJAdapter.deployStack();
  }

  // Create Main hub entity (relay hub)
  const mainHubEntityId = await createMainHub(env);

  // Fund hub reserves if using J-adapter
  if (globalJAdapter) {
    console.log('[XLN] Funding hub reserves...');

    // Fund hub wallet address with ETH (for gas) and ERC20 tokens
    const hubPrivateKeyBytes = deriveSignerKeySync(MAIN_HUB_CONFIG.seed, MAIN_HUB_CONFIG.signerId);
    const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
    const hubWallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);
    const hubWalletAddress = await hubWallet.getAddress();

    console.log(`[XLN] Hub wallet address: ${hubWalletAddress}`);

    // Fund hub wallet if using BrowserVM
    if (globalJAdapter.mode === 'browservm') {
      const browserVM = globalJAdapter.getBrowserVM();
      if (browserVM) {
        await (browserVM as any).fundSignerWallet(hubWalletAddress, 1_000_000n * 10n ** 18n); // 1M tokens
        console.log('[XLN] Hub wallet funded with ERC20 + ETH');
      }
    }

    // Fund hub entity reserves in Depository
    await globalJAdapter.debugFundReserves(mainHubEntityId, MAIN_HUB_CONFIG.faucetTokenId, 1_000_000_000n * 10n ** 18n); // $1B
    console.log('[XLN] Hub reserves funded');
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

  startXlnServer(options).catch(error => {
    console.error('[XLN] Server failed:', error);
    process.exit(1);
  });
}
