import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';

import {
  createDevelopmentGatewayTargets,
  parseDevelopmentGatewayPort,
  resolveDevelopmentGatewayRequest,
  rewriteDevelopmentGatewayUrl,
  type GatewayProxyOwner,
} from '../../../frontend/config/development-gateway';
import { getReactAppBase } from '../../../frontend/config/create-react-app-config';
import { createDevelopmentGateway } from '../../../frontend/scripts/dev-gateway';
import { createDevelopmentProcessSpecs } from '../../../frontend/scripts/dev';

const servers: Server[] = [];
const websocketServers: Array<ReturnType<typeof Bun.serve>> = [];
const gatewayProcesses: Array<ReturnType<typeof Bun.spawn>> = [];
let nextTestPort = 26_000 + (process.pid % 10_000);

const listenOn = async (server: Server, port: number): Promise<void> => new Promise((resolve, reject) => {
  const onError = (error: Error): void => reject(error);
  server.once('error', onError);
  server.listen(port, '127.0.0.1', () => {
    server.removeListener('error', onError);
    resolve();
  });
});

const listen = async (server: Server): Promise<number> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = nextTestPort;
    nextTestPort += 1;
    try {
      await listenOn(server, port);
      servers.push(server);
      return port;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('TEST_SERVER_PORTS_EXHAUSTED');
};

const close = async (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close((error?: Error) => error === undefined ? resolve() : reject(error));
});

const createTarget = async (owner: GatewayProxyOwner): Promise<string> => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${owner}:${request.url ?? '/'}`);
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
};

const createTargets = async (): Promise<Readonly<Record<GatewayProxyOwner, string>>> => ({
  edge: await createTarget('edge'),
  site: await createTarget('site'),
  docs: await createTarget('docs'),
  wallet: await createTarget('wallet'),
  ops: await createTarget('ops'),
});

const createWebSocketTarget = (onUpgrade: () => void): string => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = nextTestPort;
    nextTestPort += 1;
    try {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch(request, bunServer) {
          onUpgrade();
          if (bunServer.upgrade(request)) return undefined;
          return new Response('TEST_WEBSOCKET_UPGRADE_FAILED', { status: 400 });
        },
        websocket: {
          message() {},
        },
      });
      websocketServers.push(server);
      return `http://127.0.0.1:${port}`;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('TEST_WEBSOCKET_PORTS_EXHAUSTED');
};

const waitForGateway = async (process: ReturnType<typeof Bun.spawn>): Promise<void> => {
  if (!(process.stdout instanceof ReadableStream)) throw new Error('TEST_GATEWAY_STDOUT_MISSING');
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const timeout = setTimeout(() => reader.cancel('TEST_GATEWAY_READY_TIMEOUT'), 5_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`TEST_GATEWAY_EXITED_BEFORE_READY:${output}`);
      output += decoder.decode(chunk.value, { stream: true });
      if (output.includes('FRONTEND_GATEWAY_READY')) return;
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
};

afterEach(async () => {
  for (const process of gatewayProcesses.splice(0).reverse()) {
    process.kill('SIGTERM');
    await process.exited;
  }
  for (const server of websocketServers.splice(0).reverse()) await server.stop(true);
  for (const server of servers.splice(0).reverse()) await close(server);
});

