import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from '../../../../ui/node_modules/react-dom/server';
import { LendingPositionSummary } from '../../../../ui/src/components/LendingPositionSummary';
import type { LendingState } from '../../../../ui/src/runtime/financial/lending';
import { asTokenDecimals, asTokenId } from '../../../account/tx/units';

const hub = `0x${'22'.repeat(32)}`;
const state: LendingState = {
  hubEntityId: hub, requestId: null, requestStatus: null, terms: [], facilities: [],
  totals: { savingsPrincipal: 100_000_000n, loanPrincipal: 100_000_000n, activePrincipal: 100_000_000n },
  savings: [{ positionId: 'lend-1111111111111111', hubEntityId: hub, lenderEntityId: `0x${'11'.repeat(32)}`,
    tokenId: 1, principalAmount: 100_000_000n, closeAmount: 101_000_000n, matured: true,
    rateExpiresAt: null, interestBps: 100, termId: '1d', status: 'closed', updatedAt: 1_000 }],
  loans: [{ loanId: 'loan-1111111111111111', hubEntityId: hub, borrowerEntityId: `0x${'11'.repeat(32)}`,
    tokenId: 1, principalAmount: 100_000_000n, repaymentAmount: 101_000_000n, repaidAmount: 50_000_000n,
    accruedAt: 1_000, accruedInterest: 0n, interestRemainder: 0n, interestBps: 100, termId: '1d',
    dueAt: 86_401_000, openedAt: 1_000, termMs: 86_400_000, lateMs: 0, status: 'repaid' }],
};


const catalog = [
  { tokenId: asTokenId(1), symbol: 'USDC', name: 'Dollar', decimals: asTokenDecimals(6) },
  { tokenId: asTokenId(2), symbol: 'ETH', name: 'Ether', decimals: asTokenDecimals(18) },
];
for (const row of [...state.savings, ...state.loans]) test(`token switch preserves ${'loanId' in row ? 'loan' : 'savings'} units`, () => {
  const render = (selectedTokenId: number) => {
    const props = { row, catalog, selectedTokenId };
    return renderToStaticMarkup(<LendingPositionSummary {...props} />);
  };
  expect(render(1)).toContain('100.00 USDC');
  expect(render(2)).toContain('100.00 USDC');
});
