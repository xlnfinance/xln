import { expect, test } from 'bun:test';

import {
  createPaymentSpotlightStore,
  type PaymentSpotlight,
} from '../../frontend/src/lib/stores/paymentSpotlightStore';

const OWNER_A = `0x${'11'.repeat(32)}:0x${'aa'.repeat(32)}`;
const OWNER_B = `0x${'22'.repeat(32)}:0x${'bb'.repeat(32)}`;

const show = (store: ReturnType<typeof createPaymentSpotlightStore>, ownerKey: string) => {
  store.show({ ownerKey, title: 'Paid', amountLine: '25 USDC', duration: 0 });
};

test('clears a spotlight on owner switch or owner rollback', () => {
  const store = createPaymentSpotlightStore();
  let current: PaymentSpotlight | null = null;
  const unsubscribe = store.subscribe((value) => { current = value; });
  show(store, OWNER_A);
  store.retainForOwner(OWNER_A);
  expect(current?.ownerKey).toBe(OWNER_A);

  store.retainForOwner(OWNER_B);
  expect(current).toBeNull();

  show(store, OWNER_A);
  store.retainForOwner(OWNER_A, true);
  expect(current).toBeNull();
  unsubscribe();
});
