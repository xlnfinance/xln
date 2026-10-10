import { afterEach, expect, test } from 'bun:test';

import { discoverRuntimeRecoveryCandidates } from '../../../../storage/recovery/discovery';
import { safeStringify } from '../../../../protocol/serialization';

const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const serveTower = (restoreBody: unknown): string => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/recovery/discover') return new Response(safeStringify({ ok: true, available: true }));
      if (path === '/api/tower/restore') return new Response(safeStringify(restoreBody));
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
};

test('a tower serving another identity\'s bundle is a contradiction even when it echoes transport words', async () => {
  // Classification read substrings of the whole message, and the mismatch
  // message echoes the tower-supplied runtimeId: "network" made a hostile
  // tower look like a retryable outage instead of contradicting evidence.
  const url = serveTower({
    ok: true,
    bundle: {
      version: 1, runtimeId: 'network timeout', lookupKey: `0x${'00'.repeat(32)}`,
      bundleHash: `0x${'00'.repeat(32)}`, iv: '0x00', ciphertext: '0x00',
    },
  });
  const result = await discoverRuntimeRecoveryCandidates(seed, { towers: [{ url }] });
  expect(result.candidates).toEqual([]);
  expect(result.failures.map(({ category, code }) => ({ category, code }))).toEqual([
    { category: 'Contradiction', code: 'RECOVERY_BUNDLE_TRUSTED_RUNTIME_ID_MISMATCH' },
  ]);
});

test('an unreachable tower is coded where fetch fails and stays a retryable outage', async () => {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const url = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  const result = await discoverRuntimeRecoveryCandidates(seed, { towers: [{ url }] });
  expect(result.failures.map(({ category, code }) => ({ category, code }))).toEqual([
    { category: 'TransientRace', code: 'RECOVERY_TOWER_UNREACHABLE' },
  ]);
});
