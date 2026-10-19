import { expect, test } from 'bun:test';
import { compactAccountDocForView } from '../../../api/runtime-adapter/read/compact-view';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { entity, makeAccount } from '../../helpers/cross-j';
import type { AccountSubcontract } from '../../../types/account';
import { walletLendingBalance } from '../../../../ui/src/runtime/financial/lending-balance';

test('compact Account views retain all signed lending value before the twenty-claim detail sample', () => {
  const account = makeAccount(entity('11'), entity('22'));
  account.currentFrame.timestamp = 1_800_000;
  account.state.subcontracts = PersistentAccountStateMap.fromEntries<string, AccountSubcontract>(
    'subcontracts',
    Array.from({ length: 21 }, (_, index) => [
      `lend-${index.toString(16).padStart(16, '0')}`,
      {
        kind: 'savings',
        tokenId: 1,
        creditorIsLeft: true,
        principal: 10_000n,
        interestBps: 100,
        openedAt: 0,
        accruedAt: 0,
        accruedInterest: 0n,
        interestRemainder: 0n,
        termMs: 3_600_000,
        lateMs: 0,
      },
    ]),
  );
  const compact = compactAccountDocForView(account);
  expect(compact.state.subcontracts?.size).toBe(20);
  expect(compact).toHaveProperty('lendingBalances');
  // The current signed exit rule earns 50 per claim at the committed half-term.
  // This is the creditor's asset and exactly the debtor's liability, not capacity.
  expect(compact.lendingBalances.get(1)).toBe(211_050n);
  expect(walletLendingBalance({ accounts: [{ doc: compact, isLeft: true }] }).get(1)).toBe(211_050n);
  expect(walletLendingBalance({ accounts: [{ doc: compact, isLeft: false }] }).get(1)).toBe(-211_050n);
  expect(account.state.subcontracts.size).toBe(21);
});

test('settled claims contribute zero despite retained fund/payout receipts', () => {
  const account = makeAccount(entity('11'), entity('22'));
  account.state.lendingIntents = PersistentAccountStateMap.fromEntries('lendingIntents', [
    ['fund:lend-1111111111111111', 'fund'],
    ['payout:lend-1111111111111111', 'close-payout'],
  ]);
  const compact = compactAccountDocForView(account);
  expect(compact).toHaveProperty('lendingBalances');
  expect(compact.lendingBalances.size).toBe(0);
});

test('a right-side bank loan is its asset and the left borrower liability, never new payment capacity', () => {
  const account = makeAccount(entity('11'), entity('22'));
  account.currentFrame.timestamp = 1_800_000;
  account.state.subcontracts = PersistentAccountStateMap.fromEntries('subcontracts', [
    [
      'loan-1111111111111111',
      {
        kind: 'loan',
        tokenId: 1,
        creditorIsLeft: false,
        principal: 10_000n,
        interestBps: 200,
        openedAt: 0,
        accruedAt: 0,
        accruedInterest: 0n,
        interestRemainder: 0n,
        termMs: 3_600_000,
        lateMs: 3_600_000,
      },
    ],
  ]);
  const delta = account.state.deltas.get(1);
  const compact = compactAccountDocForView(account);
  expect(walletLendingBalance({ accounts: [{ doc: compact, isLeft: true }] }).get(1)).toBe(-10_100n);
  expect(walletLendingBalance({ accounts: [{ doc: compact, isLeft: false }] }).get(1)).toBe(10_100n);
  expect(compact.state.deltas.get(1)).toEqual(delta);
});
