import type { AccountStateDomain } from '../types/account';
import type { EntityTx } from '../types/entity-tx';
import type { LendingTermId } from '../types/finance/lending';
import { LENDING_YEAR_MS } from '../protocol/dispute/lending-covenant';
import { LENDING_TERM_MS } from './state';

type DefaultRates = Readonly<{ savingsInterestBps: number; loanInterestBps: number }>;

/**
 * Default bank rates, in basis points per term (demand: per year). Roughly
 * 3-4% a year paid on savings and 7-9% charged on loans; a fixed term uses the
 * smallest whole basis point that keeps a loan non-free. Demand is savings-only.
 */
const DEFAULT_BANK_RATES: Readonly<Record<LendingTermId, DefaultRates>> = {
  demand: { savingsInterestBps: 300, loanInterestBps: 0 },
  '1h': { savingsInterestBps: 0, loanInterestBps: 1 },
  '1d': { savingsInterestBps: 1, loanInterestBps: 2 },
  '1m': { savingsInterestBps: 30, loanInterestBps: 60 },
};
const DEFAULT_TERM_IDS: readonly LendingTermId[] = ['demand', '1h', '1d', '1m'];

/**
 * The `lendingSetTerms` commands a hub publishes once at bootstrap through its
 * own authenticated Entity governance. Terms carry rates only, never amounts;
 * borrowing still requires a separate per-borrower `lendingApprove`.
 * Each offer stays valid for one year from `now` (the Runtime clock).
 */
export const buildDefaultBankTermsTxs = (
  domain: AccountStateDomain,
  tokenIds: readonly number[],
  now: number,
): EntityTx[] => {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error(`DEFAULT_BANK_TERMS_CLOCK_INVALID:${now}`);
  const expiresAt = now + LENDING_YEAR_MS;
  return tokenIds.flatMap(tokenId => DEFAULT_TERM_IDS.map((termId): EntityTx => ({
    type: 'lendingSetTerms',
    data: {
      chainId: domain.chainId,
      depositoryAddress: domain.depositoryAddress,
      tokenId,
      termId,
      ...DEFAULT_BANK_RATES[termId],
      loanLateMs: termId === 'demand' ? 0 : LENDING_TERM_MS[termId],
      expiresAt,
    },
  })));
};
