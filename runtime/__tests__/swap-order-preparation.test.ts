import { describe, expect, test } from 'bun:test';
import { computeSwapPriceTicks, prepareSwapOrder, quantizeSwapOrder, SWAP_LOT_SCALE } from '../orderbook';

describe('prepareSwapOrder', () => {
  test('keeps an exact-lot sell-base order canonical with no leftover', () => {
    const giveTokenId = 2;
    const wantTokenId = 1;
    const giveAmount = 2n * SWAP_LOT_SCALE;
    const wantAmount = 5_000_000_000_000n;

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
    const giveTokenId = 3;
    const wantTokenId = 1;
    const giveAmount = 5_000_000_000_001n;
    const wantAmount = 2_500_000_000_000n;

    const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);

    expect(prepared).not.toBeNull();
    expect(prepared?.side).toBe(0);
    expect(prepared?.priceTicks).toBe(20_000n);
    expect(prepared?.rawBaseAmount).toBe(wantAmount);
    expect(prepared?.quantizedBaseAmount).toBe(2n * SWAP_LOT_SCALE);
    expect(prepared?.effectiveGive).toBe(4_000_000_000_000n);
    expect(prepared?.effectiveWant).toBe(2n * SWAP_LOT_SCALE);
    expect(prepared?.unspentGiveAmount).toBe(1_000_000_000_001n);
  });

  test('rejects orders below one base lot', () => {
    expect(prepareSwapOrder(2, 1, SWAP_LOT_SCALE - 1n, 1000n)).toBeNull();
    expect(prepareSwapOrder(3, 1, 1000n, SWAP_LOT_SCALE - 1n)).toBeNull();
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
});
