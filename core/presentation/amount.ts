import type { TokenDecimals } from '../account/tx/units';

/**
 * Token amount text for presentation. Both wallets read and write the same
 * amounts, so the parse and format pair lives here rather than inside one
 * wallet: a face that owned it would make the other face depend on it.
 */

/** "12,480.2" grouped integer part, trailing zeros trimmed, never exponent. */
export function formatAmount(amount: bigint, decimals: TokenDecimals, maxFraction = 6): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  const wholeText = whole.toLocaleString('en-US');
  let fractionText = fraction.toString().padStart(decimals, '0').slice(0, Math.min(decimals, maxFraction));
  fractionText = fractionText.replace(/0+$/, '');

  const sign = negative ? '−' : '';
  return fractionText ? `${sign}${wholeText}.${fractionText}` : `${sign}${wholeText}`;
}

export function parseAmount(input: string, decimals: TokenDecimals): bigint {
  // No comma stripping: "1,5" meant 1.5 to many users and parsed as 15.
  const text = input.trim();
  if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') {
    throw new Error('Enter a valid amount');
  }
  const [wholeText = '0', fractionText = ''] = text.split('.');
  if (fractionText.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals})`);
  }
  const whole = BigInt(wholeText || '0');
  const fraction = BigInt((fractionText || '').padEnd(decimals, '0') || '0');
  return whole * 10n ** BigInt(decimals) + fraction;
}
