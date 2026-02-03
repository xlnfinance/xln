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
import { resolveEntityProposerId } from './state-helpers';
import { ethers } from 'ethers';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
let jWatcherStarted = false;

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
const ANVIL_TOKEN_CATALOG = [
  { symbol: 'USDC', address: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E', decimals: 18, tokenId: 1 },
  { symbol: 'WETH', address: '0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB', decimals: 18, tokenId: 2 },
  { symbol: 'USDT', address: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9', decimals: 18, tokenId: 3 },
];
const ANVIL_TOKENS: Record<string, string> = Object.fromEntries(
  ANVIL_TOKEN_CATALOG.map((t) => [t.symbol, t.address])
);

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

  // Token catalog (for UI token list + deposits)
  if (pathname === '/api/tokens') {
    try {
      if (!globalJAdapter) {
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }

      // BrowserVM: return registry directly
      if (globalJAdapter.mode === 'browservm') {
        const registry = globalJAdapter.getBrowserVM?.()?.getTokenRegistry?.() || [];
        return new Response(JSON.stringify({ tokens: registry }), { headers });
      }

      // RPC: query Depository token registry
      const depositoryAddress = (globalJAdapter as any).addresses?.depository;
      if (!depositoryAddress) {
        return new Response(JSON.stringify({ error: 'Depository address not available' }), { status: 503, headers });
      }

      const provider = globalJAdapter.provider;
      const depository = new ethers.Contract(depositoryAddress, [
        'function getTokensLength() view returns (uint256)',
        'function getTokenMetadata(uint256 tokenId) view returns (address contractAddress, uint96 externalTokenId, uint8 tokenType)',
      ], provider);
      const erc20Interface = new ethers.Interface([
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
      ]);

      const length = Number(await depository.getTokensLength());
      const tokens: Array<{ symbol: string; address: string; decimals: number; tokenId: number }> = [];

      for (let tokenId = 1; tokenId < length; tokenId++) {
        const [contractAddress, _externalTokenId, tokenType] = await depository.getTokenMetadata(tokenId);
        // TypeERC20 = 0; skip non-ERC20 for UI
        if (Number(tokenType) !== 0) continue;

        const erc20 = new ethers.Contract(contractAddress, erc20Interface, provider);
        let symbol = `TKN${tokenId}`;
        let decimals = 18;
        try {
          symbol = await erc20.symbol();
        } catch { }
        try {
          decimals = Number(await erc20.decimals());
        } catch { }
        tokens.push({ symbol, address: contractAddress, decimals, tokenId });
      }

      if (tokens.length === 0 && globalJAdapter.mode === 'rpc') {
        return new Response(JSON.stringify({ tokens: ANVIL_TOKEN_CATALOG }), { headers });
      }

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

      const body = await req.json();
      const { userAddress, tokenSymbol = 'USDC', amount = '100' } = body;

      if (!userAddress || !ethers.isAddress(userAddress)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid userAddress' }), { status: 400, headers });
      }

      const amountWei = ethers.parseUnits(amount, 18);

      // Get hub's private key from default seed
      const hubSeed = 'xln-main-hub-2026';
      const hubSignerId = 'hub-validator';
      const hubPrivateKeyBytes = deriveSignerKeySync(hubSeed, hubSignerId);
      const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
      const hubWallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);

      const tokenAddress = globalJAdapter.mode === 'rpc'
        ? ANVIL_TOKENS[tokenSymbol]
        : (globalJAdapter as any).getBrowserVM?.()?.getTokenRegistry()?.find((t: any) => t.symbol === tokenSymbol)?.address;

      if (!tokenAddress) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Token ${tokenSymbol} not found` }), { status: 404, headers });
      }

      // Transfer ERC20 from hub to user (with explicit nonce for safety)
      const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
      const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, hubWallet);
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

    // Deploy contracts only if fromReplica not provided AND anvil is fresh
    if (!fromReplica && block === 0) {
      console.log('[XLN] Deploying contracts to anvil...');
      await globalJAdapter.deployStack();
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
        await setupJEventWatcher(env, anvilRpc, entityProviderAddress, depositoryAddress);
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
    const hubEntityId = hubs[0].entityId;
    const hubSignerId = hubs[0].runtimeId || 'hub-validator';

    console.log('[XLN] Funding hub reserves...');

    // Fund hub wallet address with ETH (for gas) and ERC20 tokens
    const hubSeed = 'xln-main-hub-2026'; // TODO: Get from env or config
    const hubPrivateKeyBytes = deriveSignerKeySync(hubSeed, hubSignerId);
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
    } else {
      // Anvil: Fund hub wallet with ERC20 tokens from deployer
      try {
        const anvilDefaultPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
        const deployer = new ethers.Wallet(anvilDefaultPrivateKey, globalJAdapter.provider);

        const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

        // Fund hub wallet with 1B of each token
        for (const [symbol, tokenAddress] of Object.entries(ANVIL_TOKENS)) {
          const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, deployer);
          const deployerBalance = await erc20.balanceOf(deployer.address);
          if (deployerBalance > 0n) {
            const amountToTransfer = 1_000_000_000n * 10n ** 18n; // 1B tokens
            const actual = deployerBalance < amountToTransfer ? deployerBalance : amountToTransfer;
            const tx = await erc20.transfer(hubWalletAddress, actual);
            await tx.wait();
            console.log(`[XLN] Hub wallet funded with ${symbol}: ${ethers.formatUnits(actual, 18)}`);
          }
        }

        // Also fund hub wallet with ETH for gas
        const ethAmount = ethers.parseEther('10');
        const ethTx = await deployer.sendTransaction({ to: hubWalletAddress, value: ethAmount });
        await ethTx.wait();
        console.log('[XLN] Hub wallet funded with 10 ETH for gas');
      } catch (err) {
        console.warn('[XLN] Hub wallet funding failed (anvil):', (err as Error).message);
      }
    }

    // Fund hub entity reserves in Depository (all registered tokens)
    const reserveTokens = await globalJAdapter.getTokenRegistry?.().catch(() => []) ?? [];
    const fallbackTokenIds = [1, 2, 3];
    const tokensToFund = reserveTokens.length > 0
      ? reserveTokens.filter(t => typeof t.tokenId === 'number')
      : fallbackTokenIds.map(tokenId => ({ tokenId, decimals: 18 }));

    for (const token of tokensToFund) {
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
