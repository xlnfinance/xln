import { expect, test } from 'bun:test';

import { asOfferId, swapKey } from '../../orderbook/swap-keys';

test('swap key constructor validates both canonical Entity and Offer identity', () => {
  const entityId = `0x${'12'.repeat(32)}`;
  expect(swapKey(entityId, 'offer-7')).toBe(`${entityId}:offer-7`);
  expect(asOfferId('offer-7')).toBe('offer-7');
  expect(() => swapKey('0007', 'offer-7')).toThrow('Invalid EntityId');
  expect(() => swapKey(entityId, 'bad:offer')).toThrow('SWAP_OFFER_ID_INVALID');
});
