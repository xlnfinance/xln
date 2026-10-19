import { expect, test } from 'bun:test';
import type { RuntimeAdapterFrameReceiptResponse } from '@xln/core/api/runtime-adapter/types';
import { tutorialTradeFilled, type TutorialTrade } from './trade';

const trade: TutorialTrade = {
  runtimeId: 'runtime',
  entityId: 'maker',
  counterpartyId: 'hub',
  offerId: 'order',
  fromHeight: 10,
};
const receipt = (): RuntimeAdapterFrameReceiptResponse => ({
  fromHeight: 10,
  toHeight: 12,
  returned: 1,
  receipts: [
    {
      height: 11,
      timestamp: 1000,
      logs: [
        {
          id: 1,
          timestamp: 1000,
          level: 'info',
          category: 'entity',
          message: 'SwapFilled',
          entityId: 'maker',
          data: {
            entityId: 'maker',
            counterpartyId: 'hub',
            offerId: 'order',
            executionGiveAmount: 25n,
            executionWantAmount: 1n,
          },
        },
      ],
    },
  ],
});

test('only a committed execution of the tutorial order completes trade', () => {
  expect(tutorialTradeFilled(trade, receipt())).toBe(true);
  for (const [field, value] of [
    ['entityId', 'other'],
    ['counterpartyId', 'other'],
    ['offerId', 'old-order'],
    ['executionGiveAmount', 0n],
    ['executionWantAmount', 0n],
    ['executionWantAmount', '-1'],
  ] as const) {
    const page = receipt();
    page.receipts[0]!.logs[0]!.data![field] = value;
    expect(tutorialTradeFilled(trade, page)).toBe(false);
  }
  const incoming = receipt();
  incoming.receipts[0]!.logs[0]!.message = 'HtlcReceived';
  expect(tutorialTradeFilled(trade, incoming)).toBe(false);
  const old = receipt();
  old.receipts[0]!.height = 9;
  expect(tutorialTradeFilled(trade, old)).toBe(false);
  const later = receipt();
  later.receipts[0]!.height = 13;
  expect(tutorialTradeFilled(trade, later)).toBe(false);
});
