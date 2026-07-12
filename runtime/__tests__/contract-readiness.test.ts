import { expect, test } from 'bun:test';
import {
  findMissingRpcContractCode,
  type RpcContractAddresses,
} from '../orchestrator/contract-readiness';

const addresses: RpcContractAddresses = {
  account: `0x${'11'.repeat(20)}`,
  depository: `0x${'22'.repeat(20)}`,
  entityProvider: `0x${'33'.repeat(20)}`,
  deltaTransformer: `0x${'44'.repeat(20)}`,
};

test('contract readiness checks every required address in one bounded RPC batch', async () => {
  const seenMethods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const batch = await request.json() as Array<{ id: number; method: string; params: string[] }>;
      seenMethods.push(...batch.map((entry) => entry.method));
      return Response.json(batch.map((entry) => ({
        jsonrpc: '2.0',
        id: entry.id,
        result: entry.params[0]?.toLowerCase() === addresses.deltaTransformer?.toLowerCase() ? '0x' : '0x6000',
      })).reverse());
    },
  });
  try {
    const missing = await findMissingRpcContractCode(`http://127.0.0.1:${server.port}`, addresses);
    expect(missing).toEqual([`deltaTransformer:${addresses.deltaTransformer}`]);
    expect(seenMethods).toEqual(Array(4).fill('eth_getCode'));
  } finally {
    await server.stop(true);
  }
});

test('contract readiness reports absent addresses without issuing invalid RPC calls', async () => {
  expect(await findMissingRpcContractCode('http://127.0.0.1:1', {})).toEqual([
    'account:missing',
    'depository:missing',
    'entityProvider:missing',
    'deltaTransformer:missing',
  ]);
});
