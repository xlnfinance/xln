import type { BookView } from '../runtime/financial/orderbook';
import { PRICE_DECIMALS, amountInputText, formatAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';

export function nativeMarket(book: BookView, hubId: string, hubName: string) {
  const base = getTokenMeta(book.baseTokenId);
  const quote = getTokenMeta(book.quoteTokenId);
  const levels = (rows: BookView['bids']) => rows.map(row => ({
    id: row.priceTicks.toString(),
    price: amountInputText(row.priceTicks, PRICE_DECIMALS),
    amount: formatAmount(row.size, base.decimals, base.decimals),
    own: row.own,
  }));
  return {
    kind: 'market', hubId, hubName, base: base.symbol, quote: quote.symbol,
    status: book.status, updatedAt: book.updatedAt, error: book.error,
    bids: levels(book.bids), asks: levels(book.asks),
    spread: book.spreadTicks === null ? null : amountInputText(book.spreadTicks, PRICE_DECIMALS),
  };
}
