import { expect, test } from 'bun:test';

import { buildWalletPaymentCommand } from '../../frontend/packages/runtime-client/wallet-payment-input-adapter';

const SOURCE = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;
const TARGET = `0x${'33'.repeat(32)}`;

test('builds one exact direct payment RuntimeInput without floating-point math', () => {
  const command = buildWalletPaymentCommand({
    entityId: SOURCE,
    signerId: 'signer',
    targetEntityId: TARGET,
    tokenId: 1,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    amountInput: '7.000001',
    route: [SOURCE, TARGET],
    deliveryMode: 'direct',
    totalFee: 0n,
    description: 'invoice 42',
  });
  expect(command.preview.amountRaw).toBe('7000001');
  expect(command.input.entityInputs).toHaveLength(1);
  expect(command.input.entityInputs?.[0]?.entityTxs).toEqual([{
    type: 'directPayment',
    data: {
      targetEntityId: TARGET,
      tokenId: 1,
      amount: 7_000_001n,
      route: [SOURCE, TARGET],
      deliveryMode: 'direct',
      description: 'invoice 42',
    },
  }]);
});

test('preserves trusted and HTLC modes as distinct canonical operations', () => {
  const base = {
    entityId: SOURCE,
    signerId: 'signer',
    targetEntityId: TARGET,
    tokenId: 1,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    amountInput: '1',
    totalFee: 0n,
  } as const;
  expect(buildWalletPaymentCommand({
    ...base, route: [SOURCE, HUB, TARGET], deliveryMode: 'trusted',
  }).input.entityInputs?.[0]?.entityTxs[0]).toMatchObject({
    type: 'directPayment', data: { deliveryMode: 'trusted', trustedGatewayEntityId: HUB },
  });
  expect(buildWalletPaymentCommand({
    ...base, route: [SOURCE, HUB, TARGET], deliveryMode: 'instant', totalFee: 1n,
  }).input.entityInputs?.[0]?.entityTxs[0]).toMatchObject({
    type: 'htlcPayment', data: { deliveryMode: 'instant' },
  });
});

test('rejects zero, overprecision, malformed routes, and invalid trusted fees', () => {
  const base = {
    entityId: SOURCE, signerId: 'signer', targetEntityId: TARGET,
    tokenId: 1, tokenSymbol: 'USDC', tokenDecimals: 6,
    route: [SOURCE, TARGET], deliveryMode: 'direct' as const, totalFee: 0n,
  };
  expect(() => buildWalletPaymentCommand({ ...base, amountInput: '0' })).toThrow('TOKEN_AMOUNT_NOT_POSITIVE');
  expect(() => buildWalletPaymentCommand({ ...base, amountInput: '0.0000001' })).toThrow('TOKEN_AMOUNT_PRECISION_EXCEEDED');
  expect(() => buildWalletPaymentCommand({ ...base, amountInput: '1', route: [TARGET, SOURCE] })).toThrow('ROUTE_ENDPOINT_MISMATCH');
  expect(() => buildWalletPaymentCommand({
    ...base, amountInput: '1', route: [SOURCE, HUB, TARGET], deliveryMode: 'trusted', totalFee: 1n,
  })).toThrow('TRUSTED_ROUTE_INVALID');
});
