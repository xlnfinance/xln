import { expect, test } from 'bun:test';
import type { Stack } from './hosted';
import { settleStackDiscovery } from './stack-discovery';

test('discovery rejection ends probing with the original error and no usable stack', async () => {
  expect(await settleStackDiscovery(Promise.reject(new Error('HTTP 503')))).toEqual({
    stack: null, error: 'HTTP 503',
  });
});

test('non-Error discovery rejection is still visible', async () => {
  expect(await settleStackDiscovery(Promise.reject('JURISDICTION_PUBLIC_RPC_UNMAPPED:test'))).toEqual({
    stack: null, error: 'JURISDICTION_PUBLIC_RPC_UNMAPPED:test',
  });
});

test('retry uses a new discovery result and clears the prior failure', async () => {
  const failed = await settleStackDiscovery(Promise.reject(new Error('HTTP 500')));
  expect(failed.stack).toBeNull();
  expect(failed.error).toBe('HTTP 500');
  const jurisdiction = {
    key: 'testnet', name: 'Testnet', chainId: 31337, rpcUrl: 'http://localhost/rpc',
    blockTimeMs: 10_000, entityProviderDeploymentBlock: 2,
    contracts: { account: 'account', depository: 'depository', entityProvider: 'entityProvider', deltaTransformer: 'deltaTransformer' },
  };
  const stack: Stack = {
    apiBase: 'http://localhost', relayUrl: 'ws://localhost/relay',
    jurisdiction, jurisdictions: [jurisdiction], hubs: [],
  };
  const retried = await settleStackDiscovery(Promise.resolve(stack));
  expect(retried.stack).toBe(stack);
  expect(retried.error).toBeNull();
});

test('successful discovery with no networks stays offline with no networks invented', async () => {
  expect(await settleStackDiscovery(Promise.resolve(null))).toEqual({ stack: null, error: null });
});
