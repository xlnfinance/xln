import { describe, expect, test } from 'bun:test';

import {
  buildSolvencyProjection,
  formatSolvencyAmount,
  getSolvencyStatusView,
  shortenSolvencyAddress,
  type SolvencyAsset,
} from '../../../frontend/packages/runtime-client/src/solvency-panel-view';

const asset = (stackId: string, tokenId: number): SolvencyAsset => ({
  stackId,
  chainId: Number(stackId.split(':')[0]),
  depositoryAddress: `0x${String(tokenId).padStart(40, '0')}`,
  tokenId,
  reserves: BigInt(tokenId * 100),
  confirmedCollateral: BigInt(tokenId * 10),
  internalValue: BigInt(tokenId * 110),
  expectedInternalValue: null,
  delta: null,
  isValid: null,
});

describe('solvency panel view model', () => {
  test('sorts Runtime-owned assets by stack and token without changing values', () => {
    const secondToken = asset('31337:0xbb', 2);
    const firstStack = asset('1:0xaa', 9);
    const firstToken = asset('31337:0xbb', 1);
    const projection = buildSolvencyProjection({
      byAsset: new Map([
        ['second-token', secondToken],
        ['first-stack', firstStack],
        ['first-token', firstToken],
      ]),
      isValid: null,
    });

    expect(projection.assets).toEqual([firstStack, firstToken, secondToken]);
    expect(projection.isValid).toBe(null);
  });

  test('preserves all three verification states with canonical labels', () => {
    expect(getSolvencyStatusView(true)).toEqual({
      icon: '✓', label: 'ASSET CONSERVATION OK', tone: 'valid',
    });
    expect(getSolvencyStatusView(false)).toEqual({
      icon: '⚠', label: 'ASSET IMBALANCE DETECTED', tone: 'invalid',
    });
    expect(getSolvencyStatusView(null)).toEqual({
      icon: '?', label: 'ASSET CONSERVATION NOT VERIFIED', tone: 'unchecked',
    });
  });

  test('formats raw bigint amounts and addresses like the canonical panel', () => {
    expect(formatSolvencyAmount(1_234_567n)).toBe('1,234,567');
    expect(formatSolvencyAmount(-42n)).toBe('-42');
    expect(shortenSolvencyAddress('0x1234567890abcdef1234567890abcdef12345678'))
      .toBe('0x123456…345678');
  });
});
