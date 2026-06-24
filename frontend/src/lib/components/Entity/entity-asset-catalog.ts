import type { AssetLedgerRow } from './asset-ledger';

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

export function sortExternalTokens(tokens: ExternalToken[]): ExternalToken[] {
  const deduped = new Map<string, ExternalToken>();
  for (const token of tokens) {
    const key = String(token.symbol || '').trim().toUpperCase();
    if (!key) continue;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, token);
      continue;
    }
    deduped.set(key, {
      ...existing,
      address: existing.address || token.address,
      decimals: existing.decimals ?? token.decimals,
      tokenId: existing.tokenId ?? token.tokenId,
      balance: existing.balance > token.balance ? existing.balance : token.balance,
    });
  }
  return [...deduped.values()].sort((left, right) => compareTokenSymbols(left.symbol, right.symbol));
}

export function choosePreferredAssetSymbol(tokens: Array<{ symbol: string }>): string {
  const candidates = tokens.filter((token) => String(token.symbol || '').trim().length > 0);
  return [...candidates].sort((left, right) => compareTokenSymbols(left.symbol, right.symbol))[0]?.symbol ?? 'USDC';
}

export function findExternalTokenBySymbol(tokens: ExternalToken[], symbol: string): ExternalToken | null {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return null;
  return tokens.find((token) => String(token.symbol || '').trim().toUpperCase() === normalized) ?? null;
}

export function findAssetLedgerRowBySymbol(rows: AssetLedgerRow[], symbol: string): AssetLedgerRow | null {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return null;
  return rows.find((row) => String(row.symbol || '').trim().toUpperCase() === normalized) ?? null;
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
    return { tokenId: byId.tokenId as number, symbol: byId.symbol, decimals: byId.decimals ?? 18 };
  }
  if (options.symbolHint) {
    const bySymbol = options.externalTokens.find(
      (token) => token.symbol?.toUpperCase?.() === options.symbolHint!.toUpperCase(),
    );
    if (bySymbol && typeof bySymbol.tokenId === 'number') {
      return { tokenId: bySymbol.tokenId, symbol: bySymbol.symbol, decimals: bySymbol.decimals ?? 18 };
    }
  }
  const info = options.getTokenInfo(options.tokenId);
  return { tokenId: options.tokenId, symbol: info.symbol ?? 'UNK', decimals: info.decimals ?? 18 };
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
