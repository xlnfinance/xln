import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { probeDevReady } from '../../scripts/dev/wait-dev-ready';
import { verifyHelloAuth } from '../network/p2p/hello-auth';
import { deserializeWsMessage, serializeWsMessage } from '../network/p2p/ws-protocol';
import { areHubChildrenReady } from '../orchestrator/hub-mesh-readiness';
import { relayAudienceFromWebUrl, resolveConfiguredRelayAudience } from '../orchestrator/relay-audience';

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
  const serveWebRelay = () => {
    const server = Bun.serve<{ challenge: string; audience: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/relay') {
        const audience = `ws://127.0.0.1:${server.port}/relay`;
        return server.upgrade(request, { data: { challenge: 'dev-ready-test', audience } })
          ? undefined
          : new Response('upgrade failed', { status: 400 });
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
    return server;
  };
  const web = serveWebRelay();
  const relayAlias = serveWebRelay();
  const watchtower = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });

  try {
    const input = {
      apiUrl: `http://127.0.0.1:${api.port}`,
      webUrl: `http://127.0.0.1:${web.port}`,
      relayWebUrls: [
        `http://127.0.0.1:${web.port}`,
        `http://127.0.0.1:${relayAlias.port}`,
      ],
      watchtowerUrl: `http://127.0.0.1:${watchtower.port}`,
      runtimeBundle,
      startedAtMs,
    };
    expect(await probeDevReady(input)).toEqual({ ready: true });

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
    web.stop(true);
    relayAlias.stop(true);
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
    })).toEqual({ ready: false, reason: 'market-maker-not-ready' });
  } finally {
    api.stop(true);
  }
});
