import { expect, test } from 'bun:test';
import { expandPlaywrightTargets } from '../../../scripts/e2e/runners/run-e2e-parallel-isolated';

const moveSpec = 'tests/e2e/payments/e2e-move.spec.ts';

test('isolated discovery includes every evaluated faucet and routed Move case exactly once', () => {
  const targets = expandPlaywrightTargets([moveSpec]);
  expect(targets.map(target => target.title).sort()).toEqual([
    'asset faucet exposes correct modes and funds USDC',
    'asset faucet exposes correct modes and funds USDT',
    'asset faucet exposes correct modes and funds WETH',
    'move routed paths on isolated runtimes: remote-and-external',
    'move routed paths on isolated runtimes: reserve-and-own-account',
    'move routed paths on isolated runtimes: round-trips',
  ]);
  expect(targets.every(target => target.target === moveSpec)).toBe(true);
  expect(targets.every(target => !target.requireMarketMaker && !target.requireCustody)).toBe(true);
}, 30_000);

test('an exact parameterized target retains its evaluated title and rejects an unknown case', () => {
  const title = 'asset faucet exposes correct modes and funds WETH';
  const targets = expandPlaywrightTargets([`${moveSpec}::${title}`]);
  expect(targets).toHaveLength(1);
  expect(targets[0]?.title).toBe(title);
  expect(() => expandPlaywrightTargets([`${moveSpec}::asset faucet exposes correct modes and funds MISSING`])).toThrow(
    'PLAYWRIGHT_TEST_TARGET_MISSING',
  );
}, 30_000);
