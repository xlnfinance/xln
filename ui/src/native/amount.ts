import { quoteAmountAtPriceForDecimals } from '@xln/core/swapbook/types';
import { parseAmount } from '../runtime/format';

/** Match the iPhone's decimal separator; grouping, exponents and ambiguous formats are rejected. */
export function nativeAmountText(value: string, separator: unknown): string {
  if (separator !== '.' && separator !== ',') throw new Error('Unsupported decimal separator.');
  const pattern = separator === ',' ? /^\d+(?:,\d+)?$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(value)) throw new Error('Enter a valid amount using your iPhone’s decimal separator.');
  return value.replace(',', '.');
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
  const quote = quoteAmountAtPriceForDecimals(baseDecimals, quoteDecimals, base, price);
  if (quote <= 0n) throw new Error('Amount is below the market minimum.');
  return command['side'] === 'buy'
    ? { giveToken: quoteTokenId, wantToken: baseTokenId, give: quote, want: base }
    : { giveToken: baseTokenId, wantToken: quoteTokenId, give: base, want: quote };
}
