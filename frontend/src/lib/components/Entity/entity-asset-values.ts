import type { AccountMachine } from '@xln/runtime/xln-api';
import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';
import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';

export type AssetTokenInfo = {
  symbol?: string;
  decimals?: number;
};

export type ExternalTokenValueInput = {
  balance: bigint;
  decimals?: number;
  symbol: string;
};

export type AccountPortfolioData = {
  outbound: number;
  inbound: number;
  outCollateral: number;
  outOurCredit: number;
  count: number;
  total: number;
};

export type EntityAssetValueFormatters = {
  formatAmount: (amount: bigint, decimals?: number) => string;
  formatCompact: (value: number) => string;
  formatApproxUsd: (value: number) => string;
  formatUsdExact: (value: number) => string;
  getAssetPrice: (symbol: string) => number;
  getAssetValue: (tokenId: number, amount: bigint, symbolOverride?: string) => number;
  getExternalValue: (token: ExternalTokenValueInput) => number;
  calculatePortfolioValue: (reserves: Map<number | string, bigint>) => number;
};

export function normalizeTokenPrecision(rawPrecision: unknown): number {
  return Math.max(0, Math.min(18, Math.floor(Number(rawPrecision ?? 4))));
}

export function formatTokenAmount(amount: bigint, decimals = 18, rawPrecision: unknown = 4): string {
  const precision = normalizeTokenPrecision(rawPrecision);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let text = whole.toLocaleString('en-US');
  if (precision > 0 && frac > 0n) {
    const fracStr = frac
      .toString()
      .padStart(decimals, '0')
      .slice(0, Math.min(decimals, precision))
      .replace(/0+$/, '');
    if (fracStr.length > 0) text = `${text}.${fracStr}`;
  }
  return `${negative ? '-' : ''}${text}`;
}

export function parseTokenAmountInput(amount: string, decimals: number): bigint {
  const [wholeRaw, fracRaw = ''] = amount.split('.');
  const whole = wholeRaw && wholeRaw.length > 0 ? BigInt(wholeRaw) : 0n;
  const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const frac = fracPadded.length > 0 ? BigInt(fracPadded) : 0n;
  return whole * 10n ** BigInt(decimals) + frac;
}

export function formatTokenInputAmount(amount: bigint, decimals: number): string {
  if (amount <= 0n) return '';
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

export function parsePositiveAssetAmount(raw: string, token: { decimals: number }, maxAmount?: bigint): bigint {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Amount is required');
  if (!/^(?:\d+|\d+\.\d*|\.\d+)$/.test(trimmed)) throw new Error('Invalid amount format');
  const parsed = parseTokenAmountInput(trimmed, token.decimals);
  if (parsed <= 0n) throw new Error('Amount must be greater than zero');
  if (typeof maxAmount === 'bigint' && parsed > maxAmount) throw new Error('Amount exceeds available balance');
  return parsed;
}

export function formatCompactUsd(value: number, compactNumbers: boolean): string {
  if (!compactNumbers) {
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (value >= 1_000_000) return '$' + (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1_000) return '$' + (value / 1_000).toFixed(2) + 'K';
  return '$' + value.toFixed(2);
}

export function formatApproxUsd(value: number, compactNumbers: boolean): string {
  return `~${formatCompactUsd(value, compactNumbers)}`;
}

export function formatUsdExact(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function getAssetPriceUsd(symbol: string): number {
  return getAssetUsdPrice(symbol);
}

export function getAssetValueUsd(amount: bigint, info: AssetTokenInfo, symbolOverride?: string): number {
  const symbol = symbolOverride ?? info.symbol ?? 'UNK';
  return amountToUsd(amount, info.decimals ?? 18, symbol);
}

export function getExternalTokenValueUsd(token: ExternalTokenValueInput): number {
  return amountToUsd(token.balance, token.decimals ?? 18, token.symbol);
}

export function calculatePortfolioValueUsd(
  reserves: Map<number | string, bigint>,
  getTokenInfo: (tokenId: number) => AssetTokenInfo,
): number {
  let total = 0;
  for (const [tokenId, amount] of reserves.entries()) {
    total += getAssetValueUsd(amount, getTokenInfo(Number(tokenId)));
  }
  return total;
}

export function createEntityAssetValueFormatters(input: {
  getTokenInfo: (tokenId: number) => AssetTokenInfo;
  tokenPrecision: unknown;
  compactNumbers: boolean;
}): EntityAssetValueFormatters {
  return {
    formatAmount: (amount, decimals = 18) => formatTokenAmount(amount, decimals, input.tokenPrecision),
    formatCompact: (value) => formatCompactUsd(value, input.compactNumbers),
    formatApproxUsd: (value) => formatApproxUsd(value, input.compactNumbers),
    formatUsdExact,
    getAssetPrice: getAssetPriceUsd,
    getAssetValue: (tokenId, amount, symbolOverride) => getAssetValueUsd(amount, input.getTokenInfo(tokenId), symbolOverride),
    getExternalValue: getExternalTokenValueUsd,
    calculatePortfolioValue: (reserves) => calculatePortfolioValueUsd(reserves, input.getTokenInfo),
  };
}

function emptyAccountPortfolioData(): AccountPortfolioData {
  return {
    outbound: 0,
    inbound: 0,
    outCollateral: 0,
    outOurCredit: 0,
    count: 0,
    total: 0,
  };
}

export function buildAccountPortfolioData(options: {
  accounts: Map<string, AccountMachine> | undefined;
  localEntityId: string;
  deriveDelta: FrontendXlnFunctions['deriveDelta'] | undefined;
  getTokenInfo: (tokenId: number) => AssetTokenInfo;
}): AccountPortfolioData {
  const out = emptyAccountPortfolioData();
  if (!(options.accounts instanceof Map)) return out;

  for (const [counterpartyId, account] of options.accounts.entries()) {
    out.count++;
    if (!account.deltas) continue;

    for (const [tokenId, delta] of account.deltas.entries()) {
      const info = options.getTokenInfo(Number(tokenId));
      const symbol = info.symbol ?? 'UNK';
      const isLeftEntity = String(options.localEntityId || '').toLowerCase() < String(counterpartyId || '').toLowerCase();
      const derived = options.deriveDelta?.(delta, isLeftEntity);
      if (!derived) continue;

      if (derived.outCapacity > 0n) out.outbound += getAssetValueUsd(derived.outCapacity, info, symbol);
      if (derived.inCapacity > 0n) out.inbound += getAssetValueUsd(derived.inCapacity, info, symbol);
      if (derived.outCollateral > 0n) out.outCollateral += getAssetValueUsd(derived.outCollateral, info, symbol);
      if (derived.outOwnCredit > 0n) out.outOurCredit += getAssetValueUsd(derived.outOwnCredit, info, symbol);
    }
  }

  out.total = out.outbound;
  return out;
}
