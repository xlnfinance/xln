import { afterEach, describe, expect, test } from 'bun:test';
import { createXlnJsonRpcProvider } from '../jadapter';
import { readAndAssertRpcChainId } from '../jadapter/rpc-network';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('JAdapter static jurisdiction network', () => {
  test('does not repeat eth_chainId for calls on a bound provider', async () => {
    const calls = new Map<string, number>();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const payload = await request.json() as { id: number; method: string };
        calls.set(payload.method, (calls.get(payload.method) ?? 0) + 1);
        const result = payload.method === 'eth_chainId' ? '0x7a69' : '0x1';
        return Response.json({ jsonrpc: '2.0', id: payload.id, result });
      },
    });
    servers.push(server);
    const provider = createXlnJsonRpcProvider(`http://127.0.0.1:${server.port}`, 31337);

    await expect(readAndAssertRpcChainId(provider, 31337)).resolves.toBe(31337);
    await provider.getBlockNumber();
    await provider.getBlockNumber();
    await provider.getNetwork();
    provider.destroy();

    expect(calls.get('eth_chainId')).toBe(1);
    expect(calls.get('eth_blockNumber')).toBe(2);
  });

  test('explicit wire check rejects a mismatched configured jurisdiction', async () => {
    const provider = { send: async () => '0x7a6a' };
    await expect(readAndAssertRpcChainId(provider, 31337)).rejects.toThrow(
      'chainId mismatch: config=31337 rpc=31338',
    );
  });
});
