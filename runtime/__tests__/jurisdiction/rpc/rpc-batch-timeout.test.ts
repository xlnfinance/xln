import { describe, expect, test } from 'bun:test';
import { sendRpcBatch } from '../../../jurisdiction/adapter/rpc-utils';
import { asRpcTxResponse } from '../../../jurisdiction/adapter/rpc/rpc-boundary';

describe('RPC batch transport timeouts', () => {
  test('preserves the provider transaction receiver when awaiting a receipt', async () => {
    class ForeignTransaction {
      readonly hash = `0x${'ab'.repeat(32)}`;
      readonly #receipt = { status: 1 };

      async wait(): Promise<unknown> {
        return this.#receipt;
      }
    }

    const tx = asRpcTxResponse(new ForeignTransaction());
    expect(await tx.wait()).toEqual({ status: 1 });
  });

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

  test('rejects a malformed provider batch item instead of treating it as an empty response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json([{ id: '1', result: '0x1' }]),
    });
    try {
      await expect(sendRpcBatch(`http://127.0.0.1:${server.port}`, [{
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
      }])).rejects.toThrow('RPC_BATCH_ITEM_ID_INVALID');
    } finally {
      await server.stop(true);
    }
  });

  test('keeps a successful JSON-RPC result free of a synthetic error', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json([{ jsonrpc: '2.0', id: 1, result: { number: '0x1' } }]),
    });
    try {
      const responses = await sendRpcBatch(`http://127.0.0.1:${server.port}`, [{
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: ['0x1', false],
      }]);
      expect(responses.get(1)).toEqual({ id: 1, result: { number: '0x1' } });
      expect(responses.get(1)?.error).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
