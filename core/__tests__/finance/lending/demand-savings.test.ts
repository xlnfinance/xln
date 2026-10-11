import { expect, test } from 'bun:test';
import {
  makeAccount,
  makeState,
  makeJurisdiction,
  openWritableEntityAccounts,
  entity,
  putTestAccountDelta,
} from '../../helpers/cross-j';
import { demandSavingsRenewals } from '../../../lendbook/renewals';
import { ensureLendingState } from '../../../lendbook/state';
import { lendingTermsKey } from '../../../lendbook/policy';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import {
  assertLendingCovenant,
  assertAccountLendingCovenants,
  lendingCovenantHash,
  lendingExitAmount,
  lendingMaximumAmount,
} from '../../../protocol/dispute/lending-covenant';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import type { AccountReplica, AccountTx } from '../../../types/account';

const SAVER = entity('11');
const BANK = entity('22');
const POSITION = 'lend-1111111111111111';
const YEAR = 365 * 24 * 60 * 60 * 1000;
const claimOf = (account: AccountReplica) => {
  const claim = account.state.subcontracts?.get(POSITION);
  assertLendingCovenant(claim);
  return claim;
};
const funded = async (saverIsLeft: boolean) => {
  const account = makeAccount(SAVER, BANK);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  const result = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'lending_fund',
      data: {
        positionId: POSITION,
        lenderEntityId: saverIsLeft ? SAVER : BANK,
        hubEntityId: saverIsLeft ? BANK : SAVER,
        tokenId: 1,
        amount: 10_000n,
        termId: 'demand',
        interestBps: 500,
      },
    },
    saverIsLeft,
    1_000,
  );
  expect(result.ok).toBe(true);
  expect(() => assertAccountLendingCovenants(account.state)).not.toThrow();
  return account;
};

test('demand funding signs actual-time annual interest in the existing Account covenant', async () => {
  const account = makeAccount(SAVER, BANK);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  const result = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'lending_fund',
      data: {
        positionId: POSITION,
        lenderEntityId: SAVER,
        hubEntityId: BANK,
        tokenId: 1,
        amount: 10_000n,
        termId: 'demand',
        interestBps: 500,
      },
    },
    true,
    1_000,
  );
  expect(result.ok).toBe(true);
  const claim = account.state.subcontracts?.get(POSITION);
  assertLendingCovenant(claim);
  expect(claim.kind).toBe('demand');
  expect(lendingExitAmount(claim, 1_000 + YEAR / 4)).toBe(10_125n);
  expect(lendingExitAmount(claim, 1_000 + YEAR)).toBe(10_500n);
  expect(lendingExitAmount(claim, 1_000 + YEAR * 2)).toBe(10_500n);
});

for (const saverIsLeft of [true, false]) {
  test(`demand rate preserves fractional earnings, rejects replay and pays actual time, saver left=${saverIsLeft}`, async () => {
    const account = await funded(saverIsLeft);
    const hubEntityId = saverIsLeft ? BANK : SAVER;
    const lenderEntityId = saverIsLeft ? SAVER : BANK;
    const before = claimOf(account);
    const rateAt = 1_000 + YEAR / 4 + 1;
    const change: AccountTx = {
      type: 'lending_rate',
      data: {
        positionId: POSITION,
        hubEntityId,
        lenderEntityId,
        tokenId: 1,
        claimHash: lendingCovenantHash(before),
        interestBps: 100,
      },
    };
    const proofBefore = buildAccountProofBody(account, entity('33').slice(0, 42)).proofBodyHash;
    expect((await applyAccountTxToMutableReplica(account, change, !saverIsLeft, rateAt)).ok).toBe(true);
    const renewed = claimOf(account);
    expect(renewed).toMatchObject({
      principal: 10_000n,
      accruedInterest: 125n,
      interestRemainder: 5_000_000n,
      interestBps: 100,
      openedAt: rateAt,
      accruedAt: rateAt,
    });
    expect(lendingExitAmount(renewed, rateAt)).toBe(lendingExitAmount(before, rateAt));
    expect(buildAccountProofBody(account, entity('33').slice(0, 42)).proofBodyHash).not.toBe(proofBefore);
    const root = computeAccountStateRoot(account.state);
    const duplicate = await applyAccountTxToMutableReplica(account, change, !saverIsLeft, rateAt + 1);
    expect(duplicate.ok).toBe(false);
    expect(computeAccountStateRoot(account.state)).toBe(root);
    const close: AccountTx = {
      type: 'lending_close_request',
      data: { positionId: POSITION, hubEntityId, lenderEntityId },
    };
    expect((await applyAccountTxToMutableReplica(account, close, saverIsLeft, rateAt + 1)).ok).toBe(true);
    const newHash = lendingCovenantHash(renewed);
    expect(
      (
        await applyAccountTxToMutableReplica(
          account,
          { ...change, data: { ...change.data, claimHash: newHash } },
          !saverIsLeft,
          rateAt + 2,
        )
      ).ok,
    ).toBe(false);
    // Waiting for liquidity keeps earning under the last signed rate. The bank
    // authorizes a maximum, but the Account debits only the exact payment-time due.
    const paidAt = rateAt + YEAR / 4;
    const payout: AccountTx = {
      type: 'lending_close_payout',
      data: {
        positionId: POSITION,
        hubEntityId,
        lenderEntityId,
        tokenId: 1,
        amount: lendingMaximumAmount(renewed),
      },
    };
    expect(
      (
        await applyAccountTxToMutableReplica(
          account,
          { ...payout, data: { ...payout.data, amount: 10_000n } },
          !saverIsLeft,
          paidAt,
        )
      ).ok,
    ).toBe(false);
    expect((await applyAccountTxToMutableReplica(account, payout, !saverIsLeft, paidAt)).ok).toBe(true);
    expect(account.state.subcontracts?.has(POSITION)).toBe(false);
    expect(account.state.deltas.get(1)?.offdelta).toBe(saverIsLeft ? 150n : -150n);
    expect(() => assertAccountLendingCovenants(account.state)).not.toThrow();
  });
}

