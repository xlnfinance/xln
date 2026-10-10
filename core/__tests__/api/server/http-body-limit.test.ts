import { describe, expect, test } from 'bun:test';
import { API_BODY_MAX_BYTES, WATCHTOWER_PROXY_BODY_MAX_BYTES, enforceApiBodyLimit } from '../../../api/server/http-body-limit';

describe('API recovery transport limits', () => {
  test('real HTTP accepts a 2 MiB recovery request while ordinary commands retain 1 MiB', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0, maxRequestBodySize: WATCHTOWER_PROXY_BODY_MAX_BYTES,
      async fetch(request) {
        const rejected = await enforceApiBodyLimit(request);
        return rejected ?? Response.json({ bytes: (await request.arrayBuffer()).byteLength });
      },
    });
    try {
      const body = 'x'.repeat(2 * API_BODY_MAX_BYTES);
      const allowed = await fetch(new URL('/api/watchtower-proxy', server.url), { method: 'PUT', body });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ bytes: body.length });
      const blocked = await fetch(new URL('/api/control', server.url), { method: 'POST', body });
      expect(blocked.status).toBe(413);
      expect(await blocked.json()).toMatchObject({ error: 'API_BODY_TOO_LARGE', maxBytes: API_BODY_MAX_BYTES });
    } finally { server.stop(true); }
  });
  test('streamed command body cannot bypass the cap by omitting Content-Length', async () => {
    const request = new Request('http://localhost/api/control', {
      method: 'POST', body: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(API_BODY_MAX_BYTES + 1)); controller.close();
      } }),
    });
    expect((await enforceApiBodyLimit(request))?.status).toBe(413);
  });
  test('small bodies preserve their original content and Request identity', async () => {
    const request = new Request('http://localhost/api/control', { method: 'POST', body: '{"amount":"100"}' });
    expect(await enforceApiBodyLimit(request)).toBeNull();
    expect(await request.json()).toEqual({ amount: '100' });
  });
});

test('a malformed server timeout env fails startup instead of becoming NaN', () => {
  // TOKEN_CATALOG_TIMEOUT_MS / XLN_STARTUP_STEP_TIMEOUT_MS used Number(raw):
  // a typo became NaN and every startup step timed out immediately.
  const child = Bun.spawnSync({
    cmd: [process.execPath, '-e', `await import('${import.meta.dir}/../../../api/server/catalog/tokens.ts')`],
    env: { ...process.env, TOKEN_CATALOG_TIMEOUT_MS: '6s' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode).not.toBe(0);
  expect(child.stderr.toString()).toContain('ENV_POSITIVE_INTEGER_INVALID:TOKEN_CATALOG_TIMEOUT_MS:6s');
});
