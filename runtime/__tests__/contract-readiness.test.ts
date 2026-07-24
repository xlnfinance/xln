import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('portable contract artifacts carry bounded immutable metadata without build-info', () => {
  const root = join(import.meta.dir, '..', '..');
  const immutableGroupCounts = new Map<string, number>();

  for (const contractName of ['Account', 'Depository', 'EntityProvider', 'HankoVerifier', 'DeltaTransformer']) {
    const artifact = JSON.parse(readFileSync(
      join(root, 'frontend', 'static', 'contracts', `${contractName}.json`),
      'utf8',
    ));
    expect(artifact.immutableReferences).toBeDefined();
    const deployedBytes = (String(artifact.deployedBytecode).length - 2) / 2;
    for (const references of Object.values(artifact.immutableReferences) as Array<
      Array<{ start: number; length: number }>
    >) {
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference.length).toBe(32);
        expect(reference.start).toBeGreaterThanOrEqual(0);
        expect(reference.start + reference.length).toBeLessThanOrEqual(deployedBytes);
      }
    }
    immutableGroupCounts.set(contractName, Object.keys(artifact.immutableReferences).length);
  }

  expect(immutableGroupCounts.get('Account')).toBe(1);
  expect(immutableGroupCounts.get('Depository')).toBeGreaterThan(0);
});

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
