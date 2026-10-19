import { expect, test } from 'bun:test';
import { decodeLendingState } from '../lending';

const hubEntityId = `0x${'11'.repeat(32)}`;
const response = () => ({
  hubEntityId,
  requestId: null,
  requestStatus: null,
  savings: [],
  loans: [],
  terms: [],
  facilities: [],
  totals: { savingsPrincipalAmount: '900719925474099312345', loanPrincipalAmount: '0', activePrincipalAmount: '0' },
});

test('current lending response preserves exact monetary units beyond Number precision', () => {
  const state = decodeLendingState(response(), { hubEntityId });
  expect(state.totals).toEqual({ savingsPrincipal: 900719925474099312345n, loanPrincipal: 0n, activePrincipal: 0n });
});

test.each([undefined, null, '', 'garbage', '-1', '1.5', '1e3', '+1', '01', 1, {}, []].map(value => ({ value })))(
  'required lending totals reject malformed or noncanonical money %j',
  ({ value }) => {
    const result = response();
    expect(() =>
      decodeLendingState({ ...result, totals: { ...result.totals, savingsPrincipalAmount: value } }, { hubEntityId }),
    ).toThrow('LENDING_MONEY_INVALID:totals.savingsPrincipalAmount');
  },
);

const pool = {
  positionId: 'lend-1111111111111111',
  hubEntityId,
  lenderEntityId: hubEntityId,
  tokenId: 1,
  principalAmount: '100',
  closeAmount: '101',
  matured: true,
  interestBps: 100,
  termId: '1h',
  status: 'closed',
  updatedAt: 1,
};
const loan = {
  loanId: 'loan-1111111111111111',
  hubEntityId,
  borrowerEntityId: hubEntityId,
  tokenId: 1,
  principalAmount: '100',
  accruedAt: 1,
  accruedInterest: '1',
  interestRemainder: '0',
  repaymentAmount: '101',
  repaidAmount: '1',
  interestBps: 100,
  termId: '1h',
  dueAt: 3600001,
  openedAt: 1,
  termMs: 3600000,
  lateMs: 0,
  status: 'active',
};

test('all current position money remains exact; missing or negative fields cannot become zero', () => {
  const result = { ...response(), savings: [pool], loans: [loan] };
  const decoded = decodeLendingState(result, { hubEntityId });
  expect(decoded.savings[0]?.closeAmount).toBe(101n);
  expect(decoded.loans[0]?.repaidAmount).toBe(1n);
  for (const field of ['principalAmount', 'closeAmount']) {
    for (const value of [undefined, '-1', 'bad']) {
      expect(() => decodeLendingState({ ...result, savings: [{ ...pool, [field]: value }] }, { hubEntityId })).toThrow(
        `LENDING_MONEY_INVALID:pool.${field}`,
      );
    }
  }
  for (const field of ['principalAmount', 'accruedInterest', 'interestRemainder', 'repaymentAmount', 'repaidAmount']) {
    for (const value of [undefined, '-1', 'bad']) {
      expect(() => decodeLendingState({ ...result, loans: [{ ...loan, [field]: value }] }, { hubEntityId })).toThrow(
        `LENDING_MONEY_INVALID:loan.${field}`,
      );
    }
  }
  expect(() => decodeLendingState({ ...result, totals: undefined }, { hubEntityId })).toThrow(
    'LENDING_RECORD_INVALID:totals',
  );
});
