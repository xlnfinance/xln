import { expect, test } from 'bun:test';

import type { RuntimeAdapterPaymentRoute } from '../../runtime/api/runtime-adapter/types';
import {
  projectWalletPaymentRoutes,
  walletPaymentRouteErrorText,
} from '../../frontend/apps/wallet/src/features/payments/wallet-payment-routes';

const SOURCE = `0x${'11'.repeat(32)}`;
const HUB_A = `0x${'22'.repeat(32)}`;
const HUB_B = `0x${'33'.repeat(32)}`;
const TARGET = `0x${'44'.repeat(32)}`;

const route = (
  path: string[],
  totalFee: string,
  probability: number,
): RuntimeAdapterPaymentRoute => ({
  path,
  hops: path.slice(0, -1).map((from, index) => ({
    from,
    to: path[index + 1]!,
    fee: index === 0 ? totalFee : '0',
    feePPM: 0,
  })),
  totalFee,
  senderAmount: (7n + BigInt(totalFee)).toString(),
  recipientAmount: '7',
  probability,
});

test('projects canonical routes in fee, probability, and path order', () => {
  const routes = projectWalletPaymentRoutes({
    response: { routes: [
      route([SOURCE, HUB_B, TARGET], '2', 0.9),
      route([SOURCE, HUB_A, TARGET], '1', 0.7),
      route([SOURCE, HUB_B, TARGET], '1', 0.8),
    ] },
    sourceEntityId: SOURCE,
    targetEntityId: TARGET,
    recipientAmount: 7n,
    deliveryMode: 'instant',
  });

  expect(routes.map(candidate => [candidate.path[1], candidate.totalFee, candidate.probability])).toEqual([
    [HUB_B, 1n, 0.8],
    [HUB_A, 1n, 0.7],
    [HUB_B, 2n, 0.9],
  ]);
});

test('delivery modes filter canonical routes without inventing alternatives', () => {
  const response = { routes: [
    route([SOURCE, TARGET], '0', 1),
    route([SOURCE, HUB_A, TARGET], '0', 0.9),
    route([SOURCE, HUB_B, TARGET], '1', 0.8),
  ] };
  const project = (deliveryMode: 'direct' | 'trusted') => projectWalletPaymentRoutes({
    response,
    sourceEntityId: SOURCE,
    targetEntityId: TARGET,
    recipientAmount: 7n,
    deliveryMode,
  });

  expect(project('direct').map(candidate => candidate.path)).toEqual([[SOURCE, TARGET]]);
  expect(project('trusted').map(candidate => candidate.path)).toEqual([[SOURCE, HUB_A, TARGET]]);
});

test('rejects inconsistent route amounts loudly', () => {
  const malformed = route([SOURCE, HUB_A, TARGET], '1', 0.9);
  malformed.senderAmount = '99';
  expect(() => projectWalletPaymentRoutes({
    response: { routes: [malformed] },
    sourceEntityId: SOURCE,
    targetEntityId: TARGET,
    recipientAmount: 7n,
    deliveryMode: 'instant',
  })).toThrow('WALLET_PAYMENT_ROUTE_AMOUNT_MISMATCH');
});

test('maps canonical no-route errors to the user-facing capacity boundary', () => {
  expect(walletPaymentRouteErrorText(new Error(`no payment route from ${SOURCE} to ${TARGET}`)))
    .toBe('No route has enough real capacity for this amount');
  expect(walletPaymentRouteErrorText(new Error('payment route profiles are unavailable')))
    .toBe('payment route profiles are unavailable');
});
