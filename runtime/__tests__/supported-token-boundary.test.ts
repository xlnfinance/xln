import { describe, expect, test } from 'bun:test';

import { getTokenInfo } from '../account/utils';
import { defaultTokensForJurisdiction } from '../jadapter/default-tokens';
import { getBootstrapCreditAmount } from '../orchestrator/mesh-common';

describe('supported-token metadata boundary', () => {
  test('Base USDC financial amounts use its canonical six decimals', () => {
    const usdc = defaultTokensForJurisdiction({ chainId: 8_453 })
      .find((token) => token.symbol === 'USDC');
    expect(usdc).toBeDefined();
    expect(usdc?.decimals).toBe(6);

    const getCredit = getBootstrapCreditAmount as unknown as (
      tokenId: number,
      decimals: number,
    ) => bigint;
    expect(getCredit(1, usdc!.decimals)).toBe(1_000_000n * 10n ** 6n);
  });

  test('unknown compact token IDs never invent 18-decimal metadata', () => {
    expect(() => getTokenInfo(999_999)).toThrow('TOKEN_METADATA_UNAVAILABLE');
  });
});
