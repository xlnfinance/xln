import type { AssetLedgerRow } from './asset-ledger';
import { requireTokenDecimals } from './token-metadata';

export type ExternalToken = {
  symbol: string;
  address: string;
  balance: bigint;
  decimals: number;
  tokenId: number | undefined;
  readError?: string;
};

export type ReserveTransferAsset = {
  symbol: string;
  address: string;
  balance: bigint;
  decimals: number;
  tokenId: number;
};

export type ReserveTokenMeta = {
  tokenId: number;
  symbol: string;
  decimals: number;
};

const TOKEN_UI_ORDER = ['ETH', 'WETH', 'USDT', 'USDC'];

export function isReserveTransferToken(token: ExternalToken): token is ExternalToken & { tokenId: number } {
  return typeof token.tokenId === 'number' && token.tokenId > 0;
}

export function getTokenUiRank(symbol: string): number {
  const normalized = String(symbol || '').trim().toUpperCase();
  const index = TOKEN_UI_ORDER.indexOf(normalized);
  return index >= 0 ? index : TOKEN_UI_ORDER.length + 100;
}

export function compareEntityAssetText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareTokenSymbols(left: string, right: string): number {
  const leftRank = getTokenUiRank(left);
  const rightRank = getTokenUiRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return compareEntityAssetText(left, right);
}

const canonicalTokenId = (value: number | undefined): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;

const canonicalAddress = (value: string): string => String(value || '').trim().toLowerCase();

export function getExternalTokenIdentityKey(token: Pick<ExternalToken, 'tokenId' | 'address'>): string {
  const tokenId = canonicalTokenId(token.tokenId);
  if (tokenId !== null) return `token:${tokenId}`;
  const address = canonicalAddress(token.address);
  if (address) return `address:${address}`;
  throw new Error('ASSET_IDENTITY_REQUIRED');
}

export function getAssetLedgerRowIdentityKey(row: Pick<AssetLedgerRow, 'tokenId' | 'address'>): string {
  const tokenId = canonicalTokenId(row.tokenId);
  if (tokenId !== null) return `token:${tokenId}`;
  const address = canonicalAddress(row.address);
  if (address) return `address:${address}`;
  throw new Error('ASSET_LEDGER_IDENTITY_REQUIRED');
}

const requireUniqueSymbolMatch = <T>(
  values: readonly T[],
  symbol: string,
  readSymbol: (value: T) => string,
  readIdentity: (value: T) => string,
): T | null => {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return null;
  const matches = values.filter((value) => readSymbol(value).trim().toUpperCase() === normalized);
  if (matches.length > 1) {
    throw new Error(
      `ASSET_SYMBOL_AMBIGUOUS:${normalized}:${matches.map(readIdentity).sort().join(',')}`,
    );
  }
  return matches[0] ?? null;
};

export function sortExternalTokens(tokens: ExternalToken[]): ExternalToken[] {
  const byIdentity = new Map<string, ExternalToken>();
  for (const token of tokens) {
    const symbol = String(token.symbol || '').trim();
    if (!symbol) throw new Error(`ASSET_SYMBOL_REQUIRED:${getExternalTokenIdentityKey(token)}`);
    const key = getExternalTokenIdentityKey(token);
    const existing = byIdentity.get(key);
    if (existing) {
      throw new Error(`ASSET_IDENTITY_DUPLICATE:${key}`);
    }
    byIdentity.set(key, { ...token, symbol });
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareTokenSymbols(left.symbol, right.symbol) ||
    compareEntityAssetText(getExternalTokenIdentityKey(left), getExternalTokenIdentityKey(right))
  );
}

