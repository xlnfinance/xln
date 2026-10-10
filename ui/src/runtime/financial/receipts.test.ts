import { afterEach, expect, test } from 'bun:test';
import { useReceipts } from './receipt-state';
import type { PaymentTerminalEvent } from '@xln/frontend/lib/stores/network/paymentTerminalMonitor';

const event = (height: number): PaymentTerminalEvent => ({
  runtimeId: 'runtime', height, name: 'HtlcReceived',
  data: { amount: '1000000', tokenId: 1, hashlock: `payment-${height}` },
});
afterEach(() => useReceipts.getState().dismiss());

test('committed payments notify without opening a receipt or replacing one the user is reading', () => {
  useReceipts.getState().show(event(10));
  expect(useReceipts.getState().latest?.height).toBe(10);
  expect(useReceipts.getState().opened).toBeNull();
  useReceipts.getState().open();
  expect(useReceipts.getState().latest).toBeNull();
  expect(useReceipts.getState().opened?.height).toBe(10);
  useReceipts.getState().show(event(11));
  expect(useReceipts.getState().latest?.height).toBe(11);
  expect(useReceipts.getState().opened?.height).toBe(10);
  useReceipts.getState().close();
  expect(useReceipts.getState().latest?.height).toBe(11);
  expect(useReceipts.getState().opened).toBeNull();
});

test('owner switch clears both the notification and an explicitly opened receipt', () => {
  useReceipts.getState().show(event(10));
  useReceipts.getState().open();
  useReceipts.getState().show(event(11));
  useReceipts.getState().dismiss();
  expect(useReceipts.getState().latest).toBeNull();
  expect(useReceipts.getState().opened).toBeNull();
});
