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

test('incoming payments do not open or replace a receipt without user action', () => {
  const store = createPaymentSpotlightStore();
  let receipt: PaymentSpotlight | null = null;
  const unsubscribe = store.opened.subscribe(value => { receipt = value; });
  show(store, OWNER_A, 10);
  expect(receipt).toBeNull();
  store.open();
  expect(receipt?.ownerHeight).toBe(10);
  show(store, OWNER_A, 11);
  expect(receipt?.ownerHeight).toBe(10);
  store.retainForOwner(OWNER_B, 11);
  expect(receipt).toBeNull();
  store.clear();
  unsubscribe();
});
