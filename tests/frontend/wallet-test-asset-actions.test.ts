import { expect, test } from 'bun:test';

import {
  requestWalletTestAsset,
  type WalletTestAssetRequest,
} from '../../frontend/apps/wallet/src/features/accounts/wallet-test-asset-actions';

const base = (overrides: Partial<WalletTestAssetRequest> = {}): WalletTestAssetRequest => ({
  apiBase: 'http://wallet.test',
  target: 'external',
  entityId: `0x${'11'.repeat(32)}`,
  runtimeId: `0x${'22'.repeat(32)}`,
  owner: `0x${'33'.repeat(20)}`,
  counterpartyId: null,
  tokenId: 1,
  symbol: 'USDC',
  amount: '100',
  ...overrides,
});

test('external, reserve, and account faucets submit the canonical server-ingress payloads', async () => {
  const observed: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    observed.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ success: true, requestId: `req-${observed.length}` }), { status: 200 });
  }) as typeof fetch;
  await requestWalletTestAsset(base(), fetcher);
  await requestWalletTestAsset(base({ target: 'reserve' }), fetcher);
  await requestWalletTestAsset(base({ target: 'account', counterpartyId: `0x${'44'.repeat(32)}` }), fetcher);
  expect(observed).toEqual([
    { url: 'http://wallet.test/api/faucet/erc20', body: { userAddress: `0x${'33'.repeat(20)}`, tokenSymbol: 'USDC', amount: '100' } },
    { url: 'http://wallet.test/api/faucet/reserve', body: { userEntityId: `0x${'11'.repeat(32)}`, tokenId: 1, tokenSymbol: 'USDC', amount: '100' } },
    { url: 'http://wallet.test/api/faucet/offchain', body: { userEntityId: `0x${'11'.repeat(32)}`, userRuntimeId: `0x${'22'.repeat(32)}`, hubEntityId: `0x${'44'.repeat(32)}`, tokenId: 1, amount: '100' } },
  ]);
});

test('test-asset ingress rejects missing registered-token and account boundaries before fetch', async () => {
  let requests = 0;
  const fetcher = (async () => { requests += 1; return new Response(); }) as typeof fetch;
  await expect(requestWalletTestAsset(base({ target: 'reserve', tokenId: null }), fetcher)).rejects.toThrow('WALLET_FAUCET_REGISTERED_TOKEN_REQUIRED');
  await expect(requestWalletTestAsset(base({ target: 'account', counterpartyId: null }), fetcher)).rejects.toThrow('WALLET_FAUCET_ACCOUNT_REQUIRED');
  expect(requests).toBe(0);
});

test('test-asset ingress preserves server rejection text', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ success: false, error: 'faucet-disabled' }), { status: 404 })) as typeof fetch;
  await expect(requestWalletTestAsset(base(), fetcher)).rejects.toThrow('faucet-disabled');
});