export function choosePreferredAssetSymbol(tokens: Array<{ symbol: string }>): string {
  const symbolCounts = new Map<string, number>();
  for (const token of tokens) {
    const symbol = String(token.symbol || '').trim().toUpperCase();
    if (symbol) symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
  }
  const candidates = tokens.filter((token) => {
    const symbol = String(token.symbol || '').trim().toUpperCase();
    return symbol.length > 0 && symbolCounts.get(symbol) === 1;
  });
  const preferred = [...candidates].sort((left, right) => compareTokenSymbols(left.symbol, right.symbol))[0]?.symbol;
  return preferred ?? (tokens.length === 0 ? 'USDC' : '');
}

export function findExternalTokenBySymbol(tokens: ExternalToken[], symbol: string): ExternalToken | null {
  return requireUniqueSymbolMatch(
    tokens,
    symbol,
    (token) => token.symbol,
    getExternalTokenIdentityKey,
  );
}

export function findAssetLedgerRowBySymbol(rows: AssetLedgerRow[], symbol: string): AssetLedgerRow | null {
  return requireUniqueSymbolMatch(
    rows,
    symbol,
    (row) => row.symbol,
    getAssetLedgerRowIdentityKey,
  );
}

export function resolveReserveTransferTokenBySymbol(options: {
  symbol: string;
  externalTokens: ExternalToken[];
  assetLedgerRows: AssetLedgerRow[];
  resolveReserveTokenMeta: (tokenId: number, symbolHint?: string) => ReserveTokenMeta;
}): ReserveTransferAsset | null {
  const token = findExternalTokenBySymbol(options.externalTokens, options.symbol);
  if (token && isReserveTransferToken(token)) {
    return token;
  }
  const row = findAssetLedgerRowBySymbol(options.assetLedgerRows, options.symbol);
  if (!row || row.isNative || typeof row.tokenId !== 'number' || row.tokenId <= 0) return null;
  const meta = options.resolveReserveTokenMeta(row.tokenId, row.symbol);
  return {
    symbol: row.symbol,
    address: row.address || '',
    balance: row.externalBalance ?? 0n,
    decimals: row.decimals ?? meta.decimals,
    tokenId: row.tokenId,
  };
}

export function resolveReserveTokenMetaFromCatalog(options: {
  tokenId: number;
  symbolHint?: string;
  externalTokens: ExternalToken[];
  getTokenInfo: (tokenId: number) => { symbol?: string; decimals?: number };
}): ReserveTokenMeta {
  const byId = options.externalTokens.find(
    (token) => typeof token.tokenId === 'number' && token.tokenId === options.tokenId,
  );
  if (byId) {
    return {
      tokenId: byId.tokenId as number,
      symbol: byId.symbol,
      decimals: requireTokenDecimals(byId.decimals, `token:${options.tokenId}`),
    };
  }
  if (options.symbolHint) {
    const bySymbol = options.externalTokens.find(
      (token) => token.symbol?.toUpperCase?.() === options.symbolHint!.toUpperCase(),
    );
    if (bySymbol && typeof bySymbol.tokenId === 'number') {
      return {
        tokenId: bySymbol.tokenId,
        symbol: bySymbol.symbol,
        decimals: requireTokenDecimals(bySymbol.decimals, `token:${bySymbol.tokenId}`),
      };
    }
  }
  const info = options.getTokenInfo(options.tokenId);
  return {
    tokenId: options.tokenId,
    symbol: info.symbol ?? 'UNK',
    decimals: requireTokenDecimals(info.decimals, `token:${options.tokenId}`),
  };
}

export function getFaucetReserveTokenMeta(rows: AssetLedgerRow[], symbol: string): { tokenId: number; symbol: string } | null {
  const row = findAssetLedgerRowBySymbol(rows, symbol);
  if (!row || row.isNative || typeof row.tokenId !== 'number' || row.tokenId <= 0) return null;
  return {
    tokenId: row.tokenId,
    symbol: row.symbol,
  };
}

export function requireExternalTokenBySymbol(tokens: ExternalToken[], symbol: string): ExternalToken {
  const token = findExternalTokenBySymbol(tokens, symbol);
  if (!token) throw new Error(`Unknown asset ${symbol}`);
  return token;
}
