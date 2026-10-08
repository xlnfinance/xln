import { describe, expect, test } from 'bun:test';
import { humanTitle } from './movement-projection';

describe('humanTitle', () => {
  test('raw runtime event names read as sentences', () => {
    expect(humanTitle('FoundationBootstrapped')).toBe('Foundation bootstrapped');
    expect(humanTitle('reserve_updated')).toBe('Reserve updated');
    expect(humanTitle('ReserveToCollateral')).toBe('Reserve to collateral');
  });

  test('titles that already read as text are kept exactly', () => {
    expect(humanTitle('Account opened')).toBe('Account opened');
    expect(humanTitle('Swap placed')).toBe('Swap placed');
  });
});
