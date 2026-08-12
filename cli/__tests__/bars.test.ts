import { describe, expect, test } from 'bun:test';
import { buildClosedAscii, renderTwinBars, renderCapacityBar } from '../lib/presentation/bars';
import type { DerivedDelta } from '../lib/runtime-types';

const sampleDerived = (overrides: Partial<DerivedDelta> = {}): DerivedDelta => ({
  delta: 0n,
  collateral: 100n,
  inCollateral: 50n,
  outCollateral: 50n,
  inOwnCredit: 10n,
  outPeerCredit: 20n,
  inAllowance: 0n,
  outAllowance: 0n,
  totalCapacity: 200n,
  ownCreditLimit: 50n,
  peerCreditLimit: 50n,
  inCapacity: 80n,
  outCapacity: 90n,
  outOwnCredit: 30n,
  inPeerCredit: 20n,
  peerCreditUsed: 0n,
  ownCreditUsed: 0n,
  outTotalHold: 0n,
  inTotalHold: 0n,
  ascii: '[-----=====|-----]',
  ...overrides,
});

describe('cli capacity bars', () => {
  test('closed ascii uses - and = with delta marker', () => {
    const bar = buildClosedAscii(20n, 10n, 20n, 0n, 50);
    expect(bar.startsWith('[')).toBe(true);
    expect(bar.endsWith(']')).toBe(true);
    expect(bar.includes('|')).toBe(true);
    expect(bar.includes('=')).toBe(true);
    expect(bar.includes('-')).toBe(true);
  });

  test('twin bars expose out/in shells with = collateral', () => {
    const twin = renderTwinBars(sampleDerived(), 24, false);
    expect(twin.includes('out[')).toBe(true);
    expect(twin.includes('in[')).toBe(true);
    expect(twin.includes('=')).toBe(true);
  });

  test('renderCapacityBar respects style setting', () => {
    const closed = renderCapacityBar(sampleDerived(), { style: 'closed', color: false });
    const twin = renderCapacityBar(sampleDerived(), { style: 'twin', color: false, width: 24 });
    expect(closed).toBe('[-----=====|-----]');
    expect(twin.startsWith('out[')).toBe(true);
  });
});