describe('React development gateway', () => {
  test('keeps edge behavior ahead of application fallbacks', () => {
    expect(resolveDevelopmentGatewayRequest('/admin')).toEqual({
      kind: 'redirect', status: 308, location: '/health',
    });
    expect(resolveDevelopmentGatewayRequest('/radapter')).toEqual({
      kind: 'redirect', status: 307, location: '/app',
    });
    expect(resolveDevelopmentGatewayRequest('/radapter?ws=forbidden')).toMatchObject({
      kind: 'response', status: 400, body: 'REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN',
    });
    expect(resolveDevelopmentGatewayRequest('/runtime.js')).toEqual({
      kind: 'proxy', owner: 'edge', rewrite: 'none',
    });
    expect(resolveDevelopmentGatewayRequest('/favicon.ico')).toEqual({
      kind: 'proxy', owner: 'edge', rewrite: 'none',
    });
    expect(resolveDevelopmentGatewayRequest('/unknown')).toEqual({
      kind: 'proxy', owner: 'edge', rewrite: 'none',
    });
  });

  test('routes application pages, fixed assets, internal modules, and HMR to one owner', () => {
    const docs = resolveDevelopmentGatewayRequest('/docs?view=reader');
    expect(docs).toEqual({ kind: 'proxy', owner: 'docs', rewrite: 'app-base' });
    if (docs.kind !== 'proxy') throw new Error('TEST_DOCS_PROXY_REQUIRED');
    expect(rewriteDevelopmentGatewayUrl('/docs?view=reader', docs)).toBe('/__app/docs/docs?view=reader');
    expect(resolveDevelopmentGatewayRequest('/llms-runtime.txt')).toMatchObject({ owner: 'docs' });
    expect(resolveDevelopmentGatewayRequest('/contracts/Account.json')).toMatchObject({ owner: 'wallet' });
    expect(resolveDevelopmentGatewayRequest('/__app/wallet/src/main.tsx')).toEqual({
      kind: 'proxy', owner: 'wallet', rewrite: 'none',
    });
    expect(resolveDevelopmentGatewayRequest('/__hmr/ops')).toEqual({
      kind: 'proxy', owner: 'ops', rewrite: 'none',
    });
    expect(getReactAppBase('site', true)).toBe('/__app/site/');
    expect(getReactAppBase('site', false)).toBe('/');
    expect(parseDevelopmentGatewayPort('18080')).toBe(18080);
    expect(() => parseDevelopmentGatewayPort('0')).toThrow('DEVELOPMENT_GATEWAY_PORT_INVALID:0');
  });

  test('streams HTTP requests to the selected upstream and preserves local responses', async () => {
    const targets = await createTargets();
    const gateway = createDevelopmentGateway({ targets });
    const port = await listen(gateway);
    const origin = `http://127.0.0.1:${port}`;

    const docs = await fetch(`${origin}/docs?view=reader`);
    expect(await docs.text()).toBe('docs:/__app/docs/docs?view=reader');
    const api = await fetch(`${origin}/api/health`);
    expect(await api.text()).toBe('edge:/api/health');
    const favicon = await fetch(`${origin}/favicon.ico`);
    expect(await favicon.text()).toBe('edge:/favicon.ico');
    const reset = await fetch(`${origin}/resetdb`, { redirect: 'manual' });
    expect(reset.status).toBe(200);
    expect(reset.headers.get('clear-site-data')).toBe('"*"');
    expect(await reset.text()).toBe('Resetting local data');
    const admin = await fetch(`${origin}/admin`, { redirect: 'manual' });
    expect(admin.status).toBe(308);
    expect(admin.headers.get('location')).toBe('/health');
  });

  test('forwards per-application HMR WebSocket upgrades', async () => {
    let upstreamReached = false;
    const targets = {
      ...await createTargets(),
      docs: createWebSocketTarget(() => { upstreamReached = true; }),
    };

    const port = nextTestPort;
    nextTestPort += 1;
    const gateway = Bun.spawn(['bun', 'scripts/run-dev-gateway.ts'], {
      cwd: 'frontend',
      env: {
        ...process.env,
        XLN_REACT_GATEWAY_PORT: String(port),
        XLN_REACT_EDGE_TARGET: targets.edge,
        XLN_REACT_SITE_TARGET: targets.site,
        XLN_REACT_DOCS_TARGET: targets.docs,
        XLN_REACT_WALLET_TARGET: targets.wallet,
        XLN_REACT_OPS_TARGET: targets.ops,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    gatewayProcesses.push(gateway);
    await waitForGateway(gateway);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      let received = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`TEST_WEBSOCKET_TIMEOUT:upstream=${upstreamReached}`));
      }, 1_000);
      socket.once('error', reject);
      socket.once('connect', () => socket.write(
        'GET /__hmr/docs HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: eGxuLWdhdGV3YXktdGVzdA==\r\n\r\n',
      ));
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n')) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(received);
        }
      });
    });

    expect(response).toContain('101 Switching Protocols');
    expect(upstreamReached).toBe(true);
  });

  test('launches four gateway-aware Vite roots plus one public gateway', () => {
    const specs = createDevelopmentProcessSpecs();
    expect(specs).toHaveLength(5);
    expect(specs.filter(({ gatewayAware }) => gatewayAware)).toHaveLength(4);
    expect(specs.at(-1)).toEqual({
      label: 'same-origin-gateway',
      argv: ['bun', 'scripts/run-dev-gateway.ts'],
      gatewayAware: false,
    });
    expect(createDevelopmentGatewayTargets().edge).toBe('http://127.0.0.1:8082');
  });
});
