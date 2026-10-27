import { lendingLoanMaximumAmount } from '@xln/core/lendbook/state';
import { formatAmount, formatMoney } from '../runtime/format';
import { isLendingLoanRepayable, type LendingLoan, type LendingSavings } from '../runtime/financial/lending';
import { tokenCatalogMeta } from '../runtime/financial/swap-assets/metadata';
import type { TokenCatalogEntry } from '../runtime/token-meta';

const rate = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

export function LendingPositionSummary({ row, catalog }: {
  row: LendingLoan | LendingSavings; catalog: readonly TokenCatalogEntry[];
}) {
  // A displayed claim always owns its units, even while another asset is loading.
  const meta = tokenCatalogMeta(catalog, row.tokenId);
  if ('loanId' in row) {
    const loan = row;
    return (
      <span className="tx">
        <span className="t">{formatMoney(loan.principalAmount, meta.decimals)} {meta.symbol}</span>
        <span className="s">
          {loan.termId} · {rate(loan.interestBps)} · {loan.status} · due {loan.dueAt ? new Date(loan.dueAt).toLocaleString() : '—'} · repaid{' '}
          {formatMoney(loan.repaidAmount, meta.decimals)} of {formatMoney(loan.repaymentAmount, meta.decimals)}
        {isLendingLoanRepayable(loan) && <> · Repay authorizes up to {formatAmount(lendingLoanMaximumAmount(loan), meta.decimals, meta.decimals)} {meta.symbol}; only the amount due at confirmation is debited.</>}
        </span>
      </span>
    );
  }
  const pool = row;
  return (
      <span className="tx">
        <span className="t">{formatMoney(pool.principalAmount, meta.decimals)} {meta.symbol}</span>
        <span className="s">
          {pool.termId === 'demand' ? 'On demand' : pool.termId} · {rate(pool.interestBps)}{pool.termId === 'demand' ? ' per year' : ''} · {pool.status} · {formatMoney(pool.closeAmount, meta.decimals)} claim
        </span>
      </span>
  );
}
