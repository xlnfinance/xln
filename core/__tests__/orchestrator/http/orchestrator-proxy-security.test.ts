import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet, getIndexedAccountPath, parseEther } from 'ethers';
import { createOrchestratorProxyHandlers } from '../../../orchestrator/proxy';
import { safeStringify } from '../../../protocol/serialization';

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('PORT'))));
  });
});

/** One real node behind the public bridge, so signature, nonce and chain stay its checks. */
const withAnvil = async (run: (rpcUrl: string) => Promise<void>): Promise<void> => {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(join(tmpdir(), 'xln-rpc-bridge-'));
  const child = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337'], {
    stdout: 'ignore', stderr: 'ignore', env: { ...process.env, TMPDIR: root },
  });
  try {
    const provider = new JsonRpcProvider(rpcUrl, 31_337, { staticNetwork: true });
    for (let attempt = 0; ; attempt += 1) {
      try { await provider.getBlockNumber(); break; } catch (error) {
        if (attempt > 100) throw error;
        await Bun.sleep(100);
      }
    }
    provider.destroy();
    await run(rpcUrl);
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
};

const rpcPost = (body: unknown): Request => new Request('https://xln.finance/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: safeStringify(body),
});

describe('orchestrator proxy security', () => {
  test('marks every generic public child request as proxied', async () => {
    let forwarded = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      forwarded = new Headers(init?.headers).get('forwarded') || '';
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: () => ({ apiPort: 19001 }) as any,
      });
      const response = await handlers.proxyAnyHubRequest(
        new Request('http://xln.local/api/future-public-route'),
        '/api/future-public-route',
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json;charset=utf-8');
      expect(forwarded).toBe('for=_xln_public_proxy');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('public hub proxies reject oversized bodies before upstream allocation', async () => {
    let upstreamCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => ({ apiPort: 19001 }) as any,
        getHealthyHub: () => ({ apiPort: 19001 }) as any,
      });
      const oversized = (path: string) => new Request(`http://xln.local${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(1024 * 1024 + 1),
        },
        body: '{}',
      });

      const explicit = await handlers.proxyHubApi(
        oversized('/api/faucet/offchain'),
        '/api/faucet/offchain',
      );
      const generic = await handlers.proxyAnyHubRequest(
        oversized('/api/faucet/gas'),
        '/api/faucet/gas',
      );

      expect(explicit.status).toBe(413);
      expect(generic.status).toBe(413);
      expect(await explicit.text()).toContain('HUB_FAUCET_PROXY_BODY_TOO_LARGE');
      expect(await generic.text()).toContain('HUB_API_PROXY_BODY_TOO_LARGE');
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('public rpc failures never expose credential-bearing upstream URLs', async () => {
    const apiKey = 'sentinel-rpc-api-key';
    const upstream = `https://rpc.invalid/${apiKey}?token=${apiKey}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error(`fetch failed for ${upstream}`);
    }) as typeof fetch;
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: upstream,
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: () => null,
      });
      const response = await handlers.proxyRpc(new Request('http://127.0.0.1/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
      }));
      const text = await response.text();

      expect(response.status).toBe(502);
      expect(text).toContain('RPC upstream request failed');
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain('rpc.invalid');
      expect(text).not.toContain('"upstream"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('all chain faucets allow confirmation without weakening the generic hub timeout', async () => {
    const requestedEngines: Array<string | undefined> = [];
    const previousHubTimeout = process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'];
    const previousFaucetTimeout = process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'];
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(60);
        return Response.json({ success: true });
      },
    });
    process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'] = '25';
    process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'] = '100';
    try {
      const handlers = createOrchestratorProxyHandlers({
        host: '127.0.0.1',
        defaultRpcUrl: '',
        pollAllHubHealth: async () => {},
        getHubChildByEntityId: () => null,
        getHealthyHub: requiredEngine => {
          requestedEngines.push(requiredEngine);
          return { apiPort: server.port } as any;
        },
      });
      const request = (endpoint: string) => new Request(`http://xln.local${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      const genericResponse = await handlers.proxyAnyHubRequest(request('/api/health/slow'), '/api/health/slow');
      expect(genericResponse.status).toBe(502);
      expect(((await genericResponse.json()) as { error?: string }).error).toContain('PROXY_UPSTREAM_TIMEOUT:25');

      for (const kind of ['erc20', 'gas', 'reserve']) {
        const endpoint = `/api/faucet/${kind}?chainId=31337`;
        const faucetResponse = await handlers.proxyAnyHubRequest(request(endpoint), endpoint);
        expect(faucetResponse.status).toBe(200);
        expect(faucetResponse.headers.get('content-type')).toBe('application/json;charset=utf-8');
        expect(await faucetResponse.json()).toEqual({ success: true });
      }
      expect(requestedEngines).toEqual([undefined, 'typescript', 'typescript', 'typescript']);
    } finally {
      if (previousHubTimeout === undefined) delete process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'];
      else process.env['XLN_HUB_API_PROXY_TIMEOUT_MS'] = previousHubTimeout;
      if (previousFaucetTimeout === undefined) delete process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'];
      else process.env['XLN_HUB_FAUCET_PROXY_TIMEOUT_MS'] = previousFaucetTimeout;
      await server.stop(true);
    }
  }, 2_000);

  test('generic hub API exposes typed no-healthy-hub failure', async () => {
    let pollCalls = 0;
    const handlers = createOrchestratorProxyHandlers({
      host: '127.0.0.1',
      defaultRpcUrl: '',
      pollAllHubHealth: async () => {
        pollCalls += 1;
      },
      getHubChildByEntityId: () => null,
      getHealthyHub: () => null,
    });

    const response = await handlers.proxyAnyHubRequest(
      new Request('http://xln.local/api/faucet/gas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityId: `0x${'34'.repeat(32)}` }),
      }),
      '/api/faucet/gas',
    );
    const body = (await response.json()) as {
      category?: string;
      code?: string;
      error?: string;
      failure?: { category?: string; code?: string; retryable?: boolean; fatal?: boolean };
      retryable?: boolean;
      fatal?: boolean;
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe('No healthy hub API available');
    expect(body.code).toBe('NO_HEALTHY_HUB_API_AVAILABLE');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'TransientRace',
      code: 'NO_HEALTHY_HUB_API_AVAILABLE',
      retryable: true,
      fatal: false,
    });
    expect(pollCalls).toBe(1);
  });

  test('public rpc relays a wallet-signed transaction to the node and refuses public dev keys', async () => {
    const previousNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await withAnvil(async (rpcUrl) => {
        const handlers = createOrchestratorProxyHandlers({
          host: '127.0.0.1',
          defaultRpcUrl: rpcUrl,
          pollAllHubHealth: async () => {},
          getHubChildByEntityId: () => null,
          getHealthyHub: () => null,
        });
        const node = new JsonRpcProvider(rpcUrl, 31_337, { staticNetwork: true });
        const wallet = Wallet.createRandom();
        // Funding is node setup outside the bridge; the bridge itself never exposes anvil_*.
        await node.send('anvil_setBalance', [wallet.address, '0xde0b6b3a7640000']);
        const transfer = {
          type: 2, chainId: 31_337n, to: '0x000000000000000000000000000000000000dEaD', value: 7n,
          gasLimit: 21_000n, maxFeePerGas: parseEther('0.00000002'), maxPriorityFeePerGas: 1n,
        };
        const raw = await wallet.signTransaction({ ...transfer, nonce: 0 });
        const relayed = await handlers.proxyRpc(rpcPost({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }));
        const relayedBody = await relayed.json() as { result?: string };
        expect(relayed.status).toBe(200);
        expect(relayedBody.result).toMatch(/^0x[0-9a-f]{64}$/);
        const receipt = await node.waitForTransaction(relayedBody.result!, 1, 10_000);
        expect(receipt?.status).toBe(1);
        expect(receipt?.from).toBe(wallet.address);

        // The node keeps its own replay and chain checks.
        const replay = await handlers.proxyRpc(rpcPost({ jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: [raw] }));
        expect(((await replay.json()) as { error?: unknown }).error).toBeDefined();
        const otherChain = await wallet.signTransaction({ ...transfer, chainId: 1n, nonce: 1 });
        const wrongChain = await handlers.proxyRpc(rpcPost({ jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [otherChain] }));
        expect(((await wrongChain.json()) as { error?: unknown }).error).toBeDefined();

        const devKey = HDNodeWallet.fromMnemonic(
          Mnemonic.fromPhrase('test test test test test test test test test test test junk'),
          getIndexedAccountPath(0),
        );
        const before = await node.getBalance(devKey.address);
        const sweep = await devKey.signTransaction({ ...transfer, value: parseEther('1'), nonce: await node.getTransactionCount(devKey.address) });
        const refused = await handlers.proxyRpc(rpcPost({ jsonrpc: '2.0', id: 4, method: 'eth_sendRawTransaction', params: [sweep] }));
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
          error: 'RPC proxy method is not allowed',
          method: 'eth_sendRawTransaction:RAW_TX_PUBLIC_DEV_KEY',
        });
        expect(await node.getBalance(devKey.address)).toBe(before);

        for (const method of ['eth_sendTransaction', 'personal_sign', 'anvil_setBalance', 'debug_traceTransaction']) {
          const response = await handlers.proxyRpc(rpcPost({ jsonrpc: '2.0', id: 5, method, params: [] }));
          expect(response.status).toBe(403);
        }
        node.destroy();
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
    }
  }, 30_000);
});
