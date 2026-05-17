import { afterEach, describe, expect, test } from 'bun:test';

import { findForbiddenRpcProxyMethod, isLocalProxyRequest } from '../../frontend/src/routes/rpc-proxy-safety';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_ALLOW_LOCAL_RPC_PROXY = process.env['XLN_ALLOW_LOCAL_RPC_PROXY'];

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env['NODE_ENV'];
  } else {
    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  }
  if (ORIGINAL_ALLOW_LOCAL_RPC_PROXY === undefined) {
    delete process.env['XLN_ALLOW_LOCAL_RPC_PROXY'];
  } else {
    process.env['XLN_ALLOW_LOCAL_RPC_PROXY'] = ORIGINAL_ALLOW_LOCAL_RPC_PROXY;
  }
});

describe('rpc proxy safety', () => {
  test('does not trust spoofed localhost host from a remote client', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['XLN_ALLOW_LOCAL_RPC_PROXY'];
    expect(isLocalProxyRequest('http://localhost/rpc2', '203.0.113.10')).toBe(false);
  });

  test('allows localhost bypass only for loopback client or explicit dev flag', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['XLN_ALLOW_LOCAL_RPC_PROXY'];
    expect(isLocalProxyRequest('http://localhost/rpc2', '127.0.0.1')).toBe(true);
    expect(isLocalProxyRequest('http://localhost/rpc2', '::1')).toBe(true);

    process.env['XLN_ALLOW_LOCAL_RPC_PROXY'] = '1';
    expect(isLocalProxyRequest('http://localhost/rpc2', '203.0.113.10')).toBe(true);
  });

  test('never allows localhost bypass in production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['XLN_ALLOW_LOCAL_RPC_PROXY'] = '1';
    expect(isLocalProxyRequest('http://localhost/rpc2', '127.0.0.1')).toBe(false);
  });

  test('blocks unsafe anvil and wallet methods', () => {
    expect(findForbiddenRpcProxyMethod(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [] }))).toBe('anvil_setBalance');
    expect(findForbiddenRpcProxyMethod(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'wallet_addEthereumChain', params: [] }))).toBe('wallet_addEthereumChain');
    expect(findForbiddenRpcProxyMethod(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }))).toBeNull();
  });
});
