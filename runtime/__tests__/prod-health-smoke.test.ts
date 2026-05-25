import { expect, test } from 'bun:test';

import { getFatalDegradedReasons } from '../scripts/prod-health-smoke';

test('prod health smoke ignores advisory bootstrap reserve target drift', () => {
  expect(getFatalDegradedReasons(['bootstrapReserveTargets'])).toEqual([]);
});

test('prod health smoke still fails on real degraded subsystems', () => {
  expect(getFatalDegradedReasons(['storage', 'bootstrapReserveTargets', 'hubMesh'])).toEqual(['storage', 'hubMesh']);
});
