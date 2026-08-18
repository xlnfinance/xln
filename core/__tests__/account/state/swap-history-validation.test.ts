import { expect, test } from 'bun:test';

import { validateSwapHistoryMap } from '../../../account/validation/swap-history-validation';

const historyEntry = (fillRatio: unknown, height: unknown): Map<string, unknown> =>
  new Map([['offer-1', {
    offerId: 'offer-1',
    giveTokenId: 1,
    giveAmount: 10n,
    wantTokenId: 2,
    wantAmount: 20n,
    createdHeight: 1,
    cancelRequested: false,
    lastUpdatedHeight: 2,
    resolves: [{ fillRatio, cancelRemainder: false, height }],
  }]]);

test('durable swap history rejects numeric strings before typing the state', () => {
  expect(() => validateSwapHistoryMap(
    historyEntry('1', 1),
    'Account.swapOrderHistory',
    10,
    'ACCOUNT_SWAP_HISTORY_LIMIT',
  )).toThrow('fillRatio must be uint16');
  expect(() => validateSwapHistoryMap(
    historyEntry(1, '1'),
    'Account.swapOrderHistory',
    10,
    'ACCOUNT_SWAP_HISTORY_LIMIT',
  )).toThrow('height must be a non-negative safe integer');
});

test('durable swap history returns an independently typed validated map', () => {
  const raw = historyEntry(1, 2);
  const validated = validateSwapHistoryMap(
    raw,
    'Account.swapOrderHistory',
    10,
    'ACCOUNT_SWAP_HISTORY_LIMIT',
  );

  expect(validated.get('offer-1')?.resolves[0]?.height).toBe(2);
  expect(validated).not.toBe(raw);
});
