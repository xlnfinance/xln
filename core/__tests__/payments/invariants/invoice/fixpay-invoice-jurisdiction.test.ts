import { expect, test } from 'bun:test';
import { parseXlnInvoice } from '../../../../../frontend/src/lib/utils/xlnInvoice';
import * as payIntent from '../../../../../ui/src/screens/pay-intent';
import { nativeInvoiceJurisdictionKeys } from '../../../../../ui/src/native/payment-request';

const raw = `xln://pay?target=0x${'22'.repeat(32)}`;

test('fixpay-8 rendering a scoped invoice is pure across jurisdiction switches', () => {
  const invoice = parseXlnInvoice(`${raw}&jId=tron&desc=Lunch&u=alice`);
  expect(payIntent.invoiceNote(invoice)).toEqual({ description: 'Lunch | uid:alice', locked: true });
});

test('fixpay-8 apply and send reject another network, including after a wallet switch', () => {
  const invoice = parseXlnInvoice(`${raw}&jId=tron`);
  expect(() => payIntent.assertInvoiceJurisdiction(invoice, ['tron'])).not.toThrow();
  expect(() => payIntent.assertInvoiceJurisdiction(invoice, ['sepolia'])).toThrow('jurisdiction');
  expect(() => payIntent.assertInvoiceJurisdiction(invoice, [])).toThrow('jurisdiction');
});

test('fixpay-8 web accepts the same name, stack identity and contract-bound catalog keys as native', () => {
  const depository = `0x${'ab'.repeat(20)}`;
  const identity = `stack:31337:${depository}`;
  const entry = { key: 'evm', name: 'Testnet', chainId: 31337, rpcUrl: '/rpc', blockTimeMs: 1000,
    entityProviderDeploymentBlock: 1, contracts: { depository, entityProvider: depository,
      account: depository, deltaTransformer: depository } };
  const keys = nativeInvoiceJurisdictionKeys(identity, [entry, { ...entry, key: 'other', chainId: 31338 }]);
  const accepted = ['Testnet', identity, ...keys];
  for (const key of accepted) {
    expect(() => payIntent.assertInvoiceJurisdiction(parseXlnInvoice(`${raw}&jId=${key}`), accepted)).not.toThrow();
  }
  expect(() => payIntent.assertInvoiceJurisdiction(parseXlnInvoice(`${raw}&jId=other`), accepted)).toThrow('jurisdiction');
});
