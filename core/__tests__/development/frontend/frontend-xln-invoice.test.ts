import { describe, expect, test } from 'bun:test';

import { buildWalletPayHref, buildXlnInvoiceDeepLink, parseXlnInvoice } from '../../../../frontend/src/lib/utils/xlnInvoice';

const TARGET = `0x${'ab'.repeat(32)}`;
const PAYLOAD = encodeURIComponent(`${TARGET}?token=1&amount=5&desc=Local+payment`);

describe('xln invoice URL policy', () => {
  test('accepts HTTP only for an exact loopback host', () => {
    expect(parseXlnInvoice(`http://127.0.0.1:8080/app#pay/${PAYLOAD}`)).toMatchObject({
      targetEntityId: TARGET,
      tokenId: 1,
      amount: '5',
      description: 'Local payment',
    });
    expect(parseXlnInvoice(`http://localhost:8080/app#pay/${PAYLOAD}`).amount).toBe('5');
    expect(() => parseXlnInvoice(`http://xln.finance/app#pay/${PAYLOAD}`)).toThrow('Unsupported invoice format');
    expect(() => parseXlnInvoice(`http://127.0.0.1.evil.test/app#pay/${PAYLOAD}`)).toThrow('Unsupported invoice format');
  });

  test('round-trips canonical xln app invoice links', () => {
    const link = buildXlnInvoiceDeepLink({
      targetEntityId: TARGET,
      tokenId: 1,
      amount: '5',
      description: 'Local payment',
    });
    expect(link).toBe(`xln://pay/${TARGET}?token=1&amount=5&desc=Local+payment`);
    expect(parseXlnInvoice(link)).toMatchObject({
      source: 'app-url',
      targetEntityId: TARGET,
      tokenId: 1,
      amount: '5',
      description: 'Local payment',
    });
  });
});


test('payment links preserve the local wallet origin and entry path while public links stay canonical', () => {
  const intent = { targetEntityId: TARGET, tokenId: 1, amount: '5' };
  for (const href of ['http://localhost:5183/receive', 'http://127.0.0.1:8081/app#accounts/receive']) {
    const link = buildWalletPayHref(intent, href);
    expect(new URL(link).origin).toBe(new URL(href).origin);
    expect(new URL(link).pathname).toBe(new URL(href).pathname);
    expect(parseXlnInvoice(link)).toMatchObject({ targetEntityId: TARGET, tokenId: 1, amount: '5' });
  }
  for (const href of ['', 'https://xln.finance/ui/receive', 'https://example.test/app', 'http://localhost.evil.test/app']) {
    expect(new URL(buildWalletPayHref(intent, href)).origin).toBe('https://xln.finance');
    expect(new URL(buildWalletPayHref(intent, href)).pathname).toBe('/app');
  }
});

test('both wallets reject conflicting description attribution when a custody user is supplied', () => {
  for (const description of ['uid:bob', 'Lunch uid:bob', 'Lunch|uid:bob', 'Lunch\tuid:bob', 'uid:bob | uid:alice']) {
    const params = new URLSearchParams({ target: TARGET, desc: description, u: 'alice' });
    expect(() => parseXlnInvoice(`xln://pay?${params}`)).toThrow('Invoice description contains custody attribution');
  }
  expect(parseXlnInvoice(`xln://pay?target=${TARGET}&desc=fluid:ok&u=alice`).recipientUserId).toBe('alice');
  expect(parseXlnInvoice(`xln://pay?target=${TARGET}&desc=uid:bob`).description).toBe('uid:bob');
});

test('custody uid is validated before whitespace normalization or truncation', () => {
  for (const uid of ['', ' alice', 'alice ', 'ali\nce', 'ali ce', 'alice|uid:bob', 'alice:bob', 'álîce', 'a'.repeat(97)]) {
    const params = new URLSearchParams({ target: TARGET, u: uid });
    expect(() => parseXlnInvoice(`xln://pay?${params}`)).toThrow();
  }
  for (const uid of ['alice', 'Alice_09-z', 'a'.repeat(96)]) {
    expect(parseXlnInvoice(`xln://pay?target=${TARGET}&u=${uid}`).recipientUserId).toBe(uid);
  }
});
