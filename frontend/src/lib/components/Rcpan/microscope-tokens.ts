const WAD = 10n ** 18n;
const USD_MICROS = 1_000_000n;

export type RcpanMicroscopeToken = Readonly<{
  tokenId: number;
  symbol: string;
  name: string;
  decimals: number;
  color: string;
  usdPriceMicros: bigint;
  grossAmount: bigint;
  userReserve: bigint;
  hubReserve: bigint;
}>;

export const RCPAN_MICROSCOPE_TOKENS: readonly RcpanMicroscopeToken[] = [
  {
    tokenId: 1,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 18,
    color: '#2775ca',
    usdPriceMicros: USD_MICROS,
    grossAmount: 1_000_000n * WAD,
    userReserve: 400_000n * WAD,
    hubReserve: 2_000_000n * WAD,
  },
  {
    tokenId: 2,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    color: '#8b8df8',
    usdPriceMicros: 3_500n * USD_MICROS,
    grossAmount: 400n * WAD,
    userReserve: 200n * WAD,
    hubReserve: 800n * WAD,
  },
  {
    tokenId: 3,
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 18,
    color: '#26a17b',
    usdPriceMicros: USD_MICROS,
    grossAmount: 800_000n * WAD,
    userReserve: 300_000n * WAD,
    hubReserve: 1_600_000n * WAD,
  },
  {
    tokenId: 4,
    symbol: 'TRX',
    name: 'TRON',
    decimals: 18,
    color: '#ef445d',
    usdPriceMicros: 250_000n,
    grossAmount: 6_000_000n * WAD,
    userReserve: 2_000_000n * WAD,
    hubReserve: 12_000_000n * WAD,
  },
];

export function microscopeTokens(count: number): readonly RcpanMicroscopeToken[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > RCPAN_MICROSCOPE_TOKENS.length) {
    throw new Error(`RCPAN_MICROSCOPE_INVALID: tokenCount must be 1-${RCPAN_MICROSCOPE_TOKENS.length}`);
  }
  return RCPAN_MICROSCOPE_TOKENS.slice(0, count);
}

export function tokenAmountToUsdMicros(
  token: RcpanMicroscopeToken,
  amount: bigint,
): bigint {
  if (amount <= 0n) return 0n;
  return amount * token.usdPriceMicros / (10n ** BigInt(token.decimals));
}

export function formatMicroscopeTokenAmount(
  token: RcpanMicroscopeToken,
  amount: bigint,
  maximumFractionDigits = 3,
): string {
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(token.decimals);
  const whole = absolute / scale;
  const fraction = absolute % scale;
  const digits = fraction.toString().padStart(token.decimals, '0').slice(0, maximumFractionDigits);
  const trimmed = digits.replace(/0+$/, '');
  return `${sign}${whole.toLocaleString('en-US')}${trimmed ? `.${trimmed}` : ''}`;
}

export function formatUsdMicros(value: bigint): string {
  const dollars = Number(value) / 1_000_000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: dollars >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: dollars >= 1_000 ? 1 : 0,
  }).format(dollars);
}
