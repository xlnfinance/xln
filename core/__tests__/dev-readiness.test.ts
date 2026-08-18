import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { probeDevReady, waitForDevReady } from '../../scripts/dev/wait-dev-ready';
import {
  initialDevStartupProgressState,
  reduceDevStartupProgress,
} from '../../scripts/dev/startup-events';
import { verifyHelloAuth } from '../network/p2p/auth/hello-auth';
import { deserializeWsMessage, serializeWsMessage } from '../network/p2p/ws-protocol';
import { areHubChildrenReady } from '../orchestrator/hub/hub-mesh-readiness';
import { relayAudienceFromWebUrl, resolveConfiguredRelayAudience } from '../orchestrator/mesh/relay-audience';

const repoRoot = resolve(import.meta.dir, '../..');

test('dev wallet uses one shared web-origin list for relay authorization and readiness', () => {
  const dev = readFileSync(join(repoRoot, 'scripts/dev/run-dev.sh'), 'utf8');
  const devChild = readFileSync(join(repoRoot, 'scripts/dev/run-dev-child.sh'), 'utf8');
  const httpVite = readFileSync(join(repoRoot, 'frontend/vite.config.http.ts'), 'utf8');
  const relayProxy = httpVite.slice(
    httpVite.indexOf("'/relay':"),
    httpVite.indexOf('},', httpVite.indexOf("'/relay':")) + 2,
  );

  expect(devChild).toContain('--relay-url "ws://127.0.0.1:${API_PORT}/relay"');
  expect(dev).toContain('DEV_RELAY_WEB_URLS="${DEV_WEB_SCHEME}://localhost:${WEB_PORT},http://localhost:${WEB_HTTP_PORT}"');
  expect(devChild).toContain('--relay-web-urls "$DEV_RELAY_WEB_URLS"');
  expect(devChild).toContain('--web-url "http://localhost:${WEB_HTTP_PORT}"');
  expect(devChild).toContain('XLN_PUBLIC_FAUCET="${XLN_PUBLIC_FAUCET:-1}"');
  expect(devChild.match(/--relay-web-urls "\$DEV_RELAY_WEB_URLS"/g)).toHaveLength(2);
  expect(relayProxy).toContain('changeOrigin: false');
  expect(relayProxy).not.toContain('changeOrigin: true');
});

test('relay proxy selects only exact configured HTTP and HTTPS browser audiences', () => {
  const audiences = new Set([
    'ws://127.0.0.1:8082/relay',
    relayAudienceFromWebUrl('http://localhost:8081'),
    relayAudienceFromWebUrl('https://localhost:8080'),
  ]);
  expect(resolveConfiguredRelayAudience({
    requestUrl: 'ws://127.0.0.1:8082/relay',
    origin: 'http://localhost:8081',
    configuredAudiences: audiences,
  })).toBe('ws://localhost:8081/relay');
  expect(resolveConfiguredRelayAudience({
    requestUrl: 'ws://127.0.0.1:8082/relay',
    origin: 'https://localhost:8080',
    configuredAudiences: audiences,
  })).toBe('wss://localhost:8080/relay');
  expect(resolveConfiguredRelayAudience({
    requestUrl: 'ws://127.0.0.1:8082/relay',
    origin: 'https://attacker.invalid',
    configuredAudiences: audiences,
  })).toBeNull();
  expect(resolveConfiguredRelayAudience({
    requestUrl: 'ws://127.0.0.1:8082/relay',
    origin: null,
    configuredAudiences: audiences,
  })).toBe('ws://127.0.0.1:8082/relay');
});

test('mesh readiness requires bilateral mesh and signed gossip profiles', () => {
  const child = (mesh: boolean, gossip: boolean) => ({
    lastHealth: { mesh: { ready: mesh }, gossip: { ready: gossip } },
  });
  expect(areHubChildrenReady([child(true, true)])).toBe(true);
  expect(areHubChildrenReady([child(true, false)])).toBe(false);
  expect(areHubChildrenReady([child(false, true)])).toBe(false);
});

