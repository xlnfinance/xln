import { expect, test } from 'bun:test';
import { selectDeterminismScenarios } from '../../../scenarios/runner/determinism';

for (const [key, reason] of [
  ['rebalnce', 'unknown'],
  ['ahb', 'excluded'],
  ['cross-j', 'stress-only'],
] as const) {
  test(`explicit determinism selection rejects ${key} instead of certifying only its valid subset`, () => {
    expect(() => selectDeterminismScenarios(new Set(['processbatch', key]))).toThrow(
      `DETERMINISM_REQUESTED_SCENARIO_UNAVAILABLE:${key}:${reason}`,
    );
  });
}

test('a supported explicit determinism request selects exactly its named scenario', () => {
  expect(selectDeterminismScenarios(new Set(['processbatch'])).map(scenario => scenario.key)).toEqual(['processbatch']);
});

test('explicit scenario selection retains catalog order rather than request order', () => {
  expect(selectDeterminismScenarios(new Set(['processbatch', 'rebalance'])).map(scenario => scenario.key)).toEqual([
    'rebalance',
    'processbatch',
  ]);
});
