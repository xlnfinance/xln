import { describe, expect, test } from 'bun:test';
import { stageBarFor, ringLayout, compactAmount } from '../../frontend/src/lib/network3d/networkStage2d';

const derived = (over: Partial<Parameters<typeof stageBarFor>[0]> = {}) => ({
  delta: 0n,
  collateral: 0n,
  ownCreditLimit: 0n,
  peerCreditLimit: 0n,
  inOwnCredit: 0n,
  outPeerCredit: 0n,
  totalCapacity: 0n,
  ...over,
});

const kinds = (bar: ReturnType<typeof stageBarFor>) => bar.regions.map((region) => region.kind);
const sizeOf = (bar: ReturnType<typeof stageBarFor>, kind: string) =>
  bar.regions.find((region) => region.kind === kind)?.size ?? 0;

describe('stage capacity bar', () => {
  test('everything left of the marker is what LEFT can send', () => {
    // LEFT holds the whole collateral: it can send all of it and receive nothing.
    const bar = stageBarFor(derived({ collateral: 500n, delta: 500n }));

    expect(bar.markerAt).toBe(1);
    expect(kinds(bar)).toEqual(['collateralOwn']);
  });

  test('a balanced account puts the marker where collateral changes hands', () => {
    const bar = stageBarFor(derived({ collateral: 500n, delta: 0n }));

    expect(bar.markerAt).toBe(0);
    expect(kinds(bar)).toEqual(['collateralPeer']);
  });

  test('own collateral is drawn before peer collateral, so the split reads as one axis', () => {
    const bar = stageBarFor(derived({ collateral: 400n, delta: 100n }));

    expect(kinds(bar)).toEqual(['collateralOwn', 'collateralPeer']);
    expect(sizeOf(bar, 'collateralOwn')).toBeCloseTo(0.25, 5);
    expect(bar.markerAt).toBeCloseTo(0.25, 5);
  });

  test('drawn credit is a region of its own, on the side that drew it', () => {
    const owing = stageBarFor(derived({
      collateral: 0n,
      delta: -300n,
      ownCreditLimit: 1000n,
      inOwnCredit: 300n,
    }));
    expect(kinds(owing)).toEqual(['ownCreditFree', 'ownCreditDrawn']);
    expect(sizeOf(owing, 'ownCreditDrawn')).toBeCloseTo(0.3, 5);
    expect(owing.markerAt).toBeCloseTo(0.7, 5);

    const owed = stageBarFor(derived({
      collateral: 100n,
      delta: 400n,
      peerCreditLimit: 900n,
      outPeerCredit: 300n,
    }));
    expect(kinds(owed)).toEqual(['collateralOwn', 'peerCreditDrawn', 'peerCreditFree']);
  });

  test('a credit line cut below what was already drawn still shows the debt', () => {
    // deriveDelta widens the window to the drawn amount; the picture must not lose it.
    const bar = stageBarFor(derived({ delta: -500n, ownCreditLimit: 100n, inOwnCredit: 500n }));

    expect(sizeOf(bar, 'ownCreditDrawn')).toBe(1);
    expect(bar.markerAt).toBe(0);
  });

  test('an account with nothing in it draws nothing', () => {
    expect(stageBarFor(derived()).regions).toEqual([]);
  });
});

describe('stage helpers', () => {
  test('ring layout is deterministic so nodes never jump between steps', () => {
    expect(ringLayout(4, 10)).toEqual(ringLayout(4, 10));
    expect(ringLayout(0, 10)).toEqual([]);
    expect(ringLayout(1, 10)).toEqual([{ x: 0, y: 0 }]);
  });

  test('compact amounts stay short enough for a node badge', () => {
    expect(compactAmount(2_500_000)).toBe('2.5M');
    expect(compactAmount(850_000)).toBe('850K');
    expect(compactAmount(1_200)).toBe('1.2K');
    expect(compactAmount(12_000_000)).toBe('12M');
    expect(compactAmount(0)).toBe('0');
  });
});
