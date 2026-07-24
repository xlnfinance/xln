import { describe, expect, test } from 'bun:test';

import { deriveJurisdictionSignerIndex } from '../jurisdiction/signer-derivation';

describe('jurisdiction signer derivation', () => {
  test('is canonical across case and whitespace', () => {
    const expected = deriveJurisdictionSignerIndex('Ethereum Sepolia');
    expect(deriveJurisdictionSignerIndex(' ethereum sepolia ')).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(100_000);
    expect(expected).toBeLessThan(1_100_000);
  });

  test('keeps named jurisdictions on separate deterministic paths', () => {
    expect(deriveJurisdictionSignerIndex('Ethereum Sepolia')).not.toBe(
      deriveJurisdictionSignerIndex('Tron'),
    );
  });

  test('rejects an absent jurisdiction instead of deriving an ambiguous signer', () => {
    expect(() => deriveJurisdictionSignerIndex(' ')).toThrow(
      'Jurisdiction is required for jurisdiction signer derivation',
    );
  });
});
