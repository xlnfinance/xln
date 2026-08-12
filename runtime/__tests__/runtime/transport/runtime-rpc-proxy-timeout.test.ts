import { describe, expect, test } from 'bun:test';
import { createRelayStore } from '../../../network/relay/store';
import { handleRuntimeRpcProxy } from '../../../api/server/rpc/proxy';

describe('runtime RPC proxy timeouts', () => {
  test('fails fast when configured upstream never responds', async () => {
    const previousTimeout = process.env['XLN_RPC_PROXY_TIMEOUT_MS'];
    const previousUpstream = process.env['RPC_UPSTREAM_URL'];
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    process.env['XLN_RPC_PROXY_TIMEOUT_MS'] = '25';
    process.env['RPC_UPSTREAM_URL'] = `http://127.0.0.1:${server.port}`;
    try {
      const startedAt = performance.now();
      const response = await handleRuntimeRpcProxy({
        req: new Request('http://127.0.0.1/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
        }),
        pathname: '/rpc',
        env: null,
        relayStore: createRelayStore('test'),
        headers: { 'content-type': 'application/json' },
        operatorAuthorized: true,
      });
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(502);
      expect(body.error).toContain('RPC_PROXY_TIMEOUT:25');
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env['XLN_RPC_PROXY_TIMEOUT_MS'];
      } else {
        process.env['XLN_RPC_PROXY_TIMEOUT_MS'] = previousTimeout;
      }
      if (previousUpstream === undefined) {
        delete process.env['RPC_UPSTREAM_URL'];
      } else {
        process.env['RPC_UPSTREAM_URL'] = previousUpstream;
      }
      await server.stop(true);
    }
  }, 2_000);

  test('never exposes path-embedded RPC credentials in responses or debug telemetry', async () => {
    const keys = ['RPC_UPSTREAM_URL', 'BLOCK_LOCAL_RPC_PROXY'] as const;
    const previous = new Map(keys.map(key => [key, process.env[key]] as const));
    const secret = 'sentinel-provider-key';
    const relayStore = createRelayStore('rpc-redaction');
    try {
      process.env['RPC_UPSTREAM_URL'] = `http://127.0.0.1:8545/rpc/${secret}?token=${secret}`;
      process.env['BLOCK_LOCAL_RPC_PROXY'] = 'true';
      const response = await handleRuntimeRpcProxy({
        req: new Request('http://127.0.0.1/rpc', { method: 'POST', body: '{}' }),
        pathname: '/rpc',
        env: null,
        relayStore,
        headers: { 'content-type': 'application/json' },
        operatorAuthorized: false,
      });
      const encoded = `${await response.text()}\n${JSON.stringify(relayStore.debugEvents)}`;
      expect(response.status).toBe(503);
      expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain('/rpc/');
      expect(encoded).toContain('http://127.0.0.1:8545');
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
