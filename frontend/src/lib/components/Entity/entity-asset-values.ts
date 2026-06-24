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
