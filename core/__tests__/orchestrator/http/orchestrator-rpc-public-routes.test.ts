import { safeStringify } from '../../../protocol/serialization';
import { describe, expect, test } from 'bun:test';

import { toPublicJurisdictionsPayload } from '../../../orchestrator/j-select/jurisdictions';
import { selectPrimaryHubJurisdiction } from '../../../orchestrator/j-select/jurisdiction-select';
import { resolveRpcProxyIndex } from '../../../orchestrator/proxy';

describe('orchestrator public RPC routes', () => {
  test('accepts exact public RPC proxy paths for rpc through rpc8', () => {
    expect(resolveRpcProxyIndex('/rpc')).toBe(1);
    expect(resolveRpcProxyIndex('/api/rpc')).toBeNull();
    for (let index = 2; index <= 8; index += 1) {
      expect(resolveRpcProxyIndex(`/rpc${index}`)).toBe(index);
      expect(resolveRpcProxyIndex(`/api/rpc${index}`)).toBeNull();
    }
    expect(resolveRpcProxyIndex('/rpc1')).toBeNull();
    expect(resolveRpcProxyIndex('/rpc9')).toBeNull();
    expect(resolveRpcProxyIndex('/rpc2/unsafe')).toBeNull();
  });

  test('publishes loopback jurisdictions through same-origin rpc slots', () => {
    const contracts = {
      account: `0x${'11'.repeat(20)}`,
      depository: `0x${'22'.repeat(20)}`,
      entityProvider: `0x${'33'.repeat(20)}`,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    };
    const payload = JSON.parse(toPublicJurisdictionsPayload({
      shardJurisdictionsPath: '/tmp/unused-jurisdictions.json',
      rpc2Url: 'http://127.0.0.1:8546',
      ephemeralTestnet: true,
      rpcUrls: {
        1: 'http://127.0.0.1:8545',
        2: 'http://127.0.0.1:8546',
        3: 'http://127.0.0.1:8547',
        8: 'http://127.0.0.1:8552',
      },
    }, JSON.stringify({
      version: '1',
      jurisdictions: {
        primary: {
          name: 'Primary',
          status: 'active',
          chainId: 31337,
          rpc: 'http://127.0.0.1:8545',
          entityProviderDeploymentBlock: 2,
          contracts,
        },
        tron: {
          name: 'Tron',
          status: 'active',
          chainId: 31338,
          rpc: 'http://127.0.0.1:8546',
          entityProviderDeploymentBlock: 2,
          contracts,
        },
        rpc3: {
          name: 'RPC3',
          status: 'active',
          chainId: 31339,
          rpc: 'http://127.0.0.1:8547',
          entityProviderDeploymentBlock: 2,
          contracts,
        },
        custom8: {
          name: 'rpc8',
          status: 'active',
          chainId: 31344,
          rpc: '',
          entityProviderDeploymentBlock: 2,
          contracts,
        },
        external: {
          name: 'External',
          status: 'active',
          chainId: 1,
          rpc: 'https://example.invalid/rpc',
          entityProviderDeploymentBlock: 2,
          contracts,
        },
      },
    })));

    expect(payload.jurisdictions.primary.rpc).toBe('/rpc');
    expect(payload.jurisdictions.tron.rpc).toBe('/rpc2');
    expect(payload.jurisdictions.rpc3.rpc).toBe('/rpc3');
    expect(payload.jurisdictions.custom8.rpc).toBe('/rpc8');
    expect(payload.jurisdictions.external.rpc).toBe('https://example.invalid/rpc');
    expect(payload.ephemeralTestnet).toBe(true);
  });

  test('rejects malformed jurisdiction JSON instead of publishing it verbatim', () => {
    expect(() => toPublicJurisdictionsPayload({
      shardJurisdictionsPath: '/tmp/unused-jurisdictions.json',
      rpc2Url: '',
    }, '{')).toThrow('PUBLIC_JURISDICTIONS_JSON_INVALID');
  });

  test('rejects an active RPC stack without exact EntityProvider deployment metadata', () => {
    const config = {
      shardJurisdictionsPath: '/tmp/unused-jurisdictions.json',
      rpc2Url: '',
      rpcUrls: { 1: 'http://127.0.0.1:8545' },
    };
    const jurisdiction = {
      name: 'Primary',
      chainId: 31337,
      rpc: 'http://127.0.0.1:8545',
      contracts: {
        account: `0x${'11'.repeat(20)}`,
        depository: `0x${'22'.repeat(20)}`,
        entityProvider: `0x${'33'.repeat(20)}`,
        deltaTransformer: `0x${'44'.repeat(20)}`,
      },
    };

    for (const entityProviderDeploymentBlock of [undefined, 0, -1, 1.5]) {
      expect(() => toPublicJurisdictionsPayload(config, JSON.stringify({
        version: '1',
        jurisdictions: {
          primary: {
            ...jurisdiction,
            status: 'active',
            ...(entityProviderDeploymentBlock === undefined
              ? {}
              : { entityProviderDeploymentBlock }),
          },
        },
      }))).toThrow(
        entityProviderDeploymentBlock === undefined
          ? 'PUBLIC_RPC_JURISDICTION_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:primary:undefined'
          : 'PUBLIC_JURISDICTIONS_JSON_INVALID:jurisdiction=primary_FIELDS_INVALID',
      );
    }

    for (const status of ['pending', 'inactive']) {
      expect(() => toPublicJurisdictionsPayload(config, JSON.stringify({
        version: '1',
        jurisdictions: {
          primary: { ...jurisdiction, status },
        },
      }))).not.toThrow();
    }

    const published = JSON.parse(toPublicJurisdictionsPayload(config, JSON.stringify({
      version: '1',
      jurisdictions: {
        primary: { ...jurisdiction, status: 'active', entityProviderDeploymentBlock: 2 },
      },
    })));
    expect(published.jurisdictions.primary.entityProviderDeploymentBlock).toBe(2);
  });

  test('rejects every nonempty partial or malformed active RPC contract stack', () => {
    const config = {
      shardJurisdictionsPath: '/tmp/unused-jurisdictions.json',
      rpc2Url: '',
      rpcUrls: { 1: 'http://127.0.0.1:8545' },
    };
    const base = {
      name: 'Primary',
      status: 'active',
      chainId: 31337,
      rpc: 'http://127.0.0.1:8545',
      entityProviderDeploymentBlock: 2,
    };
    const serialize = (contracts: Record<string, string>, status = 'active') =>
      toPublicJurisdictionsPayload(config, JSON.stringify({
        version: '1',
        jurisdictions: { primary: { ...base, status, contracts } },
      }));

    expect(() => serialize({
      depository: `0x${'22'.repeat(20)}`,
      entityProvider: `0x${'33'.repeat(20)}`,
    })).toThrow(
      'PUBLIC_RPC_JURISDICTION_CONTRACT_STACK_INVALID:primary:account,deltaTransformer',
    );
    expect(() => serialize({
      account: 'not-an-address',
      depository: `0x${'22'.repeat(20)}`,
      entityProvider: `0x${'33'.repeat(20)}`,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    })).toThrow(
      'PUBLIC_RPC_JURISDICTION_CONTRACT_STACK_INVALID:primary:account',
    );

    expect(() => serialize({})).not.toThrow();
    expect(() => serialize({ depository: '', entityProvider: '' })).not.toThrow();
    expect(() => serialize({ depository: `0x${'22'.repeat(20)}` }, 'pending')).not.toThrow();
    expect(() => serialize({ entityProvider: `0x${'33'.repeat(20)}` }, 'inactive')).not.toThrow();
  });

  test('selects the custody primary jurisdiction key without arrakis coupling', () => {
    const primary = selectPrimaryHubJurisdiction({
      version: '1',
      jurisdictions: {
        tron: {
          name: 'Tron',
          chainId: 31338,
          rpc: 'http://127.0.0.1:8546',
          contracts: { depository: '0x3', entityProvider: '0x4' },
        },
        base: {
          name: 'Base',
          primary: true,
          chainId: 8453,
          rpc: 'http://127.0.0.1:8545',
          contracts: { depository: '0x5', entityProvider: '0x6' },
        },
      },
    }, { rpc2Url: 'http://127.0.0.1:8546' });

    expect(primary).toEqual({
      key: 'base',
      name: 'Base',
      chainId: 8453,
      depositoryAddress: '0x5',
      entityProviderAddress: '0x6',
    });
  });
});

