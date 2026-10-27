import { expect, test } from 'bun:test';
import { bankOfferFor } from '../../../ui/src/runtime/financial/lending';

const domain = { chainId: 31337, depositoryAddress: `0x${'dd'.repeat(20)}` };
const terms = (expiresAt: number) => ({
  ...domain, tokenId: 1, termId: '1d' as const, savingsInterestBps: 1, loanInterestBps: 2, loanLateMs: 86_400_000, expiresAt,
});

test('wallet distinguishes an active offer, a bank that does not lend, and no offer yet', () => {
  expect(bankOfferFor([terms(2_000)], domain, 1, '1d', 1_000)).toEqual({ kind: 'active', terms: terms(2_000) });
  expect(bankOfferFor([terms(0)], domain, 1, '1d', 1_000)).toEqual({ kind: 'not-lending' });
  expect(bankOfferFor([terms(2_000)], domain, 1, '1m', 1_000)).toEqual({ kind: 'none' });
  expect(bankOfferFor([terms(2_000)], { ...domain, chainId: 1 }, 1, '1d', 1_000)).toEqual({ kind: 'none' });
  expect(bankOfferFor([], domain, 1, '1d', 1_000)).toEqual({ kind: 'none' });
});
