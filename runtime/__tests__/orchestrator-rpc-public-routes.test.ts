import { describe, expect, test } from 'bun:test';

import { toPublicJurisdictionsPayload } from '../orchestrator/jurisdictions';
import { selectPrimaryHubJurisdiction } from '../orchestrator/jurisdiction-select';
import { resolveRpcProxyIndex } from '../orchestrator/proxy';

describe('orchestrator public RPC routes', () => {
  test('accepts exact public RPC proxy paths for rpc through rpc8', () => {
    expect(resolveRpcProxyIndex('/rpc')).toBe(1);
    expect(resolveRpcProxyIndex('/api/rpc')).toBe(1);
    for (let index = 2; index <= 8; index += 1) {
      expect(resolveRpcProxyIndex(`/rpc${index}`)).toBe(index);
      expect(resolveRpcProxyIndex(`/api/rpc${index}`)).toBe(index);
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
      rpcUrls: {
        1: 'http://127.0.0.1:8545',
        2: 'http://127.0.0.1:8546',
        3: 'http://127.0.0.1:8547',
        8: 'http://127.0.0.1:8552',
      },
    }, JSON.stringify({
      version: '3',
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
        version: '3',
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
        `PUBLIC_RPC_JURISDICTION_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID:primary:${String(entityProviderDeploymentBlock)}`,
      );
    }

    for (const status of ['pending', 'inactive']) {
      expect(() => toPublicJurisdictionsPayload(config, JSON.stringify({
        version: '3',
        jurisdictions: {
          primary: { ...jurisdiction, status },
        },
      }))).not.toThrow();
    }

    const published = JSON.parse(toPublicJurisdictionsPayload(config, JSON.stringify({
      version: '3',
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
        version: '3',
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
      version: '3',
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
