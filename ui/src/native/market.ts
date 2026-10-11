import type { BookView } from '../runtime/financial/orderbook';
import { quoteForBase } from '../runtime/financial/orderbook-quote';
import { amountInputText, formatAmount, parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { nativeAmountText } from './amount';

export function nativeMarket(book: BookView, hubId: string, hubName: string) {
  const base = getTokenMeta(book.baseTokenId);
  const quote = getTokenMeta(book.quoteTokenId);
  const levels = (rows: BookView['bids']) => rows.map(row => ({
    id: row.priceTicks.toString(),
    price: amountInputText(row.priceTicks, 4),
    amount: formatAmount(row.size, base.decimals, base.decimals),
    own: row.own,
  }));
  return {
    kind: 'market', hubId, hubName, base: base.symbol, quote: quote.symbol,
    status: book.status, updatedAt: book.updatedAt, error: book.error,
    bids: levels(book.bids), asks: levels(book.asks),
    spread: book.spreadTicks === null ? null : amountInputText(book.spreadTicks, 4),
  };
}

/** User-selected base size and price use the same integer price conversion as the React desk. */
export function nativeLimitAmounts(
  command: Record<string, unknown>,
  baseTokenId: number,
  quoteTokenId: number,
  baseDecimals: number,
  quoteDecimals: number,
) {
  if (command['side'] !== 'buy' && command['side'] !== 'sell') throw new Error('Choose buy or sell.');
  const read = (key: string, decimals: number): bigint => {
    const value = command[key];
    if (typeof value !== 'string') throw new Error('Enter a valid amount');
    return parseAmount(nativeAmountText(value.trim(), command['decimalSeparator']), decimals);
  };
  const base = read('amount', baseDecimals);
  const price = read('price', 4);
  if (base <= 0n || price <= 0n) throw new Error('Amount and price must be greater than zero.');
  const quote = quoteForBase(base, price, baseDecimals, quoteDecimals);
  if (quote <= 0n) throw new Error('Amount is below the market minimum.');
  return command['side'] === 'buy'
    ? { giveToken: quoteTokenId, wantToken: baseTokenId, give: quote, want: base }
    : { giveToken: baseTokenId, wantToken: quoteTokenId, give: base, want: quote };
}
