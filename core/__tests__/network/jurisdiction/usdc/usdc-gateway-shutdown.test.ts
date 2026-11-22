import { expect, test } from 'bun:test';
import { safeStringify } from '../../../../protocol/serialization';

const waitUntil = async (ready: () => boolean): Promise<void> => {
  const deadline = performance.now() + 2_500;
  while (!ready()) {
    if (performance.now() >= deadline) throw new Error('USDC_GATEWAY_TEST_DEADLINE');
    await Bun.sleep(10);
  }
};

test('gateway cancels active and queued header reads when the watcher disconnects', async () => {
  const hold = Promise.withResolvers<void>();
  const received: number[] = [];
  const cancelled: number[] = [];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const calls = await request.json() as { id: number }[];
      const id = calls[0]!.id;
      received.push(id);
      request.signal.addEventListener('abort', () => cancelled.push(id), { once: true });
      if (id <= 3) await hold.promise;
      return Response.json(calls.map(call => ({ jsonrpc: '2.0', id: call.id, result: null })));
    },
  });
  const port = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const endpoint = port.url.origin;
  port.stop();
  const gateway = Bun.spawn([
    process.execPath, 'jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts', '--api-base', endpoint,
  ], {
    env: {
      PATH: process.env['PATH'],
      ETH_SEPOLIA_RPC: upstream.url.href,
      ARB_SEPOLIA_RPC: upstream.url.href,
      POC_HEADER_BATCH_TIMING: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const state = { stdout: '', stderr: '' };
  const capture = async (key: 'stdout' | 'stderr'): Promise<void> => {
    for await (const chunk of gateway[key].pipeThrough(new TextDecoderStream())) state[key] += chunk;
  };
  const logs = Promise.all([capture('stdout'), capture('stderr')]);
  const active = new AbortController();
  const queued = new AbortController();
  const read = (id: number, signal: AbortSignal) => fetch(endpoint + '/rpc', {
    method: 'POST',
    signal,
    body: safeStringify({ id, jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['0x1', false] }),
  });
  try {
    await waitUntil(() => (state.stdout + state.stderr).includes('service.listen'));
    const reads = Promise.allSettled([1, 2].map(id => read(id, active.signal)));
    await waitUntil(() => received.length === 2);
    const waiting = Promise.allSettled([read(3, queued.signal)]);
    await waitUntil(() => /"activeAtArrival":2[^\n]+"phase":"queued"/.test(state.stderr));
    queued.abort();
    expect((await waiting)[0]?.status).toBe('rejected');
    await waitUntil(() => state.stderr.includes('"phase":"cancelled"'));
    expect(cancelled).toHaveLength(0);
    active.abort();
    expect((await reads).map(result => result.status)).toEqual(['rejected', 'rejected']);
    await waitUntil(() => cancelled.length === 2 && (state.stderr.match(/"phase":"cancelled"/g)?.length ?? 0) === 3);
    expect(cancelled.toSorted()).toEqual(received.toSorted());
    const next = await read(4, AbortSignal.timeout(1_500));
    expect(await next.json()).toEqual({ jsonrpc: '2.0', id: 4, result: null });
    expect(received).toHaveLength(3);
  } finally {
    queued.abort();
    active.abort();
    hold.resolve();
    gateway.kill();
    await gateway.exited;
    await logs;
    upstream.stop(true);
  }
}, 10_000);
