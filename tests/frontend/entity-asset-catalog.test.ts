import { describe, expect, test } from 'bun:test';

import type { AssetLedgerRow } from '../../frontend/src/lib/components/Entity/asset-ledger';
import {
  choosePreferredAssetSymbol,
  compareTokenSymbols,
  findAssetLedgerRowBySymbol,
  findExternalTokenBySymbol,
  getExternalTokenIdentityKey,
  getFaucetReserveTokenMeta,
  isReserveTransferToken,
  requireExternalTokenBySymbol,
  resolveReserveTokenMetaFromCatalog,
  resolveReserveTransferTokenBySymbol,
  sortExternalTokens,
  type ExternalToken,
} from '../../frontend/src/lib/components/Entity/entity-asset-catalog';

const token = (input: Partial<ExternalToken> & { symbol: string; balance?: bigint }): ExternalToken => ({
  symbol: input.symbol,
  address: input.address ?? `0x${input.symbol.toLowerCase()}`,
  balance: input.balance ?? 0n,
  decimals: input.decimals ?? 6,
  tokenId: input.tokenId,
  readError: input.readError,
});

const row = (input: Partial<AssetLedgerRow> & { symbol: string; tokenId?: number }): AssetLedgerRow => ({
  symbol: input.symbol,
  address: input.address ?? `0x${input.symbol.toLowerCase()}`,
  decimals: input.decimals ?? 6,
  tokenId: input.tokenId,
  isNative: input.isNative ?? false,
  externalBalance: input.externalBalance ?? 0n,
  reserveBalance: input.reserveBalance ?? 0n,
  accountBalance: input.accountBalance ?? 0n,
  externalUsd: input.externalUsd ?? 0,
  reserveUsd: input.reserveUsd ?? 0,
  accountUsd: input.accountUsd ?? 0,
  totalUsd: input.totalUsd ?? 0,
  externalError: input.externalError,
});

describe('entity asset catalog helpers', () => {
  test('sorts known token symbols by UI rank and then text', () => {
    expect(['ZZZ', 'USDC', 'ETH', 'USDT', 'ABC'].sort(compareTokenSymbols))
      .toEqual(['ETH', 'USDT', 'USDC', 'ABC', 'ZZZ']);
  });

  test('retains distinct registered assets even when their symbols collide', () => {
    const sorted = sortExternalTokens([
      token({ symbol: 'USDC', address: '0xusdc1', balance: 1n, tokenId: 1 }),
      token({ symbol: 'ETH', balance: 2n }),
      token({ symbol: 'usdc', address: '0xusdc2', balance: 5n, tokenId: 2 }),
    ]);

    expect(sorted.map((entry) => [entry.symbol, entry.address, entry.balance, entry.tokenId])).toEqual([
      ['ETH', '0xeth', 2n, undefined],
      ['USDC', '0xusdc1', 1n, 1],
      ['usdc', '0xusdc2', 5n, 2],
    ]);
    expect(choosePreferredAssetSymbol(sorted)).toBe('ETH');
    expect(() => findExternalTokenBySymbol(sorted, 'USDC')).toThrow(
      'ASSET_SYMBOL_AMBIGUOUS:USDC:token:1,token:2',
    );
  });

  test('rejects duplicate canonical identities instead of merging observations', () => {
    const first = token({ symbol: 'USDC', address: '0xusdc1', tokenId: 1 });
    expect(getExternalTokenIdentityKey(first)).toBe('token:1');
    expect(() => sortExternalTokens([
      first,
      token({ symbol: 'SPOOF', address: '0xattacker', tokenId: 1 }),
    ])).toThrow('ASSET_IDENTITY_DUPLICATE:token:1');
  });

  test('finds external tokens and ledger rows case-insensitively', () => {
    const tokens = [token({ symbol: 'USDC', tokenId: 1 })];
    const rows = [row({ symbol: 'USDT', tokenId: 2 })];

    expect(findExternalTokenBySymbol(tokens, 'usdc')?.tokenId).toBe(1);
    expect(findAssetLedgerRowBySymbol(rows, 'usdt')?.tokenId).toBe(2);
    expect(() => requireExternalTokenBySymbol(tokens, 'DAI')).toThrow('Unknown asset DAI');
  });

  test('resolves reserve transfer metadata from token first, then ledger row', () => {
    const tokens = [token({ symbol: 'USDC', tokenId: 1, balance: 7n })];
    const rows = [row({ symbol: 'USDT', tokenId: 2, externalBalance: 9n })];
    const resolveReserveTokenMeta = (tokenId: number, symbolHint?: string) => ({
      tokenId,
      symbol: symbolHint ?? `TKN${tokenId}`,
      decimals: 6,
    });

    expect(isReserveTransferToken(tokens[0])).toBe(true);
    expect(resolveReserveTransferTokenBySymbol({
      symbol: 'USDC',
      externalTokens: tokens,
      assetLedgerRows: rows,
      resolveReserveTokenMeta,
    })?.balance).toBe(7n);
    expect(resolveReserveTransferTokenBySymbol({
      symbol: 'USDT',
      externalTokens: [],
      assetLedgerRows: rows,
      resolveReserveTokenMeta,
    })).toMatchObject({ symbol: 'USDT', tokenId: 2, balance: 9n });
    expect(getFaucetReserveTokenMeta(rows, 'USDT')).toEqual({ tokenId: 2, symbol: 'USDT' });
  });

  test('resolves reserve token meta from catalog before runtime fallback', () => {
    const tokens = [
      token({ symbol: 'USDC', tokenId: 1, decimals: 6 }),
      token({ symbol: 'DAI', tokenId: 3, decimals: 18 }),
    ];

    expect(resolveReserveTokenMetaFromCatalog({
      tokenId: 1,
      externalTokens: tokens,
      getTokenInfo: () => ({ symbol: 'FALLBACK', decimals: 8 }),
    })).toEqual({ tokenId: 1, symbol: 'USDC', decimals: 6 });
    expect(resolveReserveTokenMetaFromCatalog({
      tokenId: 99,
      symbolHint: 'dai',
      externalTokens: tokens,
      getTokenInfo: () => ({ symbol: 'FALLBACK', decimals: 8 }),
    })).toEqual({ tokenId: 3, symbol: 'DAI', decimals: 18 });
    expect(resolveReserveTokenMetaFromCatalog({
      tokenId: 99,
      externalTokens: tokens,
      getTokenInfo: () => ({ symbol: 'FALLBACK', decimals: 8 }),
    })).toEqual({ tokenId: 99, symbol: 'FALLBACK', decimals: 8 });
  });
});
