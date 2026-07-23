import { describe, expect, test } from 'bun:test';
import { computeSwapPriceTicks, prepareSwapOrder, quantizeSwapOrder, SWAP_LOT_SCALE } from '../orderbook';

describe('prepareSwapOrder', () => {
  test('prices raw WETH-18 and USDC-6 amounts in human token units', () => {
    const giveAmount = 2n * 10n ** 18n;
    const wantAmount = 5_000n * 10n ** 6n;

    const prepared = prepareSwapOrder(2, 1, giveAmount, wantAmount);

    expect(prepared).not.toBeNull();
    expect(prepared?.priceTicks).toBe(25_000_000n);
    expect(prepared?.effectiveGive).toBe(giveAmount);
    expect(prepared?.effectiveWant).toBe(wantAmount);
  });

  test('prepares a full-capacity WETH sell at an exact MM book level', () => {
    const giveAmount = 15n * 10n ** 18n;
    const wantAmount = 37_492_500_000n;

    const prepared = prepareSwapOrder(2, 1, giveAmount, wantAmount);

    expect(prepared).not.toBeNull();
    expect(prepared?.priceTicks).toBe(24_995_000n);
    expect(prepared?.effectiveGive).toBe(giveAmount);
    expect(prepared?.effectiveWant).toBe(wantAmount);
    expect(prepared?.unspentGiveAmount).toBe(0n);
  });

  test('uses one raw unit as the lot for six-decimal base assets', () => {
    const prepared = prepareSwapOrder(1, 3, 1n, 1n);

    expect(prepared).not.toBeNull();
    expect(prepared?.priceTicks).toBe(10_000n);
    expect(prepared?.quantizedBaseAmount).toBe(1n);
    expect(prepared?.quantizedQuoteAmount).toBe(1n);
  });

  test('keeps an exact-lot sell-base order canonical with no leftover', () => {
    const giveTokenId = 2;
    const wantTokenId = 1;
    const giveAmount = 2n * SWAP_LOT_SCALE;
    const wantAmount = 5_000n;

    const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);

    expect(prepared).not.toBeNull();
    expect(prepared?.side).toBe(1);
    expect(prepared?.priceTicks).toBe(computeSwapPriceTicks(giveTokenId, wantTokenId, giveAmount, wantAmount));
    expect(prepared?.quantizedBaseAmount).toBe(giveAmount);
    expect(prepared?.quantizedQuoteAmount).toBe(wantAmount);
    expect(prepared?.effectiveGive).toBe(giveAmount);
    expect(prepared?.effectiveWant).toBe(wantAmount);
    expect(prepared?.unspentGiveAmount).toBe(0n);
  });

  test('reports unspent quote on buy-base when desired base is not lot-aligned', () => {
    const giveTokenId = 1;
    const wantTokenId = 2;
    const giveAmount = 5n;
    const wantAmount = 2n * SWAP_LOT_SCALE + SWAP_LOT_SCALE / 2n;

    const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);

    expect(prepared).not.toBeNull();
    expect(prepared?.side).toBe(0);
    expect(prepared?.priceTicks).toBe(20_000n);
    expect(prepared?.rawBaseAmount).toBe(wantAmount);
    expect(prepared?.quantizedBaseAmount).toBe(2n * SWAP_LOT_SCALE);
    expect(prepared?.effectiveGive).toBe(4n);
    expect(prepared?.effectiveWant).toBe(2n * SWAP_LOT_SCALE);
    expect(prepared?.unspentGiveAmount).toBe(1n);
  });

  test('rejects orders below one base lot', () => {
    expect(prepareSwapOrder(2, 1, SWAP_LOT_SCALE - 1n, 1000n)).toBeNull();
    expect(prepareSwapOrder(1, 2, 1000n, SWAP_LOT_SCALE - 1n)).toBeNull();
  });

  test('quantizeSwapOrder matches the canonical preparation subset', () => {
    const giveTokenId = 3;
    const wantTokenId = 1;
    const giveAmount = 5_000_000_000_001n;
    const wantAmount = 2_500_000_000_000n;

    const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);
    const quantized = quantizeSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);

    expect(prepared).not.toBeNull();
    expect(quantized).toEqual({
      effectiveGive: prepared?.effectiveGive,
      effectiveWant: prepared?.effectiveWant,
      priceTicks: prepared?.priceTicks,
    });
  });

  test('rounds SELL price up when raw quote/base division has remainder', () => {
    const giveTokenId = 2;
    const wantTokenId = 1;
    const giveAmount = 3n * 10n ** 18n;
    const wantAmount = 1n * 10n ** 6n;

    expect(computeSwapPriceTicks(giveTokenId, wantTokenId, giveAmount, wantAmount)).toBe(3334n);

    const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);
    expect(prepared).not.toBeNull();
    expect(prepared?.side).toBe(1);
    expect(prepared?.priceTicks).toBe(3334n);
  });
});
