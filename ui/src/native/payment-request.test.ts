import { asTokenDecimals } from '@xln/core/account/tx/units';
import { expect, test } from 'bun:test';
import { buildWalletPayHref, buildXlnInvoiceDeepLink } from '@xln/frontend/lib/utils/xlnInvoice';
import { nativePaymentRequest, nativeInvoiceJurisdictionKeys } from './payment-request';

const target = `0x${'ab'.repeat(32)}`;
const context = {
  defaultToken: 1,
  assets: [{ id: 1, decimals: asTokenDecimals(6) }, { id: 2, decimals: asTokenDecimals(18) }],
  jurisdictions: ['Ethereum'],
  decimalSeparator: '.',
};

test('custody network keys require the same chain and contract, not just a display name', () => {
  const depository = `0x${'ab'.repeat(20)}`;
  const entry = { key: 'arrakis', name: 'Testnet', chainId: 31337, rpcUrl: '/rpc', blockTimeMs: 1000,
    entityProviderDeploymentBlock: 1, contracts: { depository, entityProvider: depository,
      account: depository, deltaTransformer: depository } };
  const catalog = [entry, { ...entry, key: 'wrong-chain', chainId: 31338 },
    { ...entry, key: 'wrong-contract', contracts: { ...entry.contracts, depository: `0x${'cd'.repeat(20)}` } }];
  const keys = nativeInvoiceJurisdictionKeys(`stack:31337:${depository}`, catalog);
  expect(keys).toEqual(['arrakis']);
  expect(nativePaymentRequest(`${target}?jId=arrakis`, { ...context, jurisdictions: keys }).recipient).toBe(target);
  expect(() => nativePaymentRequest(`${target}?jId=wrong-chain`, { ...context, jurisdictions: keys })).toThrow();
});

test('web custody invoice retains exact amount and attribution in the native draft', () => {
  const intent = { targetEntityId: target, tokenId: 1, amount: '12.000001',
    description: 'Custody invoice:inv_demo', recipientUserId: 'egor', jurisdictionId: 'Ethereum' };
  for (const raw of [buildWalletPayHref(intent), buildXlnInvoiceDeepLink(intent)]) {
    const request = nativePaymentRequest(raw, context);
    expect(request.recipient).toBe(target);
    expect(request.amount).toBe('12.000001');
    expect(request.description).toBe('Custody invoice:inv_demo | uid:egor');
    expect(request.tokenLocked).toBe(true);
    expect(nativePaymentRequest(request.raw, context)).toEqual(request);
  }
});

test('localizes invoice decimals without rounding and allows address-only requests', () => {
  const raw = `${target}?token=2&amount=0.000000000000000001`;
  expect(nativePaymentRequest(raw, { ...context, decimalSeparator: ',' }).amount).toBe('0,000000000000000001');
  expect(nativePaymentRequest(target, context)).toMatchObject({ amount: '', token: 1, tokenLocked: false });
});

test('rejects wrong networks, unavailable assets and invalid or excessive amounts', () => {
  for (const query of ['jId=Tron', 'token=99', 'amount=0', 'amount=-1', 'amount=1e6', 'amount=1,000', 'amount=0.0000001'])
    expect(() => nativePaymentRequest(`${target}?${query}`, context)).toThrow();
});

test('rejects unrelated URLs, missing recipients and oversized camera payloads', () => {
  for (const raw of [null, '', 'javascript:alert(1)', `https://evil.example/app#pay/${target}`,
    'xln://pay?amount=1', 'x'.repeat(4097)])
    expect(() => nativePaymentRequest(raw, context)).toThrow();
});

test('never rounds token ids or truncates financial fields in an invoice', () => {
  for (const query of ['token=1.5', 'token=-1', 'token=nope', 'token=1&token=2',
    'amount=1&amount=2', `amount=${'1'.repeat(65)}`, `u=${'a'.repeat(97)}`])
    expect(() => nativePaymentRequest(`${target}?${query}`, context)).toThrow();
});
