import type { AccountReplica } from '@xln/core/api/public/runtime-module';
import { ZeroAddress } from 'ethers';
import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';
import { amountToUsd, getAssetUsdPrice } from '$lib/utils/assetPricing';
import type { AssetLedgerRow, AssetLedgerTotals } from './../asset-ledger';
import { getExternalTokenIdentityKey, type ExternalToken } from './entity-asset-catalog';
import { requireTokenDecimals } from './../token-metadata';
import { parseTokenAmountInput as parseStrictTokenAmountInput } from './token-amount-input';

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
  formatAmount: (amount: bigint, decimals: number) => string;
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

export function formatTokenAmount(amount: bigint, decimals: number, rawPrecision: unknown = 4): string {
  const exactDecimals = requireTokenDecimals(decimals, 'formatTokenAmount');
  const precision = normalizeTokenPrecision(rawPrecision);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = BigInt(10) ** BigInt(exactDecimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let text = whole.toLocaleString('en-US');
  if (precision > 0 && frac > 0n) {
    const fracStr = frac
      .toString()
      .padStart(exactDecimals, '0')
      .slice(0, Math.min(exactDecimals, precision))
      .replace(/0+$/, '');
    if (fracStr.length > 0) text = `${text}.${fracStr}`;
  }
  return `${negative ? '-' : ''}${text}`;
}

export function parseTokenAmountInput(amount: string, decimals: number): bigint {
  const normalized = amount.startsWith('.') ? `0${amount}` : amount;
  return parseStrictTokenAmountInput(normalized, decimals);
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
  if (/^0*(?:\.0*)?$/.test(trimmed)) throw new Error('Amount must be greater than zero');
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
  return amountToUsd(amount, requireTokenDecimals(info.decimals, symbol), symbol);
}

export function getExternalTokenValueUsd(token: ExternalTokenValueInput): number {
  return amountToUsd(token.balance, requireTokenDecimals(token.decimals, token.symbol), token.symbol);
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
    formatAmount: (amount, decimals) => formatTokenAmount(amount, decimals, input.tokenPrecision),
    formatCompact: value => formatCompactUsd(value, input.compactNumbers),
    formatApproxUsd: value => formatApproxUsd(value, input.compactNumbers),
    formatUsdExact,
    getAssetPrice: getAssetPriceUsd,
    getAssetValue: (tokenId, amount, symbolOverride) =>
      getAssetValueUsd(amount, input.getTokenInfo(tokenId), symbolOverride),
    getExternalValue: getExternalTokenValueUsd,
    calculatePortfolioValue: reserves => calculatePortfolioValueUsd(reserves, input.getTokenInfo),
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
  accounts: Map<string, AccountReplica> | undefined;
  localEntityId: string;
  deriveDelta: FrontendXlnFunctions['deriveDelta'] | undefined;
  getTokenInfo: (tokenId: number) => AssetTokenInfo;
}): AccountPortfolioData {
  const out = emptyAccountPortfolioData();
  if (!(options.accounts instanceof Map)) return out;

  for (const [counterpartyId, account] of options.accounts.entries()) {
    out.count++;
    if (!account.state.deltas) continue;

    for (const [tokenId, delta] of account.state.deltas.entries()) {
      const info = options.getTokenInfo(Number(tokenId));
      const symbol = info.symbol ?? 'UNK';
      const isLeftEntity =
        String(options.localEntityId || '').toLowerCase() < String(counterpartyId || '').toLowerCase();
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

export function buildAccountSpendableByToken(options: {
  accounts: Map<string, AccountReplica> | undefined;
  localEntityId: string;
  deriveDelta: FrontendXlnFunctions['deriveDelta'] | undefined;
}): Map<number, bigint> {
  const totals = new Map<number, bigint>();
  if (!options.accounts || !options.localEntityId || !options.deriveDelta) return totals;
  for (const [counterpartyId, account] of options.accounts.entries()) {
    if (!(account?.state.deltas instanceof Map)) continue;
    const isLeftEntity = options.localEntityId.toLowerCase() < String(counterpartyId || '').toLowerCase();
    for (const [tokenId, delta] of account.state.deltas.entries()) {
      const numericTokenId = Number(tokenId);
      if (!Number.isFinite(numericTokenId) || numericTokenId <= 0) continue;
      const spendable = options.deriveDelta(delta, isLeftEntity)?.outCapacity ?? 0n;
      if (spendable > 0n) totals.set(numericTokenId, (totals.get(numericTokenId) ?? 0n) + spendable);
    }
  }
  return totals;
}

export function buildAssetLedger(options: {
  externalTokens: ExternalToken[];
  reserves: Map<number, bigint>;
  accountSpendable: Map<number, bigint>;
  getExternalValue(token: ExternalToken): number;
  getAssetValue(tokenId: number, amount: bigint, symbol?: string): number;
  resolveReserveTokenMeta(tokenId: number): { symbol: string; decimals: number };
  compareSymbols(left: string, right: string): number;
}): { rows: AssetLedgerRow[]; totals: AssetLedgerTotals } {
  const rows = new Map<string, AssetLedgerRow>();
  const valueFor = (tokenId: number, amount: bigint, symbol: string) => options.getAssetValue(tokenId, amount, symbol);

  for (const token of options.externalTokens) {
    const isReserve = typeof token.tokenId === 'number' && token.tokenId > 0;
    const reserveBalance = isReserve ? (options.reserves.get(token.tokenId!) ?? 0n) : 0n;
    const accountBalance = isReserve ? (options.accountSpendable.get(token.tokenId!) ?? 0n) : 0n;
    const externalUsd = options.getExternalValue(token);
    const reserveUsd = isReserve ? valueFor(token.tokenId!, reserveBalance, token.symbol) : 0;
    const accountUsd = isReserve ? valueFor(token.tokenId!, accountBalance, token.symbol) : 0;
    rows.set(getExternalTokenIdentityKey(token), {
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
      tokenId: token.tokenId,
      isNative: token.symbol === 'ETH' || token.address === ZeroAddress,
      externalBalance: token.balance,
      reserveBalance,
      accountBalance,
      externalUsd,
      reserveUsd,
      accountUsd,
      totalUsd: externalUsd + reserveUsd + accountUsd,
      ...(token.readError ? { externalError: token.readError } : {}),
    });
  }

  for (const tokenId of new Set([...options.reserves.keys(), ...options.accountSpendable.keys()])) {
    if (!Number.isFinite(tokenId) || tokenId <= 0 || rows.has(`token:${tokenId}`)) continue;
    const info = options.resolveReserveTokenMeta(tokenId);
    const reserveBalance = options.reserves.get(tokenId) ?? 0n;
    const accountBalance = options.accountSpendable.get(tokenId) ?? 0n;
    const reserveUsd = valueFor(tokenId, reserveBalance, info.symbol);
    const accountUsd = valueFor(tokenId, accountBalance, info.symbol);
    rows.set(`token:${tokenId}`, {
      symbol: info.symbol,
      address: '',
      decimals: info.decimals,
      tokenId,
      isNative: false,
      externalBalance: 0n,
      reserveBalance,
      accountBalance,
      externalUsd: 0,
      reserveUsd,
      accountUsd,
      totalUsd: reserveUsd + accountUsd,
    });
  }

  const nativeKey = `address:${ZeroAddress.toLowerCase()}`;
  if (!rows.has(nativeKey)) {
    rows.set(nativeKey, {
      symbol: 'ETH',
      address: ZeroAddress,
      decimals: 18,
      tokenId: undefined,
      isNative: true,
      externalBalance: 0n,
      reserveBalance: 0n,
      accountBalance: 0n,
      externalUsd: 0,
      reserveUsd: 0,
      accountUsd: 0,
      totalUsd: 0,
    });
  }

  const result = [...rows.values()].sort((left, right) => options.compareSymbols(left.symbol, right.symbol));
  const totals = result.reduce<AssetLedgerTotals>(
    (sum, row) => ({
      externalUsd: sum.externalUsd + row.externalUsd,
      reserveUsd: sum.reserveUsd + row.reserveUsd,
      accountUsd: sum.accountUsd + row.accountUsd,
    }),
    { externalUsd: 0, reserveUsd: 0, accountUsd: 0 },
  );
  return { rows: result, totals };
}
