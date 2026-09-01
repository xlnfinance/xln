// Framework-neutral presentation rules for the workspace Jurisdiction panel.
// Runtime/JAdapter reads, time travel, token metadata authority, and panel
// events stay in the owning UI adapter.

import type { BrowserVMTokenInfo } from '@xln/core/api/public/runtime-module';

import { isUnknownRecord } from './boundary';

export type JurisdictionTokenOption = Readonly<{
  tokenId: number;
  symbol: string;
  decimals: number;
  address: string | undefined;
  name: string | undefined;
}>;

export type JurisdictionTokenInfo = Readonly<{
  symbol: string;
  decimals: number;
  name?: string;
}>;

export type BrowserVmDebugAdapter = Readonly<{
  mode: 'browservm';
  timeTravel?: unknown;
}>;

export const isBrowserVmDebugAdapter = (value: unknown): value is BrowserVmDebugAdapter =>
  isUnknownRecord(value) && value['mode'] === 'browservm';

export const toJurisdictionDisplayBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (isUnknownRecord(value)) {
    if (value['_dataType'] === 'BigInt' && value['value'] !== undefined) {
      return BigInt(String(value['value']));
    }
    const rendered = String(value);
    if (rendered.startsWith('BigInt(')) {
      const match = rendered.match(/BigInt\((-?\d+)\)/);
      if (match?.[1]) return BigInt(match[1]);
    }
  }
  return 0n;
};

export const formatJurisdictionEntityId = (entityId: string): string => entityId || 'N/A';

export const formatJurisdictionStateRoot = (
  stateRoot: Uint8Array | null | undefined,
): string => {
  if (!stateRoot || stateRoot.length === 0) return 'Unavailable';
  return `0x${[...stateRoot].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const formatJurisdictionBalance = (balance: bigint): string => {
  const amount = Number(balance) / 1e18;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
};

export const formatJurisdictionEthAmount = (amount: bigint, tokenPrecision: unknown): string => {
  const precision = Math.max(0, Math.min(18, Math.floor(Number(tokenPrecision ?? 4))));
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const divisor = 10n ** 18n;
  const whole = absolute / divisor;
  const fraction = absolute % divisor;
  let body = whole.toLocaleString('en-US');
  if (precision > 0 && fraction > 0n) {
    const sliced = fraction.toString().padStart(18, '0').slice(0, precision).replace(/0+$/, '');
    if (sliced) body = `${body}.${sliced}`;
  }
  return `${negative ? '-' : ''}${body} ETH`;
};

export const buildJurisdictionTokenOptions = (input: {
  browserTokens: readonly BrowserVMTokenInfo[];
  reserveTokenIds: readonly number[];
  collateralTokenIds: readonly number[];
  getFallbackTokenInfo: (tokenId: number) => JurisdictionTokenInfo;
}): JurisdictionTokenOption[] => {
  const options = new Map<number, JurisdictionTokenOption>();
  for (const token of input.browserTokens) {
    if (options.has(token.tokenId)) continue;
    options.set(token.tokenId, {
      tokenId: token.tokenId,
      symbol: token.symbol,
      decimals: token.decimals,
      address: token.address,
      name: token.name,
    });
  }
  const addFallback = (tokenId: number): void => {
    if (options.has(tokenId)) return;
    const info = input.getFallbackTokenInfo(tokenId);
    options.set(tokenId, {
      tokenId,
      symbol: info.symbol,
      decimals: info.decimals,
      address: undefined,
      name: info.name,
    });
  };
  input.reserveTokenIds.forEach(addFallback);
  input.collateralTokenIds.forEach(addFallback);
  return [...options.values()].sort((left, right) => left.tokenId - right.tokenId);
};

export const selectJurisdictionTokenIdText = (
  options: readonly JurisdictionTokenOption[],
  selectedTokenIdText: string,
): string => {
  const ids = options.map(({ tokenId }) => String(tokenId));
  if (ids.length === 0) return '';
  if (ids.includes(selectedTokenIdText)) return selectedTokenIdText;
  return ids.includes('1') ? '1' : (ids[0] ?? '');
};

export const parseJurisdictionTokenId = (selectedTokenIdText: string): number | null => {
  if (!selectedTokenIdText) return null;
  const parsed = Number(selectedTokenIdText);
  return Number.isNaN(parsed) ? null : parsed;
};

export const selectJurisdictionTokenMeta = (
  options: readonly JurisdictionTokenOption[],
  selectedTokenId: number | null,
  getFallbackTokenInfo: (tokenId: number) => JurisdictionTokenInfo,
): JurisdictionTokenOption | null => {
  if (selectedTokenId === null) return null;
  const option = options.find(({ tokenId }) => tokenId === selectedTokenId);
  if (option) return option;
  const info = getFallbackTokenInfo(selectedTokenId);
  return {
    tokenId: selectedTokenId,
    symbol: info.symbol,
    decimals: info.decimals,
    address: undefined,
    name: info.name,
  };
};

export const filterJurisdictionRowsByToken = <T extends Readonly<{ tokenId: number }>>(
  rows: readonly T[],
  selectedTokenId: number | null,
): T[] => selectedTokenId === null
  ? [...rows]
  : rows.filter(({ tokenId }) => tokenId === selectedTokenId);
