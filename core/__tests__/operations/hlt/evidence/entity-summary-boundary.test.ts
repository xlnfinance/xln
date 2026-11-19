import { expect, test } from 'bun:test';
import { decodeEntitySummaries } from '../../../../scripts/operations/hlt/boundary/worker-boundary';

const summary = { entityId: `0x${'1'.repeat(64)}`, label: 'H1', height: 1, isHub: true };

test('production Entity summaries preserve their effective swap tariff metadata', () => {
  for (const swapTakerFeeBps of [0, 1, 10_000]) {
    expect(decodeEntitySummaries([{ ...summary, swapTakerFeeBps }])).toEqual([{ ...summary, swapTakerFeeBps }]);
  }
});

test('summary decoding rejects malformed tariff metadata and unknown fields', () => {
  for (const swapTakerFeeBps of [-1, 1.5, 10_001, '1', null, Number.NaN]) {
    expect(() => decodeEntitySummaries([{ ...summary, swapTakerFeeBps }])).toThrow('PRODUCTION_SWAP_LOAD_SWAP_FEE_INVALID');
  }
  expect(() => decodeEntitySummaries([{ ...summary, unknownTariff: 1 }])).toThrow('PRODUCTION_SWAP_LOAD_ENTITY_FIELDS_INVALID');
});
