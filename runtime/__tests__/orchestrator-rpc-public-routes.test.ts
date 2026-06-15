import { describe, expect, test } from 'bun:test';

import { toPublicJurisdictionsPayload } from '../orchestrator/jurisdictions';
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
        arrakis: {
          name: 'Testnet',
          chainId: 31337,
          rpc: 'http://127.0.0.1:8545',
          contracts: { depository: '0x1', entityProvider: '0x2' },
        },
        tron: {
          name: 'Tron',
          chainId: 31338,
          rpc: 'http://127.0.0.1:8546',
          contracts: { depository: '0x3', entityProvider: '0x4' },
        },
        rpc3: {
          name: 'RPC3',
          chainId: 31339,
          rpc: 'http://127.0.0.1:8547',
          contracts: { depository: '0x5', entityProvider: '0x6' },
        },
        custom8: {
          name: 'rpc8',
          chainId: 31344,
          rpc: '',
          contracts: { depository: '0x7', entityProvider: '0x8' },
        },
        external: {
          name: 'External',
          chainId: 1,
          rpc: 'https://example.invalid/rpc',
          contracts: { depository: '0x9', entityProvider: '0xa' },
        },
      },
    })));

    expect(payload.jurisdictions.arrakis.rpc).toBe('/rpc');
    expect(payload.jurisdictions.tron.rpc).toBe('/rpc2');
    expect(payload.jurisdictions.rpc3.rpc).toBe('/rpc3');
    expect(payload.jurisdictions.custom8.rpc).toBe('/rpc8');
    expect(payload.jurisdictions.external.rpc).toBe('https://example.invalid/rpc');
  });
});
