import { describe, expect, test } from 'bun:test';

import { deriveTransferOffdeltaChange } from '../account/delta-movement';
import { deriveSwapOffdeltaChanges } from '../orderbook/swap-execution';

describe('canonical Account delta movement', () => {
  test('uses one direction rule for payment and HTLC transfers', () => {
    expect(deriveTransferOffdeltaChange(true, 7n)).toBe(-7n);
    expect(deriveTransferOffdeltaChange(false, 7n)).toBe(7n);
    expect(() => deriveTransferOffdeltaChange(true, -1n)).toThrow('TRANSFER_AMOUNT_NEGATIVE');
  });

  test('derives both swap legs from the same transfer rule', () => {
    expect(deriveSwapOffdeltaChanges(true, 10n, 30n)).toEqual({ give: -10n, want: 30n });
    expect(deriveSwapOffdeltaChanges(false, 10n, 30n)).toEqual({ give: 10n, want: -30n });
  });
});
