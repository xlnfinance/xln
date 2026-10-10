import { expect, test } from 'bun:test';
import { getJurisdictionBadgeInfo } from '../../../frontend/src/lib/utils/identity/jurisdictionBadge';

test('Ethereum, TRON mainnet, XLNC and the local test chain have distinct labelled accents', () => {
  const cases = [
    ['Ethereum', 1, 'ethereum'],
    ['TRON Mainnet', 728126428, 'tron'],
    ['XLNC', 391337, 'xlnc'],
    ['Testnet (local anvil)', 31337, 'local'],
  ] as const;
  for (const [name, chain, color] of cases) {
    const badge = getJurisdictionBadgeInfo(name, chain)!;
    expect(badge.className).toBe(color);
    expect(badge.name).not.toBeEmpty();
    expect(badge.symbol).not.toBeEmpty();
  }
  expect(new Set(cases.map(([name, chain]) => getJurisdictionBadgeInfo(name, chain)!.className)).size).toBe(4);
});

test('unknown chains keep their own identity without borrowing an Ethereum mainnet label', () => {
  expect(getJurisdictionBadgeInfo('Other Mainnet', 987654)?.className).toBe('generic');
  expect(getJurisdictionBadgeInfo('', 987654)?.name).toBe('Chain 987654');
  expect(getJurisdictionBadgeInfo()).toBeNull();
});
