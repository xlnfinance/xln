import { describe, expect, test } from 'bun:test';

import {
  resolveReserveTokenMetaFromCatalog,
} from '../../frontend/src/lib/components/Entity/entity-asset-catalog';
import {
  getAssetValueUsd,
  getExternalTokenValueUsd,
} from '../../frontend/src/lib/components/Entity/entity-asset-values';
import { remainingOfferUsd } from '../../frontend/src/lib/components/Entity/swap-order-history';
import {
  RCPAN_MICROSCOPE_TOKENS,
  tokenAmountToUsdMicros,
} from '../../frontend/src/lib/components/Rcpan/microscope-tokens';
import type { SwapBookEntry } from '../types';
import {
  formatGraphEntityReserveBalances,
  formatGraphReserveBadge,
} from '../../frontend/src/lib/view/panels/graph3d-helpers';

describe('rendered token metadata is exact', () => {
  test('jurisdiction catalog decimals win for a custom token', () => {
    const meta = resolveReserveTokenMetaFromCatalog({
      tokenId: 9,
      externalTokens: [{
        tokenId: 9,
        address: '0x0000000000000000000000000000000000000009',
        symbol: 'C8',
        decimals: 8,
        balance: 100_000_000n,
      }],
      getTokenInfo: () => {
        throw new Error('STATIC_CATALOG_MUST_NOT_OVERRIDE_JURISDICTION_TOKEN');
      },
    });

    expect(meta).toEqual({ tokenId: 9, symbol: 'C8', decimals: 8 });
    expect(getExternalTokenValueUsd({
      balance: 100_000_000n,
      symbol: 'USDC',
      decimals: meta.decimals,
    })).toBe(1);
  });

  test('missing catalog decimals fail instead of silently assuming 18', () => {
    expect(() => resolveReserveTokenMetaFromCatalog({
      tokenId: 9,
      externalTokens: [{
        tokenId: 9,
        address: '0x0000000000000000000000000000000000000009',
        symbol: 'BROKEN',
        decimals: undefined,
        balance: 1n,
      } as never],
      getTokenInfo: () => ({ symbol: 'BROKEN' }),
    })).toThrow('TOKEN_DECIMALS_REQUIRED:token:9');

    expect(() => getAssetValueUsd(1n, { symbol: 'USDC' }))
      .toThrow('TOKEN_DECIMALS_REQUIRED:USDC');
    expect(() => getExternalTokenValueUsd({ balance: 1n, symbol: 'USDC' }))
      .toThrow('TOKEN_DECIMALS_REQUIRED:USDC');
  });

  test('order history refuses a token whose precision is unavailable', () => {
    const offer = {
      offerId: 'custom-token-offer',
      accountId: 'counterparty',
      giveTokenId: 9,
      giveAmount: 100_000_000n,
      wantTokenId: 1,
      wantAmount: 1_000_000n,
      minFillRatio: 0,
      createdHeight: 1,
    } as SwapBookEntry;

    expect(() => remainingOfferUsd(offer, () => ({ symbol: 'USDC' })))
      .toThrow('TOKEN_DECIMALS_REQUIRED:token:9');
  });

  test('microscope uses canonical raw units for six-decimal stables', () => {
    const usdc = RCPAN_MICROSCOPE_TOKENS.find((token) => token.tokenId === 1);
    expect(usdc?.decimals).toBe(6);
    expect(usdc?.grossAmount).toBe(1_000_000n * 10n ** 6n);
    expect(usdc && tokenAmountToUsdMicros(usdc, 1_000_000n)).toBe(1_000_000n);
  });

  test('3D labels render the selected custom token at its exact precision', () => {
    expect(formatGraphReserveBadge(100_000_000n, 8, 'C8')).toBe(' 1 C8');
    expect(formatGraphEntityReserveBalances({
      reserves: new Map([[9, 123_456_789n]]),
      selectedTokenId: 9,
      getTokenSymbol: () => 'C8',
      getTokenDecimals: () => 8,
    })).toBe('▸ C8: 1.2345');
  });

  test('production render code contains no silent eighteen-decimal fallback', async () => {
    const glob = new Bun.Glob('frontend/src/lib/**/*.{ts,svelte}');
    for await (const path of glob.scan({ cwd: process.cwd(), absolute: true })) {
      const source = await Bun.file(path).text();
      expect(source).not.toMatch(/\?\?\s*18\b/);
      expect(source).not.toMatch(/decimals\s*\|\|\s*18\b/);
      expect(source).not.toMatch(/decimals\s*:\s*number\s*=\s*18\b/);
      expect(source).not.toMatch(/(?:const|let)\s+decimals\s*=\s*18\b/);
      expect(source).not.toMatch(/Number\.isFinite\([^\n]*decimals[^\n]*\)\s*\?[^\n:]+:\s*18\b/);
    }
  });
});
