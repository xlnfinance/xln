import { expect, test } from 'bun:test';

import {
  createPaymentSpotlightStore,
  type PaymentSpotlight,
} from '../../../frontend/src/lib/stores/network/paymentSpotlightStore';

const OWNER_A = `0x${'11'.repeat(32)}:0x${'aa'.repeat(32)}`;
const OWNER_B = `0x${'22'.repeat(32)}:0x${'bb'.repeat(32)}`;

const show = (store: ReturnType<typeof createPaymentSpotlightStore>, ownerKey: string, ownerHeight = 10) => {
  store.show({ ownerKey, ownerHeight, title: 'Paid', amountLine: '25 USDC', duration: 0 });
};

test('clears a spotlight on owner switch or owner rollback', () => {
  const store = createPaymentSpotlightStore();
  let current: PaymentSpotlight | null = null;
  const unsubscribe = store.subscribe((value) => { current = value; });
  show(store, OWNER_A);
  store.retainForOwner(OWNER_A, 10);
  expect(current?.ownerKey).toBe(OWNER_A);

  store.retainForOwner(OWNER_B, 10);
  expect(current).toBeNull();

  show(store, OWNER_A);
  store.retainForOwner(OWNER_A, 6);
  expect(current).toBeNull();
  unsubscribe();
});
