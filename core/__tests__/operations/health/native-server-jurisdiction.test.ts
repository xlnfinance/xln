import { expect, test } from 'bun:test';
import { configuredNativeServerJurisdiction } from '../../../api/server/native-jurisdiction';
import type { JurisdictionsData } from '../../../jurisdiction/adapter/kernel/jurisdiction-loader';

const data: JurisdictionsData = {
  version: '1', lastUpdated: '2026-10-07', defaults: { timeout: 10000, retryAttempts: 3, gasLimit: 10000000 },
  jurisdictions: { native: { name: 'Native TVM', chainId: 2414086651, blockTimeMs: 3000,
    mode: 'tron', rpc: 'http://127.0.0.1:18545/jsonrpc', tronFullHost: 'http://127.0.0.1:19090',
    tronSolidityHost: 'http://127.0.0.1:19091', entityProviderDeploymentBlock: 12,
    contracts: { entityProvider: `0x${'11'.repeat(20)}`, depository: `0x${'22'.repeat(20)}` },
    explorer: '', currency: 'TRX', status: 'active' } },
};

test('native server preserves configured TVM transport and has no implicit signer', () => {
  const selected = configuredNativeServerJurisdiction(data, 'native');
  expect(selected.adapterConfig).toMatchObject({ mode: 'tron', watchOnly: true,
    chainId: data.jurisdictions.native!.chainId, tronFullHost: data.jurisdictions.native!.tronFullHost });
  expect(selected.adapterConfig.privateKey).toBeUndefined();
});

test('native server rejects ambiguous active jurisdictions and inactive selection', () => {
  const config = data.jurisdictions.native!;
  expect(() => configuredNativeServerJurisdiction({ ...data, jurisdictions: { one: config, two: config } }, '')).toThrow('SERVER_JURISDICTION_SELECTION_REQUIRED');
  expect(() => configuredNativeServerJurisdiction({ ...data, jurisdictions: { native: { ...config, status: 'inactive' } } }, 'native')).toThrow('SERVER_JURISDICTION_SELECTION_REQUIRED');
});

test('EVM configuration retains the explicit existing RPC or simulation startup requirement', () => {
  const { mode: _mode, tronFullHost: _full, tronSolidityHost: _solid, ...evm } = data.jurisdictions.native!;
  expect(() => configuredNativeServerJurisdiction({ ...data, jurisdictions: { evm } }, 'evm'))
    .toThrow('JADAPTER_MODE_REQUIRED:set_USE_ANVIL_or_XLN_LOCAL_SIMULATION');
});

test('native REST proxy pins safe-head and signed-broadcast paths to configured hosts', async () => {
  const { nativeRestUpstream } = await import('../../../api/server/rpc/tron-proxy');
  expect(nativeRestUpstream(data, '/api/tron/2414086651/walletsolidity/getnowblock', 'POST')).toBe('http://127.0.0.1:19091/walletsolidity/getnowblock');
  expect(nativeRestUpstream(data, '/api/tron/2414086651/wallet/broadcasthex', 'POST')).toBe('http://127.0.0.1:19090/wallet/broadcasthex');
  // The J watcher binds dispute calldata to a TRON txID through the solidified raw_data.
  expect(nativeRestUpstream(data, '/api/tron/2414086651/walletsolidity/gettransactionbyid', 'POST'))
    .toBe('http://127.0.0.1:19091/walletsolidity/gettransactionbyid');
  expect(() => nativeRestUpstream(data, '/api/tron/2414086651/walletsolidity/gettransactionbyid', 'GET'))
    .toThrow('TRON_PROXY_METHOD_DENIED');
  expect(() => nativeRestUpstream(data, '/api/tron/2414086651/walletsolidity/broadcasthex', 'POST'))
    .toThrow('TRON_PROXY_METHOD_DENIED');
  for (const path of ['/api/tron/1/wallet/getnowblock', '/api/tron/2414086651/wallet/gettransactionsign', '/api/tron/2414086651/wallet/../getnowblock']) {
    expect(() => nativeRestUpstream(data, path, 'POST')).toThrow();
  }
  expect(() => nativeRestUpstream(data, '/api/tron/2414086651/wallet/broadcasthex', 'GET')).toThrow('TRON_PROXY_METHOD_DENIED');
});

test('native public transport keeps the actual browser HTTPS origin, independent of proxy headers', async () => {
  const { resolveNativeTransportHost } = await import('../../../jurisdiction/adapter/kernel/native-host');
  expect(resolveNativeTransportHost('/api/tron/2414086651', 'https://wallet.example')).toBe('https://wallet.example/api/tron/2414086651');
  expect(resolveNativeTransportHost('/api/tron/2414086651', 'http://localhost:8080')).toBe('http://localhost:8080/api/tron/2414086651');
  expect(resolveNativeTransportHost('/api/tron/2414086651')).toBe('/api/tron/2414086651');
  expect(resolveNativeTransportHost('//evil.example', 'https://wallet.example')).toBe('//evil.example');
});