test('native aggregate metadata publishes the same-origin REST route without exposing direct node hosts', () => {
  const payload = JSON.parse(toPublicJurisdictionsPayload({
    shardJurisdictionsPath: '/tmp/native-shard.json', rpc2Url: '',
    rpcUrls: { 1: 'http://127.0.0.1:18545/jsonrpc' },
  }, safeStringify({ version: '1', jurisdictions: { native: {
    name: 'Native TVM', status: 'active', mode: 'tron', chainId: 2414086651,
    rpc: 'http://127.0.0.1:18545/jsonrpc', tronFullHost: 'http://127.0.0.1:19090',
    tronSolidityHost: 'http://127.0.0.1:19091', entityProviderDeploymentBlock: 12,
    contracts: { account: `0x${'11'.repeat(20)}`, depository: `0x${'22'.repeat(20)}`,
      entityProvider: `0x${'33'.repeat(20)}`, deltaTransformer: `0x${'44'.repeat(20)}` },
  } } })));
  expect(payload.jurisdictions.native.tronFullHost).toBe('/api/tron/2414086651');
  expect(payload.jurisdictions.native.tronSolidityHost).toBe('/api/tron/2414086651');
});

test('native aggregate proxy uses its selected shard and the shared bounded HTTP handler', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { proxyNativeRest } = await import('../../../orchestrator/proxy');
  const dir = mkdtempSync(join(tmpdir(), 'xln-native-proxy-'));
  const shardJurisdictionsPath = join(dir, 'jurisdictions.json');
  writeFileSync(shardJurisdictionsPath, safeStringify({ version: '1', lastUpdated: '2026-10-07',
    defaults: { timeout: 1000, retryAttempts: 1, gasLimit: 100000 }, jurisdictions: { native: {
      name: 'Native TVM', chainId: 2414086651, blockTimeMs: 3000, rpc: 'http://127.0.0.1:18545/jsonrpc',
      mode: 'tron', tronFullHost: 'http://127.0.0.1:19090', tronSolidityHost: 'http://127.0.0.1:19091',
      status: 'active', explorer: '', currency: 'TRX', entityProviderDeploymentBlock: 12,
      contracts: { entityProvider: `0x${'11'.repeat(20)}`, depository: `0x${'22'.repeat(20)}` },
    } } }));
  try {
    // Resolving a global/EVM config would reject this chain before reaching the
    // common byte limit. No RPC is sent for an oversized client request.
    const response = await proxyNativeRest(new Request('http://localhost/api/tron/2414086651/walletsolidity/getnowblock', {
      method: 'POST', headers: { 'content-length': String(300 * 1024) }, body: '{}',
    }), {}, { shardJurisdictionsPath, rpc2Url: '' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'RPC_PROXY_REQUEST_TOO_LARGE' });
  } finally { rmSync(dir, { recursive: true }); }
});
