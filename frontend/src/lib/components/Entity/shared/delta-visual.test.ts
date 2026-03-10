import { describe, expect, test } from 'bun:test';
import { buildTokenVisualScale } from './delta-visual';
import type { DeltaParts } from './delta-types';

const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n;
const wethFromUsd = (usd: number): bigint => (BigInt(usd) * 10n ** 18n) / 3500n;

describe('delta visual scaling', () => {
  test('shrinks visible outbound slices to current post-hold capacity', () => {
    const derived: DeltaParts = {
      outCapacity: usdc(500),
      inCapacity: usdc(250),
      outOwnCredit: usdc(600),
      outCollateral: usdc(300),
      outPeerCredit: usdc(100),
      inOwnCredit: usdc(100),
      inCollateral: usdc(100),
      inPeerCredit: usdc(100),
      outTotalHold: usdc(500),
      inTotalHold: usdc(50),
    };

    const scale = buildTokenVisualScale('USDC', 6, derived);
    expect(scale).not.toBeNull();
    if (!scale) throw new Error('scale missing');

    expect(scale.outCapacityUsd).toBe(500);
    expect(scale.outOwnCreditUsd).toBeCloseTo(300, 6);
    expect(scale.outCollateralUsd).toBeCloseTo(150, 6);
    expect(scale.outPeerCreditUsd).toBeCloseTo(50, 6);
    expect(scale.outTotalUsd).toBeCloseTo(500, 6);
  });

  test('maps equal USD values to equal visual widths across tokens', () => {
    const usdcScale = buildTokenVisualScale('USDC', 6, {
      outCapacity: usdc(100),
      inCapacity: 0n,
      outOwnCredit: usdc(100),
      outCollateral: 0n,
      outPeerCredit: 0n,
      inOwnCredit: 0n,
      inCollateral: 0n,
      inPeerCredit: 0n,
    });
    const wethScale = buildTokenVisualScale('WETH', 18, {
      outCapacity: wethFromUsd(100),
      inCapacity: 0n,
      outOwnCredit: wethFromUsd(100),
      outCollateral: 0n,
      outPeerCredit: 0n,
      inOwnCredit: 0n,
      inCollateral: 0n,
      inPeerCredit: 0n,
    });

    expect(usdcScale).not.toBeNull();
    expect(wethScale).not.toBeNull();
    if (!usdcScale || !wethScale) throw new Error('missing scale');

    const diff = Math.abs(usdcScale.outCapacityUsd - wethScale.outCapacityUsd);
    expect(diff).toBeLessThan(0.01);
  });
});
