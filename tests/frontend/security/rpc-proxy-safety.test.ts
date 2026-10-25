import { afterEach, describe, expect, test } from 'bun:test';
import { HDNodeWallet, Mnemonic, Transaction, Wallet, getIndexedAccountPath } from 'ethers';

import { isLocalProxyRequest, readRpcProxyRequest } from '../../../frontend/src/routes/rpc-proxy-safety';
import { safeStringify } from '../../../core/protocol/serialization';

const rpcRequest = (body: unknown): Request => new Request('http://localhost/rpc', {
  method: 'POST',
  body: safeStringify(body),
});

const rawCall = (raw: string) => ({ jsonrpc: '2.0', id: 7, method: 'eth_sendRawTransaction', params: [raw] });

const signedTransfer = (signer: Wallet | HDNodeWallet, overrides: Record<string, unknown> = {}): Promise<string> =>
  signer.signTransaction({
    type: 2,
    chainId: 31_337n,
    nonce: 0,
    to: '0x000000000000000000000000000000000000dEaD',
    value: 1n,
    gasLimit: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...overrides,
  });

// The well-known development mnemonic every Anvil/Hardhat instance ships with.
const publicDevKey = (index: number): HDNodeWallet => HDNodeWallet.fromMnemonic(
  Mnemonic.fromPhrase('test test test test test test test test test test test junk'),
  getIndexedAccountPath(index),
);

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

  test('allows only the explicit read-only RPC surface', async () => {
    for (const method of [
      'anvil_setBalance',
      'anvil_impersonateAccount',
      'wallet_addEthereumChain',
      'eth_signTypedData_v4',
      'eth_sendTransaction',
      'eth_sign',
      'personal_sign',
      'personal_unlockAccount',
      'debug_traceTransaction',
      'admin_addPeer',
      'eth_futureReadMethod',
    ]) {
      const request = new Request('http://localhost/rpc', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      });
      expect((await readRpcProxyRequest(request)).forbiddenMethod).toBe(method);
    }
    // The watcher's state-anchor and debt-provenance reads must pass the public bridge.
    for (const method of [
      'eth_blockNumber',
      'eth_getProof',
      'eth_getBlockReceipts',
      'eth_getBlockTransactionCountByHash',
      'eth_getRawTransactionByBlockHashAndIndex',
    ]) {
      const allowed = rpcRequest({ jsonrpc: '2.0', id: 1, method, params: [] });
      expect((await readRpcProxyRequest(allowed)).forbiddenMethod).toBeNull();
    }
  });

  test('relays a wallet-signed raw transaction, alone or in a read batch', async () => {
    const raw = await signedTransfer(Wallet.createRandom());
    expect((await readRpcProxyRequest(rpcRequest(rawCall(raw)))).forbiddenMethod).toBeNull();
    const batch = [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, rawCall(raw)];
    expect((await readRpcProxyRequest(rpcRequest(batch))).forbiddenMethod).toBeNull();
  });

  test('rejects raw transactions that are malformed, unsigned, replayable, oversized or delegate code', async () => {
    const wallet = Wallet.createRandom();
    const signed = await signedTransfer(wallet);
    const unsigned = Transaction.from({
      type: 2, chainId: 31_337n, nonce: 0, to: wallet.address, value: 1n, gasLimit: 21_000n,
      maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    }).unsignedSerialized;
    const unprotectedTransfer = await wallet.signTransaction({
      type: 0, nonce: 0, to: wallet.address, value: 1n, gasLimit: 21_000n, gasPrice: 1n,
    });
    const delegation = await wallet.signTransaction({
      type: 4, chainId: 31_337n, nonce: 0, to: wallet.address, value: 0n, gasLimit: 100_000n,
      maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
      authorizationList: [await wallet.authorize({ address: wallet.address, nonce: 1n, chainId: 31_337n })],
    });
    const cases: Array<[unknown[], string]> = [
      [[], 'RAW_TX_PARAMS_INVALID'],
      [[signed, 'extra'], 'RAW_TX_PARAMS_INVALID'],
      [[42], 'RAW_TX_PARAMS_INVALID'],
      [['0xzz'], 'RAW_TX_INVALID'],
      [[signed.slice(0, 2 + 2 * 40)], 'RAW_TX_INVALID'],
      [[unsigned], 'RAW_TX_UNSIGNED'],
      [[unprotectedTransfer], 'RAW_TX_CHAIN_ID_REQUIRED'],
      [[delegation], 'RAW_TX_TYPE_UNSUPPORTED'],
    ];
    for (const [params, code] of cases) {
      const request = rpcRequest({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params });
      expect((await readRpcProxyRequest(request)).forbiddenMethod).toBe(`eth_sendRawTransaction:${code}`);
    }
  });

  test('never relays a transaction signed by a publicly known development key', async () => {
    for (const index of [0, 1, 2, 9, 19]) {
      const raw = await signedTransfer(publicDevKey(index));
      expect((await readRpcProxyRequest(rpcRequest(rawCall(raw)))).forbiddenMethod)
        .toBe('eth_sendRawTransaction:RAW_TX_PUBLIC_DEV_KEY');
    }
  });
});
