import { expect, test } from 'bun:test';
import { prepareSwapOrderForDimensions } from '@xln/core/swapbook/types';
import type { TokenCatalogEntry } from '../../token-meta';
import { tokenCatalogMeta } from './metadata';
import { crossBookMarket } from '../cross-book';
import { pickBookLevel } from '../orderbook-quote';

const tron: TokenCatalogEntry[] = [
  { tokenId: 2, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  { tokenId: 3, symbol: 'USDT', name: 'Tron Tether', decimals: 6 },
  { tokenId: 4, symbol: 'TRX', name: 'Tron', decimals: 6 },
];
const destination: TokenCatalogEntry[] = [{ tokenId: 3, symbol: 'DEST', name: 'Destination asset', decimals: 8 }];

test('destination token metadata never substitutes a different Depository asset with the same id', () => {
  expect(tokenCatalogMeta(tron, 4).symbol).toBe('TRX');
  expect(tokenCatalogMeta(destination, 4).symbol).toBe('?');
  expect(tokenCatalogMeta([], 3).symbol).toBe('?');
  const give = tokenCatalogMeta(tron, 2);
  const want = tokenCatalogMeta(destination, 3);
  expect(want.symbol).toBe('DEST');
  expect(want.decimals).toBe(8);
  const order = prepareSwapOrderForDimensions(2, 3, 10n ** 18n, 2500n * 10n ** 8n, {
    giveTokenDecimals: give.decimals,
    wantTokenDecimals: want.decimals,
  });
  expect(order?.priceTicks).toBe(25_000_000n);
  expect(order?.effectiveWant).toBe(2500n * 10n ** 8n);
});

test('same token id across chains retains distinct units in both market directions', () => {
  const source = { jurisdiction: `stack:31338:0x${'11'.repeat(20)}`, tokenId: 3, hubId: `0x${'aa'.repeat(32)}` };
  const target = { jurisdiction: `stack:31337:0x${'22'.repeat(20)}`, tokenId: 3, hubId: `0x${'bb'.repeat(32)}` };
  const give = tokenCatalogMeta(tron, 3);
  const want = tokenCatalogMeta(destination, 3);
  const market = crossBookMarket(source, target);
  expect(market.sourceIsBase).toBe(false);
  const quote = pickBookLevel({
    side: 'ask',
    level: { priceTicks: 10_000n, size: 100_000_000n },
    baseDecimals: want.decimals,
    quoteDecimals: give.decimals,
    capacity: 1_000_000n,
    crossSourceIsBase: market.sourceIsBase,
  });
  expect(quote).toEqual({ give: 1_000_000n, want: 100_000_000n });
  const reverse = crossBookMarket(target, source);
  expect(reverse.pairId).toBe(market.pairId);
  expect(
    pickBookLevel({
      side: 'bid',
      level: { priceTicks: 10_000n, size: 100_000_000n },
      baseDecimals: want.decimals,
      quoteDecimals: give.decimals,
      capacity: 100_000_000n,
      crossSourceIsBase: reverse.sourceIsBase,
    }),
  ).toEqual({ give: 100_000_000n, want: 1_000_000n });
});