test('dev readiness uses canonical runtime-import readiness and every browser sidecar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-dev-ready-'));
  const runtimeBundle = join(root, 'runtime.js');
  const startedAtMs = Date.now() - 1_000;
  writeFileSync(runtimeBundle, 'export const ready = true;\n', 'utf8');

  const api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => new URL(request.url).pathname === '/api/runtime-import'
      ? Response.json({ ok: true, ready: true })
      : new Response('not found', { status: 404 }),
  });
  let publicFaucetEnabled = true;
  const serveWebRelay = (secure = false) => {
    const server = Bun.serve<{ challenge: string; audience: string }>({
    hostname: '127.0.0.1',
    port: 0,
    ...(secure ? {
      tls: {
        cert: Bun.file(join(repoRoot, 'frontend/localhost+3.pem')),
        key: Bun.file(join(repoRoot, 'frontend/localhost+3-key.pem')),
      },
    } : {}),
    async fetch(request, server) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/relay') {
        const audience = `${secure ? 'wss' : 'ws'}://127.0.0.1:${server.port}/relay`;
        return server.upgrade(request, { data: { challenge: 'dev-ready-test', audience } })
          ? undefined
          : new Response('upgrade failed', { status: 400 });
      }
      if (pathname === '/api/hubs') {
        return Response.json({
          ok: true,
          hubs: [{ entityId: `0x${'11'.repeat(32)}` }],
        });
      }
      if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
        if (!publicFaucetEnabled) {
          return Response.json({ code: 'PUBLIC_FAUCET_DISABLED', error: 'Not found' }, { status: 404 });
        }
        const body = await request.json() as Record<string, unknown>;
        return Response.json({
          success: false,
          code: body['userEntityId'] === 'dev-ready-invalid-entity'
            ? 'FAUCET_INVALID_USER_ENTITY_ID'
            : 'TEST_EXPECTED_INVALID_ENTITY',
        }, { status: 400 });
      }
      return pathname === '/runtime.js'
        ? new Response('export const ready = true;', { headers: { 'content-type': 'text/javascript' } })
        : new Response('<main>ready</main>', { headers: { 'content-type': 'text/html' } });
    },
    websocket: {
      open(socket) {
        socket.send(serializeWsMessage({
          type: 'hello_challenge',
          challenge: socket.data.challenge,
          audience: socket.data.audience,
        }));
      },
      message(socket, raw) {
        const hello = deserializeWsMessage(raw);
        const authError = verifyHelloAuth(
          hello.from!,
          hello.fromEncryptionPubKey!,
          hello.auth,
          10_000,
          socket.data.audience,
        );
        if (authError) throw new Error(authError);
        socket.send(serializeWsMessage({ type: 'hello_ack', to: hello.from! }));
      },
    },
    });
    return {
      server,
      webUrl: `${secure ? 'https' : 'http'}://127.0.0.1:${server.port}`,
    };
  };
  const web = serveWebRelay(true);
  const relayAlias = serveWebRelay();
  const watchtower = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });

  try {
    const input = {
      apiUrl: `http://127.0.0.1:${api.port}`,
      webUrl: web.webUrl,
      relayWebUrls: [
        web.webUrl,
        relayAlias.webUrl,
      ],
      watchtowerUrl: `http://127.0.0.1:${watchtower.port}`,
      runtimeBundle,
      startedAtMs,
    };
    expect(await probeDevReady(input)).toEqual({ ready: true });
    publicFaucetEnabled = false;
    expect(await probeDevReady(input)).toEqual({
      ready: false,
      reason: `${input.relayWebUrls[0]}:wallet-faucet-pipe-404:PUBLIC_FAUCET_DISABLED`,
      fatal: false,
    });
    publicFaucetEnabled = true;

    const child = spawn('bun', [
      'scripts/dev/wait-dev-ready.ts',
      '--api-url', input.apiUrl,
      '--web-url', input.webUrl,
      '--relay-web-urls', input.relayWebUrls.join(','),
      '--watchtower-url', input.watchtowerUrl,
      '--runtime-bundle', runtimeBundle,
      '--started-at-ms', String(startedAtMs),
      '--timeout-ms', '2000',
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const deadline = Date.now() + 1_500;
    while (!stdout.includes('DEV_READY') && child.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(stdout, stderr).toContain('DEV_READY');
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    const exitCode = await new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
    expect(exitCode).toBe(0);
  } finally {
    api.stop(true);
    web.server.stop(true);
    relayAlias.server.stop(true);
    watchtower.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('dev readiness rejects a partial runtime-import response before claiming ready', async () => {
  const api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ ok: false, ready: false, reason: 'market-maker-not-ready' }),
  });
  try {
    expect(await probeDevReady({
      apiUrl: `http://127.0.0.1:${api.port}`,
      webUrl: 'http://127.0.0.1:1',
      relayWebUrls: ['http://127.0.0.1:1'],
      watchtowerUrl: 'http://127.0.0.1:1',
      runtimeBundle: '/missing/runtime.js',
      startedAtMs: Date.now(),
    })).toEqual({ ready: false, reason: 'market-maker-not-ready', fatal: false });
  } finally {
    api.stop(true);
  }
});

