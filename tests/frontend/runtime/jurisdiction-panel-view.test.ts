import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildJurisdictionTokenOptions,
  filterJurisdictionRowsByToken,
  formatJurisdictionBalance,
  formatJurisdictionEntityId,
  formatJurisdictionEthAmount,
  formatJurisdictionStateRoot,
  isBrowserVmDebugAdapter,
  parseJurisdictionTokenId,
  selectJurisdictionTokenIdText,
  selectJurisdictionTokenMeta,
  toJurisdictionDisplayBigInt,
} from '../../../frontend/packages/runtime-client/src/jurisdiction-panel-view';

describe('Jurisdiction panel view model', () => {
  test('recognizes BrowserVM debug adapters without broad object assertions', () => {
    expect(isBrowserVmDebugAdapter({ mode: 'browservm' })).toBe(true);
    expect(isBrowserVmDebugAdapter({ mode: 'browservm', timeTravel: async () => undefined })).toBe(true);
    expect(isBrowserVmDebugAdapter({ mode: 'browservm', timeTravel: true })).toBe(true);
    expect(isBrowserVmDebugAdapter({ mode: 'remote' })).toBe(false);
    expect(isBrowserVmDebugAdapter(null)).toBe(false);
  });

  test('preserves canonical bigint display coercions for live and serialized frames', () => {
    expect(toJurisdictionDisplayBigInt(7n)).toBe(7n);
    expect(toJurisdictionDisplayBigInt(8)).toBe(8n);
    expect(toJurisdictionDisplayBigInt('-9')).toBe(-9n);
    expect(toJurisdictionDisplayBigInt({ _dataType: 'BigInt', value: '10' })).toBe(10n);
    expect(toJurisdictionDisplayBigInt({ toString: () => 'BigInt(-11)' })).toBe(-11n);
    expect(toJurisdictionDisplayBigInt({ unexpected: true })).toBe(0n);
  });

  test('formats identity, roots, compact balances, and bounded ETH precision', () => {
    expect(formatJurisdictionEntityId('')).toBe('N/A');
    expect(formatJurisdictionEntityId('0xabc')).toBe('0xabc');
    expect(formatJurisdictionStateRoot(null)).toBe('Unavailable');
    expect(formatJurisdictionStateRoot(new Uint8Array([0, 15, 255]))).toBe('0x000fff');
    expect(formatJurisdictionBalance(1_250_000n * 10n ** 18n)).toBe('$1.3M');
    expect(formatJurisdictionBalance(1_250n * 10n ** 18n)).toBe('$1K');
    expect(formatJurisdictionEthAmount(1_234_500_000_000_000_000n, 4)).toBe('1.2345 ETH');
    expect(formatJurisdictionEthAmount(-1_200_000_000_000_000_000n, 30)).toBe('-1.2 ETH');
  });

  test('deduplicates BrowserVM tokens ahead of fallback metadata and sorts by token id', () => {
    const fallbackCalls: number[] = [];
    const options = buildJurisdictionTokenOptions({
      browserTokens: [
        { tokenId: 2, symbol: 'TWO', decimals: 6, address: '0xtwo' },
        { tokenId: 2, symbol: 'DUPLICATE', decimals: 18 },
      ],
      reserveTokenIds: [3, 2],
      collateralTokenIds: [1, 3],
      getFallbackTokenInfo: (tokenId) => {
        fallbackCalls.push(tokenId);
        return { symbol: `T${tokenId}`, decimals: tokenId, name: `Token ${tokenId}` };
      },
    });

    expect(options.map(({ tokenId }) => tokenId)).toEqual([1, 2, 3]);
    expect(options[1]).toMatchObject({ symbol: 'TWO', address: '0xtwo' });
    expect(options[0]).toMatchObject({ symbol: 'T1', address: undefined });
    expect(fallbackCalls).toEqual([3, 1]);
  });

  test('preserves token selection, metadata fallback, and row filtering semantics', () => {
    const options = buildJurisdictionTokenOptions({
      browserTokens: [], reserveTokenIds: [3, 1], collateralTokenIds: [],
      getFallbackTokenInfo: (tokenId) => ({ symbol: `T${tokenId}`, decimals: 6 }),
    });
    expect(selectJurisdictionTokenIdText(options, '')).toBe('1');
    expect(selectJurisdictionTokenIdText(options, '3')).toBe('3');
    expect(selectJurisdictionTokenIdText([], '3')).toBe('');
    expect(parseJurisdictionTokenId('')).toBeNull();
    expect(parseJurisdictionTokenId('nope')).toBeNull();
    expect(parseJurisdictionTokenId('3')).toBe(3);
    expect(selectJurisdictionTokenMeta(options, 3, () => ({ symbol: 'unused', decimals: 0 }))?.symbol).toBe('T3');
    expect(selectJurisdictionTokenMeta(options, 9, () => ({ symbol: 'T9', decimals: 18 }))).toMatchObject({
      tokenId: 9, symbol: 'T9', decimals: 18, address: undefined,
    });
    const rows = [{ tokenId: 1, id: 'one' }, { tokenId: 3, id: 'three' }];
    expect(filterJurisdictionRowsByToken(rows, 3)).toEqual([rows[1]]);
    expect(filterJurisdictionRowsByToken(rows, null)).toEqual(rows);
    expect(rows).toHaveLength(2);
  });

  test('keeps Runtime/JAdapter reads, time travel, and panel events in Svelte', () => {
    const source = readFileSync('frontend/src/lib/view/panels/JurisdictionPanel.svelte', 'utf8');
    const shared = readFileSync('frontend/packages/runtime-client/src/jurisdiction-panel-view.ts', 'utf8');

    expect(source).toContain("from '../../../../packages/runtime-client/src/jurisdiction-panel-view'");
    expect(source).toContain('$runtimeFrameEnv');
    expect(source).toContain('jadapter.timeTravel');
    expect(source).toContain("panelBridge.emit('entity:selected'");
    expect(source).toContain('buildJurisdictionTokenOptions');
    expect(source).not.toContain('function toBigInt');
    expect(shared).not.toContain('runtimeFrameEnv');
    expect(shared).not.toContain('panelBridge');
  });
});
