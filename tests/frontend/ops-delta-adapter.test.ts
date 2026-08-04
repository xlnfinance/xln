import { expect, test } from 'bun:test';
import { deriveDelta } from '../../runtime/account/utils';
import type { Delta } from '../../runtime/types/account';
import { deriveOpsDelta, parseOpsDelta } from '../../frontend/apps/ops/data/ops-delta-adapter';

const exposure: Delta = { tokenId: 1, collateral: 1_000n, ondelta: -1_300n, offdelta: 450n, leftCreditLimit: 700n, rightCreditLimit: 900n, leftAllowance: 40n, rightAllowance: 60n, leftHold: 125n, rightHold: 75n };

test('ops projection stringifies only the canonical deriveDelta result', () => {
  for (const perspective of [true, false]) { const canonical = deriveDelta(exposure, perspective); const projected = deriveOpsDelta(exposure, perspective); expect(projected.outCapacity).toBe(canonical.outCapacity.toString()); expect(projected.inCapacity).toBe(canonical.inCapacity.toString()); expect(projected.outTotalHold).toBe(canonical.outTotalHold.toString()); expect(projected.ascii).toBe(canonical.ascii); }
});

test('historical exposure and mandatory holds stay exact at the boundary', () => {
  const parsed = parseOpsDelta(Object.fromEntries(Object.entries(exposure).map(([key, value]) => [key, String(value)])) as Record<keyof Delta, string>);
  expect(parsed).toEqual(exposure); expect(() => parseOpsDelta({ ...Object.fromEntries(Object.entries(exposure).map(([key, value]) => [key, String(value)])), leftHold: '' } as Record<keyof Delta, string>)).toThrow('OPS_DELTA_INTEGER_INVALID:leftHold');
});
