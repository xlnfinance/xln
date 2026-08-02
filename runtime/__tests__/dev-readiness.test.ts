import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { probeDevReady } from '../../scripts/dev/wait-dev-ready';

const repoRoot = resolve(import.meta.dir, '../..');

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
  const web = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => new URL(request.url).pathname === '/runtime.js'
      ? new Response('export const ready = true;', { headers: { 'content-type': 'text/javascript' } })
      : new Response('<main>ready</main>', { headers: { 'content-type': 'text/html' } }),
  });
  const watchtower = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });

  try {
    const input = {
      apiUrl: `http://127.0.0.1:${api.port}`,
      webUrl: `http://127.0.0.1:${web.port}`,
      watchtowerUrl: `http://127.0.0.1:${watchtower.port}`,
      runtimeBundle,
      startedAtMs,
    };
    expect(await probeDevReady(input)).toEqual({ ready: true });

    const child = spawn('bun', [
      'scripts/dev/wait-dev-ready.ts',
      '--api-url', input.apiUrl,
      '--web-url', input.webUrl,
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
      watchtowerUrl: 'http://127.0.0.1:1',
      runtimeBundle: '/missing/runtime.js',
      startedAtMs: Date.now(),
    })).toEqual({ ready: false, reason: 'market-maker-not-ready' });
  } finally {
    api.stop(true);
  }
});
