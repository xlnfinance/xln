import { expect, test } from 'bun:test';
import { applyCommand, commitBookOverlay, createBook, getBookOrder, resumeCrossedBook, type BookState } from '../../swapbook';
import { getSwapExactQuoteLotMultipleAtPriceForDimensions } from '../../swapbook/types';

const options = { executionQtyMultipleAtPrice: (price: bigint) => getSwapExactQuoteLotMultipleAtPriceForDimensions(6, 6, price) };
const add = (book: BookState, id: string, side: 0 | 1, price: bigint, qty: bigint, suspended = false) =>
  applyCommand(book, { kind: 0, orderId: id, ownerId: id, side, priceTicks: price, qtyLots: qty, tif: 0, postOnly: false },
    { ...options, ...(suspended ? { makerDisposition: () => 'suspended' as const } : {}) });
const empty = () => createBook({ maxOrders: 16, bucketWidthTicks: 1, stpPolicy: 1 });

test.each([2n, 4n])('resumed taker rounds its remainder to its own price lot: %s', qty => {
  let book = commitBookOverlay(add(empty(), 'ask', 1, 10000n, 1n).state);
  book = commitBookOverlay(add(book, 'bid', 0, 15000n, qty, true).state);
  const result = resumeCrossedBook(book, options);
  expect(result).not.toBeNull();
  if (!result) throw new Error('missing resume');
  expect(getBookOrder(result.state, 'bid')?.qtyLots ?? 0n).toBe(qty - 2n);
});

test('zero fill at best price does not hide an executable later price level', () => {
  let book = commitBookOverlay(add(empty(), 'dust-price', 1, 15000n, 2n).state);
  book = commitBookOverlay(add(book, 'exact-price', 1, 20000n, 1n).state);
  const result = add(book, 'bid', 0, 20000n, 1n);
  expect(result.events.filter(event => event.type === 'TRADE').map(event => event.makerOrderId)).toEqual(['exact-price']);
  expect(getBookOrder(result.state, 'bid')).toBeNull();
  expect(getBookOrder(result.state, 'dust-price')?.qtyLots).toBe(2n);
});