test('dev readiness stops immediately on fatal import state and preserves retry budget', async () => {
  const input = {
    apiUrl: 'http://127.0.0.1:1',
    webUrl: 'http://127.0.0.1:1',
    relayWebUrls: ['http://127.0.0.1:1'],
    watchtowerUrl: 'http://127.0.0.1:1',
    runtimeBundle: '/missing/runtime.js',
    startedAtMs: 100,
  };
  let now = 1_000;
  let fatalProbes = 0;
  const fatal = await waitForDevReady(input, 240_000, {
    now: () => now,
    sleep: async ms => { now += ms; },
    probe: async () => {
      fatalProbes += 1;
      return { ready: false, reason: 'fatal:child-exited', fatal: true };
    },
  });
  expect(fatal).toEqual({
    ready: false,
    reason: 'fatal:child-exited',
    fatal: true,
    totalElapsedMs: 900,
    probeElapsedMs: 0,
  });
  expect(fatalProbes).toBe(1);

  now = 1_000;
  let retryableProbes = 0;
  const retryable = await waitForDevReady(input, 2_500, {
    now: () => now,
    sleep: async ms => { now += ms; },
    probe: async () => {
      retryableProbes += 1;
      return { ready: false, reason: 'market-maker-not-ready', fatal: false };
    },
  });
  expect(retryable).toEqual({
    ready: false,
    reason: 'market-maker-not-ready',
    fatal: false,
    totalElapsedMs: 3_400,
    probeElapsedMs: 2_500,
  });
  expect(retryableProbes).toBe(3);
});

test('dev startup progress logs phase changes and one heartbeat per interval', () => {
  let state = initialDevStartupProgressState();
  const emit = (reason: string, probeElapsedMs: number): string | null => {
    const reduced = reduceDevStartupProgress(state, {
      reason,
      totalElapsedMs: probeElapsedMs + 5_000,
      probeElapsedMs,
    });
    state = reduced.state;
    return reduced.line;
  };

  expect(emit('hub-mesh-not-ready', 0)).toBe(
    'DEV_PHASE phase=mesh totalElapsedMs=5000 probeElapsedMs=0 reason=hub-mesh-not-ready',
  );
  expect(emit('hub-mesh-not-ready', 9_999)).toBeNull();
  expect(emit('hub-mesh-not-ready', 10_000)).toBe(
    'DEV_HEARTBEAT phase=mesh totalElapsedMs=15000 probeElapsedMs=10000 reason=hub-mesh-not-ready',
  );
  expect(emit('market-maker-not-ready', 10_001)).toBe(
    'DEV_PHASE phase=market-maker totalElapsedMs=15001 probeElapsedMs=10001 reason=market-maker-not-ready',
  );
  expect(emit('bootstrap-reserves-not-ready', 10_002)).toBe(
    'DEV_PHASE phase=reserves totalElapsedMs=15002 probeElapsedMs=10002 reason=bootstrap-reserves-not-ready',
  );
  expect(emit('reset-in-progress', 10_003)).toBe(
    'DEV_PHASE phase=reset totalElapsedMs=15003 probeElapsedMs=10003 reason=reset-in-progress',
  );
  expect(emit('wallet-relay-websocket-error', 10_004)).toBe(
    'DEV_PHASE phase=relay totalElapsedMs=15004 probeElapsedMs=10004 reason=wallet-relay-websocket-error',
  );
});
