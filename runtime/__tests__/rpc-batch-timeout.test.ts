import { describe, expect, test } from 'bun:test';
import { sendRpcBatch } from '../jadapter/rpc-utils';

describe('RPC batch transport timeouts', () => {
  test('fails fast when upstream accepts the request but never responds', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    const startedAt = performance.now();
    try {
      await expect(sendRpcBatch(`http://127.0.0.1:${server.port}`, [{
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
      }], 25)).rejects.toThrow('RPC_BATCH_TIMEOUT:25');
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await server.stop(true);
    }
  }, 2_000);
});
