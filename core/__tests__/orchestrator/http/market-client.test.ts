import { expect, test } from 'bun:test';

import { fetchMarketTokensFromHub } from '../../../orchestrator/hub/market-client';

test('a hub that stalls after its headers cannot hang the market token fetch', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('['));
      },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  try {
    const startedAt = Date.now();
    await expect(fetchMarketTokensFromHub({
      host: '127.0.0.1',
      apiPort: Number(server.port),
      hubEntityId: `0x${'11'.repeat(32)}`,
    })).rejects.toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  } finally {
    server.stop(true);
  }
}, 8_000);
