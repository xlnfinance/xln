import { expect, test } from 'bun:test';
import { crossBookMarket } from './cross-book';
import { pickBookLevel } from './orderbook-quote';

const source = { jurisdiction: `stack:31338:0x${'11'.repeat(20)}`, tokenId: 2, hubId: `0x${'aa'.repeat(32)}` };
const target = { jurisdiction: `stack:31337:0x${'22'.repeat(20)}`, tokenId: 1, hubId: `0x${'bb'.repeat(32)}` };

test('a reversed Cross market keeps the venue and book owner while reversing the takeable side', () => {
  const forward = crossBookMarket(source, target);
  const reverse = crossBookMarket(target, source);
  expect(forward).toEqual({
    pairId: `cross:${source.jurisdiction}:2/${target.jurisdiction}:1`,
    hubId: target.hubId,
    baseTokenId: 2,
    quoteTokenId: 1,
    sourceIsBase: true,
  });
  expect(reverse).toEqual({ ...forward, sourceIsBase: false });
  const sameToken = crossBookMarket({ ...source, tokenId: 1 }, target);
  expect(sameToken.pairId).toBe(`cross:${target.jurisdiction}:1/${source.jurisdiction}:1`);
  expect(sameToken.sourceIsBase).toBe(false);
  expect(sameToken.hubId).toBe(target.hubId);
});

test('Cross wrong-side pick is a no-op; the takeable bid preserves WETH18 to USDC6 exact units', () => {
  const input = {
    level: { priceTicks: 24_900_000n, size: 20_000_000_000_000_000n },
    baseDecimals: 18,
    quoteDecimals: 6,
    capacity: 10_000_000_000_000_000n,
    crossSourceIsBase: true,
  };
  expect(pickBookLevel({ ...input, side: 'ask' })).toBeNull();
  expect(pickBookLevel({ ...input, side: 'bid' })).toEqual({ give: 10_000_000_000_000_000n, want: 24_900_000n });
  expect(pickBookLevel({ ...input, side: 'bid', capacity: 0n })).toBeNull();
  expect(pickBookLevel({ ...input, side: 'bid', level: { ...input.level, priceTicks: 0n } })).toBeNull();
});

test('Cross takeable ask bounds the source quote capacity without inverting price or target units', () => {
  const input = {
    level: { priceTicks: 25_000_000n, size: 20_000_000_000_000_000n },
    baseDecimals: 18,
    quoteDecimals: 6,
    capacity: 25_000_000n,
    crossSourceIsBase: false,
  };
  expect(pickBookLevel({ ...input, side: 'bid' })).toBeNull();
  expect(pickBookLevel({ ...input, side: 'ask' })).toEqual({ give: 25_000_000n, want: 10_000_000_000_000_000n });
  expect(pickBookLevel({ ...input, side: 'ask', capacity: 100_000_000n })).toEqual({
    give: 50_000_000n,
    want: 20_000_000_000_000_000n,
  });
});
