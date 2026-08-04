import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  clampDemoSpeed,
  normalizeDemo,
} from '../../frontend/src/lib/stores/networkMachineDemoStore';

describe('network machine demo playback', () => {
  test('clamps unusable speeds instead of freezing or fast-forwarding the demo', () => {
    for (const [input, expected] of [[0, 1], [-5, 1], ['abc', 1], [0.1, 0.25], [999, 10], [3, 3]] as const) {
      expect(clampDemoSpeed(input)).toBe(expected);
    }
    expect(clampDemoSpeed(undefined)).toBe(1);
  });

  test('autoplay is opt-in and speed is always usable', () => {
    expect(normalizeDemo({ autoplay: true, speed: 2 })).toEqual({ autoplay: true, speed: 2 });
    expect(normalizeDemo({})).toEqual({ autoplay: false, speed: 1 });
    expect(normalizeDemo({ autoplay: 'yes' as never, speed: 0 })).toEqual({ autoplay: false, speed: 1 });
  });


  test('a recorded scenario is deterministic, self-contained and ephemeral', () => {
    const source = readFileSync('runtime/scenarios/browser-api.ts', 'utf8');

    // Seed: a demo must replay identically and must not require an unlocked vault.
    expect(source).toContain('xln-demo:');
    // In-process EVM: never depend on, or flood, an external RPC endpoint.
    expect(source).toContain("env.scenarioJAdapterMode = 'browservm'");
    expect(source).toContain('env.scenarioMode = true');
    // No persistence: frames live in the trace; writing them collides with the runtime
    // that already owns that storage namespace.
    expect(source).toContain('storage: { ...env.runtimeConfig?.storage, enabled: false }');
    // The trace is always released, including when the scenario throws.
    expect(source).toContain('} finally {');
    expect(source).toContain('trace.stop();');
  });

});