test('demand renewal cannot enlarge unsecured exposure above the accepted risk', async () => {
  const account = makeAccount(SAVER, BANK);
  putTestAccountDelta(account, {
    ...account.state.deltas.get(1)!,
    collateral: 10_000n,
    ondelta: 10_000n,
    leftCreditLimit: 0n,
    rightCreditLimit: 500n,
  });
  expect(
    (
      await applyAccountTxToMutableReplica(
        account,
        {
          type: 'lending_fund',
          data: {
            positionId: POSITION,
            lenderEntityId: SAVER,
            hubEntityId: BANK,
            tokenId: 1,
            amount: 10_000n,
            termId: 'demand',
            interestBps: 500,
          },
        },
        true,
        1_000,
      )
    ).ok,
  ).toBe(true);
  const root = computeAccountStateRoot(account.state);
  const result = await applyAccountTxToMutableReplica(
    account,
    {
      type: 'lending_rate',
      data: {
        positionId: POSITION,
        lenderEntityId: SAVER,
        hubEntityId: BANK,
        tokenId: 1,
        claimHash: lendingCovenantHash(claimOf(account)),
        interestBps: 500,
      },
    },
    false,
    1_000 + YEAR / 2,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Unaccepted future risk');
  expect(result.rejection.message).toContain('LENDING_CREDIT_EXPOSURE_EXCEEDED');
  expect(computeAccountStateRoot(account.state)).toBe(root);
});

const bankState = (account: AccountReplica, timestamp: number, interestBps: number) => {
  const state = makeState(BANK, entity('33'), makeJurisdiction('demand', 31_337, 'dd', 'ee'));
  state.timestamp = timestamp;
  openWritableEntityAccounts(state).set(SAVER, account);
  const book = ensureLendingState(state);
  for (const [positionId, value] of account.state.subcontracts ?? []) {
    assertLendingCovenant(value);
    book.savings.set(positionId, {
      positionId,
      hubEntityId: BANK,
      lenderEntityId: SAVER,
      tokenId: 1,
      principalAmount: value.principal,
      interestBps: value.interestBps,
      termId: 'demand',
      termMs: YEAR,
      createdAt: value.openedAt,
      updatedAt: value.openedAt,
      status: 'open',
    });
  }
  const terms = {
    ...account.state.domain,
    tokenId: 1,
    termId: 'demand' as const,
    savingsInterestBps: interestBps,
    loanInterestBps: 0,
    loanLateMs: 0,
    expiresAt: 3 * YEAR,
  };
  book.terms = new Map([[lendingTermsKey(terms), terms]]);
  return state;
};

test('a later renewal in insertion order cannot hide an earlier deadline on the same Account', async () => {
  const account = await funded(true);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 30_000n, ondelta: 20_000n });
  const second = 'lend-2222222222222222';
  expect(
    (
      await applyAccountTxToMutableReplica(
        account,
        {
          type: 'lending_fund',
          data: {
            positionId: second,
            hubEntityId: BANK,
            lenderEntityId: SAVER,
            tokenId: 1,
            amount: 100n,
            termId: 'demand',
            interestBps: 500,
          },
        },
        true,
        1_001,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await applyAccountTxToMutableReplica(
        account,
        {
          type: 'lending_rate',
          data: {
            positionId: POSITION,
            hubEntityId: BANK,
            lenderEntityId: SAVER,
            tokenId: 1,
            claimHash: lendingCovenantHash(claimOf(account)),
            interestBps: 500,
          },
        },
        false,
        YEAR / 2,
      )
    ).ok,
  ).toBe(true);
  const state = bankState(account, YEAR - 86_400_000 + 1_001, 500);
  const due = demandSavingsRenewals(state).filter(work => work.triggerAt <= state.timestamp);
  expect(due.map(work => (work.tx.type === 'lending_rate' ? work.tx.data.positionId : ''))).toEqual([second]);
});

test('a risk-reducing rate remains serviceable after the saver lowers the credit limit', async () => {
  const account = await funded(true);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 10_000n, rightCreditLimit: 0n });
  const state = bankState(account, YEAR / 4 + 1_000, 0);
  const [work] = demandSavingsRenewals(state);
  expect(work?.tx.type).toBe('lending_rate');
  if (!work) throw new Error('Expected risk-reducing renewal');
  expect((await applyAccountTxToMutableReplica(account, work.tx, false, state.timestamp)).ok).toBe(true);
  expect(lendingMaximumAmount(claimOf(account))).toBe(10_125n);
});
