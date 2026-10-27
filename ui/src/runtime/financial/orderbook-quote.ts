import { SWAP_CONSTANTS } from '@xln/core/config/constants';
import { deriveSameOrderbookPriceBandBounds, resolveOrderbookPriceReference } from '@xln/core/swapbook/price-band';
import { formatAmount } from '../format';
import type { BookLevel, BookView } from './orderbook';

/** Canonical price unit: ticks per quote unit, four decimals. */
export const PRICE_SCALE = 10_000n;

/** Quote amount for `size` base units at `priceTicks`, in raw quote units. */
export function quoteForBase(size: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  const baseUnit = 10n ** BigInt(baseDecimals);
  const quoteUnit = 10n ** BigInt(quoteDecimals);
  return (size * priceTicks * quoteUnit) / (PRICE_SCALE * baseUnit);
}

/** Fill a draft from the selected level; Cross never changes the chosen asset direction. */
export function pickBookLevel(input: {
  side: 'ask' | 'bid';
  level: Pick<BookLevel, 'priceTicks' | 'size'>;
  baseDecimals: number;
  quoteDecimals: number;
  capacity: bigint;
  crossSourceIsBase?: boolean;
}): { give: bigint; want: bigint } | null {
  if (
    input.crossSourceIsBase !== undefined &&
    (input.side !== (input.crossSourceIsBase ? 'bid' : 'ask') || input.capacity <= 0n)
  )
    return null;
  const { size, priceTicks } = input.level;
  if (size <= 0n || priceTicks <= 0n) return null;
  const quote = quoteForBase(size, priceTicks, input.baseDecimals, input.quoteDecimals);
  if (quote <= 0n) return null;
  const available = input.side === 'ask' ? quote : size;
  const desired = input.side === 'ask' ? size : quote;
  const give = input.capacity > 0n && available > input.capacity ? input.capacity : available;
  return { give, want: give === available ? desired : (desired * give) / available };
}

/** The same best-level indicative quote for native and web tickets. Execution still uses prepareSwapOrder. */
export function quoteAtBestLevel(
  book: BookView,
  giveTokenId: number,
  wantTokenId: number,
  give: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): { want: bigint; availableGive: bigint } | null {
  if (give <= 0n) return null;
  const buying = giveTokenId === book.quoteTokenId && wantTokenId === book.baseTokenId;
  const selling = giveTokenId === book.baseTokenId && wantTokenId === book.quoteTokenId;
  if (!buying && !selling) return null;
  const level = buying ? book.asks[0] : book.bids[0];
  if (!level || level.size <= 0n || level.priceTicks <= 0n) return null;
  const cost = quoteForBase(level.size, level.priceTicks, baseDecimals, quoteDecimals);
  if (cost <= 0n) return null;
  return {
    want: buying ? (level.size * give) / cost : quoteForBase(give, level.priceTicks, baseDecimals, quoteDecimals),
    availableGive: buying ? cost : level.size,
  };
}

/** Compare the canonical planner's rounded order with the selected hub's published admission limit. */
export function swapMinimumError(
  book: Pick<BookView, 'minTradeSize' | 'quoteTokenId'>,
  giveTokenId: number,
  prepared: { effectiveGive: bigint; effectiveWant: bigint },
  quote: { decimals: number; symbol: string },
): string | null {
  if (book.minTradeSize === null) return 'Waiting for the market minimum.';
  const quoteAmount = giveTokenId === book.quoteTokenId ? prepared.effectiveGive : prepared.effectiveWant;
  return quoteAmount < book.minTradeSize
    ? `Minimum swap is ${formatAmount(book.minTradeSize, quote.decimals)} ${quote.symbol} after lot rounding.`
    : null;
}

/** Preview the Entity's same-market band; admission still validates its committed book. */
export function swapPriceBandError(book: Pick<BookView, 'bids' | 'asks'>, priceTicks: bigint): string | null {
  const { anchor } = resolveOrderbookPriceReference(book.bids[0]?.priceTicks ?? null, book.asks[0]?.priceTicks ?? null);
  // No policy is inferred for an empty remote book. The Entity owns that decision.
  if (anchor === null) return null;
  const { minAllowed, maxAllowed } = deriveSameOrderbookPriceBandBounds(anchor);
  return priceTicks < minAllowed || priceTicks > maxAllowed
    ? `Price must stay within ${SWAP_CONSTANTS.PRICE_REJECT_BPS / 100}% of the current orderbook.`
    : null;
}
