import { afterEach, describe, expect, test } from 'bun:test';
import {
  CAPACITY_REGION_ORDER,
  capacityVector,
  creditStrain,
  easeCapacity,
  lerpCapacity,
  stageBarFor,
} from '../../frontend/src/lib/network3d/capacityBar';
import {
  CAPACITY_MOTION_MS,
  beginCapacityMotion,
  lastDrawnCapacity,
  resetCapacityMotion,
  updateCapacityMotion,
  type CapacityMotionFrame,
} from '../../frontend/src/lib/network3d/accountBarMotion';

const derived = (over: Record<string, bigint> = {}) => ({
  delta: 0n,
  collateral: 0n,
  ownCreditLimit: 0n,
  peerCreditLimit: 0n,
  inOwnCredit: 0n,
  outPeerCredit: 0n,
  totalCapacity: 0n,
  ...over,
});

const at = (vector: { sizes: number[] }, kind: (typeof CAPACITY_REGION_ORDER)[number]): number =>
  vector.sizes[CAPACITY_REGION_ORDER.indexOf(kind)] ?? 0;

afterEach(() => resetCapacityMotion());

describe('capacity vector', () => {
  test('always carries all six regions, absent ones as zero', () => {
    const vector = capacityVector(stageBarFor(derived({ collateral: 400n, delta: 100n })));

    expect(vector.sizes).toHaveLength(CAPACITY_REGION_ORDER.length);
    expect(at(vector, 'collateralOwn')).toBeCloseTo(0.25, 5);
    expect(at(vector, 'ownCreditDrawn')).toBe(0);
  });

  test('a payment moves the marker and reallocates the shares around it', () => {
    // Same account, same collateral: only who owns which part of it changed.
    const before = capacityVector(stageBarFor(derived({ collateral: 400n, delta: 100n })));
    const after = capacityVector(stageBarFor(derived({ collateral: 400n, delta: 300n })));

    expect(after.markerAt).toBeGreaterThan(before.markerAt);
    expect(at(after, 'collateralOwn')).toBeGreaterThan(at(before, 'collateralOwn'));
    expect(at(after, 'collateralPeer')).toBeLessThan(at(before, 'collateralPeer'));
    // Nothing appeared or vanished — the total is the same bar.
    const sum = (sizes: number[]) => sizes.reduce((total, size) => total + size, 0);
    expect(sum(after.sizes)).toBeCloseTo(sum(before.sizes), 5);
  });
});

describe('interpolation', () => {
  test('ends exactly on the target so a bar never settles slightly wrong', () => {
    const from = capacityVector(stageBarFor(derived({ collateral: 400n, delta: 0n })));
    const to = capacityVector(stageBarFor(derived({ collateral: 400n, delta: 400n })));

    const landed = lerpCapacity(from, to, 1);
    expect(landed.markerAt).toBeCloseTo(to.markerAt, 9);
    expect(landed.sizes).toEqual(to.sizes);
  });

  test('eases out: most of the move happens early', () => {
    expect(easeCapacity(0)).toBe(0);
    expect(easeCapacity(1)).toBe(1);
    expect(easeCapacity(0.5)).toBeGreaterThan(0.5);
    expect(easeCapacity(2)).toBe(1);
  });
});

describe('credit strain', () => {
  test('is how much of a line is drawn, not how large the debt is', () => {
    const smallLineNearlyUsed = capacityVector(
      stageBarFor(derived({ delta: -90n, ownCreditLimit: 100n, inOwnCredit: 90n })),
    );
    const hugeLineBarelyTouched = capacityVector(
      stageBarFor(derived({ delta: -90n, ownCreditLimit: 10_000n, inOwnCredit: 90n })),
    );

    expect(creditStrain(smallLineNearlyUsed).own).toBeCloseTo(0.9, 5);
    expect(creditStrain(hugeLineBarelyTouched).own).toBeLessThan(0.02);
  });

  test('an untouched account is under no strain at all', () => {
    const vector = capacityVector(stageBarFor(derived({ collateral: 500n, delta: 0n })));

    expect(creditStrain(vector)).toEqual({ own: 0, peer: 0 });
  });
});

describe('motion registry', () => {
  const vectorFor = (delta: bigint) => capacityVector(stageBarFor(derived({ collateral: 400n, delta })));

  test('an account seen for the first time is drawn where it is, not slid in', () => {
    const target = vectorFor(100n);
    const frame = beginCapacityMotion('a|b|1', target, 0, () => {});

    expect(frame.moving).toBe(false);
    expect(frame.vector.markerAt).toBeCloseTo(target.markerAt, 9);
  });

  test('a changed account starts at where it was drawn and lands on the target', () => {
    beginCapacityMotion('a|b|1', vectorFor(100n), 0, () => {});
    const seen: CapacityMotionFrame[] = [];
    const target = vectorFor(300n);
    const first = beginCapacityMotion('a|b|1', target, 1_000, (frame) => seen.push(frame));

    expect(first.moving).toBe(true);
    expect(first.vector.markerAt).toBeCloseTo(vectorFor(100n).markerAt, 9);

    updateCapacityMotion(1_000 + CAPACITY_MOTION_MS / 2);
    updateCapacityMotion(1_000 + CAPACITY_MOTION_MS);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.moving).toBe(true);
    expect(seen[1]?.moving).toBe(false);
    expect(seen[1]?.vector.markerAt).toBeCloseTo(target.markerAt, 9);
    // Nothing keeps ticking once it has landed.
    updateCapacityMotion(9_999);
    expect(seen).toHaveLength(2);
  });

  test('an unchanged account does not animate', () => {
    beginCapacityMotion('a|b|1', vectorFor(100n), 0, () => {});
    const seen: CapacityMotionFrame[] = [];
    const frame = beginCapacityMotion('a|b|1', vectorFor(100n), 1_000, (next) => seen.push(next));

    expect(frame.moving).toBe(false);
    updateCapacityMotion(2_000);
    expect(seen).toHaveLength(0);
  });

  test('resetting forgets history, so a scrub is not drawn as a reallocation', () => {
    beginCapacityMotion('a|b|1', vectorFor(100n), 0, () => {});
    resetCapacityMotion();

    expect(lastDrawnCapacity('a|b|1').sizes.every((size) => size === 0)).toBe(true);
    expect(beginCapacityMotion('a|b|1', vectorFor(300n), 1_000, () => {}).moving).toBe(false);
  });
});
