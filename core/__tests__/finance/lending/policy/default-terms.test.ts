import { expect, test } from 'bun:test';
import { handleLendingPolicy } from '../../../../entity/tx/handlers/payments/lending-policy';
import { validateEntityTx } from '../../../../entity/tx-validation';
import { buildDefaultBankTermsTxs } from '../../../../lendbook/default-terms';
import { bankSavingsAdmissionError, validateLendingPolicies } from '../../../../lendbook/policy';
import { LENDING_YEAR_MS } from '../../../../protocol/dispute/lending-covenant';
import type { AccountTx } from '../../../../types/account';
import { addr, entity, makeJurisdiction, makeState } from '../../../helpers/cross-j';

const BANK = entity('11');
const SAVER = entity('22');
const jurisdiction = makeJurisdiction('default-bank-terms', 31337, 'dd', 'ee');
const domain = { chainId: 31337, depositoryAddress: addr('dd') };

const bank = () => {
  const state = makeState(BANK, addr('33'), jurisdiction, SAVER);
  state.profile = { ...state.profile, isHub: true };
  return state;
};

const fund = (termId: 'demand' | '1m', interestBps: number): AccountTx => ({
  type: 'lending_fund',
  data: { positionId: 'lend-1111111111111111', hubEntityId: BANK, lenderEntityId: SAVER, tokenId: 2, amount: 10n, termId, interestBps },
});

test('default bank terms cover every token and term through the canonical policy handler', () => {
  const state = bank();
  const txs = buildDefaultBankTermsTxs(domain, [1, 2, 3], state.timestamp);
  expect(txs).toHaveLength(12);
  for (const tx of txs) {
    validateEntityTx(tx, 'DEFAULT_BANK_TERMS');
    if (tx.type !== 'lendingSetTerms') throw new Error('UNEXPECTED_TX');
    handleLendingPolicy(state, tx, true);
  }
  const terms = state.lending!.terms!;
  expect(terms.size).toBe(12);
  validateLendingPolicies(state.lending as unknown as Record<string, unknown>);
  for (const value of terms.values()) {
    expect(value.expiresAt).toBe(state.timestamp + LENDING_YEAR_MS);
    if (value.termId === 'demand') expect(value.loanInterestBps).toBe(0);
    else expect(value.loanInterestBps).toBeGreaterThan(value.savingsInterestBps);
  }
  const account = state.accounts.get(SAVER)!;
  expect(bankSavingsAdmissionError(state, account, fund('demand', 300), state.timestamp)).toBeUndefined();
  expect(bankSavingsAdmissionError(state, account, fund('1m', 30), state.timestamp)).toBeUndefined();
  expect(bankSavingsAdmissionError(state, account, fund('demand', 301), state.timestamp)).toBe('LENDING_SAVINGS_RATE_NOT_APPROVED');
});

test('withdrawn terms (expired now) stop new savings', () => {
  const state = bank();
  const [demand] = buildDefaultBankTermsTxs(domain, [2], state.timestamp);
  if (demand?.type !== 'lendingSetTerms') throw new Error('UNEXPECTED_TX');
  handleLendingPolicy(state, { ...demand, data: { ...demand.data, expiresAt: state.timestamp } }, true);
  const account = state.accounts.get(SAVER)!;
  expect(bankSavingsAdmissionError(state, account, fund('demand', 300), state.timestamp)).toBe('LENDING_BANK_TERMS_UNAVAILABLE');
});

test('default bank terms refuse an unset clock', () => {
  expect(() => buildDefaultBankTermsTxs(domain, [1], 0)).toThrow('DEFAULT_BANK_TERMS_CLOCK_INVALID:0');
});
