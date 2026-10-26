import { describe, expect, test } from 'bun:test';

import { scenarios } from '../../../core/scenarios/browser-api';
import { resolveScenarioSet, SCENARIOS } from '../../../core/scenarios/runner/catalog';

describe('canonical scenario catalog', () => {
  test('every CLI id is browser-loadable or carries an explicit reason', () => {
    const ids = SCENARIOS.map(scenario => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Exact catalog identity and order: a bare count went stale and cannot see a swap.
    expect(ids).toEqual([
      'lending-lifecycle', 'lending-before-deadline', 'lending-after-deadline',
      'htlc-ack-recovery', 'hub-preserved-reserve-refill', 'hub-quiesce-offline-peer',
      'rebalance', 'lock-ahb', 'htlc-lazy', 'ahb', 'swap', 'settle', 'htlc-4hop',
      'grid', 'swap-market', 'multi-sig', 'company-ipo', 'rapid-fire',
      'settle-rebalance', 'processbatch', 'dispute-lifecycle', 'dispute-transformer',
      'cross-j', 'mm-mesh',
    ]);

    for (const scenario of SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      if (scenario.browserSafe) {
        expect(typeof scenarios[scenario.id]).toBe('function');
      } else {
        expect(scenario.browserUnsafeReason.trim().length).toBeGreaterThan(0);
        expect(scenarios[scenario.id]).toBeUndefined();
      }
    }
  });

  test('browser registry is exactly the browser-safe catalog view', () => {
    expect(Object.keys(scenarios).sort()).toEqual(
      SCENARIOS.filter(scenario => scenario.browserSafe)
        .map(scenario => scenario.id)
        .sort(),
    );
  });

  test('the full command runs the exact canonical catalog', () => {
    const catalogIds = SCENARIOS.map(scenario => scenario.id);
    expect(resolveScenarioSet('full')).toEqual(catalogIds);
    expect(resolveScenarioSet('all')).toEqual(catalogIds);
    expect(() => resolveScenarioSet('unknown')).toThrow('UNKNOWN_SCENARIO_SET:unknown');
  });
});
