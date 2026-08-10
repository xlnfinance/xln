import { describe, expect, test } from 'bun:test';
import { buildOpenHubAccountInput } from '../lib/actions/open-account';
import { buildPaymentInput } from '../lib/actions/pay';
import { buildMoveInput } from '../lib/actions/move';
import { buildReceiveInvoice } from '../lib/actions/pay';
import { normalizeNativeDeepLinkPath } from '../../frontend/src/lib/native/deeplink';
import { parseXlnInvoice } from '../../frontend/src/lib/utils/xlnInvoice';

describe('cli action builders', () => {
  test('openAccount runtime input shape', () => {
    const input = buildOpenHubAccountInput({
      sourceEntityId: '0xaaa',
      signerId: '0xsigner',
      hubEntityId: '0xhub',
      creditAmount: 100n,
      tokenId: 1,
    });
    expect(input.entityInputs[0]?.entityTxs[0]?.type).toBe('openAccount');
    expect(input.entityInputs[0]?.entityTxs[0]?.data).toMatchObject({
      targetEntityId: '0xhub',
      tokenId: 1,
    });
  });

  test('direct payment vs htlc payment', () => {
    const direct = buildPaymentInput({
      entityId: '0xa',
      signerId: '0xs',
      targetEntityId: '0xb',
      amount: 5n,
      tokenId: 1,
      route: ['0xa', '0xb'],
      deliveryMode: 'direct',
    });
    expect(direct.entityInputs[0]?.entityTxs[0]?.type).toBe('directPayment');

    const htlc = buildPaymentInput({
      entityId: '0xa',
      signerId: '0xs',
      targetEntityId: '0xc',
      amount: 5n,
      tokenId: 1,
      route: ['0xa', '0xb', '0xc'],
      deliveryMode: 'instant',
    });
    expect(htlc.entityInputs[0]?.entityTxs[0]?.type).toBe('htlcPayment');
  });

  test('move builders', () => {
    const r2c = buildMoveInput({
      entityId: '0xa',
      signerId: '0xs',
      kind: 'r2c',
      tokenId: 1,
      amount: 9n,
      counterpartyId: '0xb',
    });
    expect(r2c.entityInputs[0]?.entityTxs[0]?.type).toBe('r2c');
  });
});

test('CLI receive links round-trip through canonical frontend parsers', () => {
  const entityId = `0x${'ab'.repeat(32)}`;
  const invoice = buildReceiveInvoice({
    entityId,
    settings: { apiBase: 'https://xln.finance' },
  } as never);
  const [, nativeLink, webLink] = invoice.split('\n');

  expect(normalizeNativeDeepLinkPath(nativeLink!)).toBe(`/app#pay/${encodeURIComponent(entityId)}`);
  expect(parseXlnInvoice(nativeLink!).targetEntityId).toBe(entityId);
  expect(parseXlnInvoice(webLink!).targetEntityId).toBe(entityId);
});
