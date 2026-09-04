import { describe, expect, test } from 'bun:test';

import { scenarios } from '../../../core/scenarios/browser-api';
import { resolveScenarioSet, SCENARIOS } from '../../../core/scenarios/runner/catalog';

describe('canonical scenario catalog', () => {
  test('every CLI id is browser-loadable or carries an explicit reason', () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(18);

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
      SCENARIOS.filter((scenario) => scenario.browserSafe).map((scenario) => scenario.id).sort(),
    );
  });

  test('the full command runs the exact canonical catalog', () => {
    const catalogIds = SCENARIOS.map((scenario) => scenario.id);
    expect(resolveScenarioSet('full')).toEqual(catalogIds);
    expect(resolveScenarioSet('all')).toEqual(catalogIds);
    expect(() => resolveScenarioSet('unknown')).toThrow('UNKNOWN_SCENARIO_SET:unknown');
  });
});
