import { expect, test } from 'bun:test';
import { normalizeExternalRecipient } from '../../../frontend/src/lib/components/Entity/move/external-recipient';
import { buildReserveToExternalEoaTx } from '../../../frontend/src/lib/components/Entity/account/entity-action-txs';

const recipient = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
const hex = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';

test('Tron base58 input produces the exact canonical reserve withdrawal recipient', () => {
  const normalized = normalizeExternalRecipient(recipient, 'tron');
  expect(normalized).toBe(hex);
  expect(buildReserveToExternalEoaTx(normalized, 1, 1_000_000n))
    .toEqual(buildReserveToExternalEoaTx(hex, 1, 1_000_000n));
  expect(normalizeExternalRecipient(`41${hex.slice(2)}`, 'tron')).toBe(hex);
});

test('a Tron address is never silently interpreted on another jurisdiction', () => {
  for (const mode of ['rpc', 'browservm', undefined]) {
    expect(() => normalizeExternalRecipient(recipient, mode)).toThrow('Recipient must be a valid EOA address');
  }
  expect(() => normalizeExternalRecipient(recipient.toLowerCase(), 'tron')).toThrow();
  expect(() => normalizeExternalRecipient(`42${hex.slice(2)}`, 'tron')).toThrow();
});
