import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  clampDemoSpeed,
  normalizeDemo,
} from '../../../frontend/src/lib/stores/network/networkMachineDemoStore';

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

  test('autoplay is consumed once so a recompile does not restart the demo', () => {
    const store = readFileSync('frontend/src/lib/stores/network/networkMachineDemoStore.ts', 'utf8');
    const timeline = readFileSync('frontend/src/lib/view/core/NetworkMachineTimeline.svelte', 'utf8');

    expect(store).toContain('consumeAutoplay');
    expect(store).toContain('requested ? { ...current, autoplay: false } : current');
    expect(timeline).toContain('networkMachineDemo.consumeAutoplay()');
    expect(timeline).toContain('void selectStep(0).then(() => togglePlayback());');
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

  test('the embed route drives playback from the URL and surfaces scenario failures', () => {
    const route = readFileSync('frontend/src/routes/embed/+page.svelte', 'utf8');

    expect(route).toContain("$page.url.searchParams.get('scenario')");
    expect(route).toContain("$page.url.searchParams.get('autoplay') === '1'");
    expect(route).toContain('networkMachineRuntimeOperations.loadScenario');
    // A scenario embed narrates through the Time Machine, so it cannot stay hidden.
    expect(route).toContain('settingsOperations.setShowTimeMachine(true)');
    expect(route).toContain('data-testid="embed-scenario-error"');
  });

  test('a loaded scenario is not replaced by whatever runtimes happen to be connected', () => {
    const timeline = readFileSync('frontend/src/lib/view/core/NetworkMachineTimeline.svelte', 'utf8');
    const store = readFileSync('frontend/src/lib/stores/network/networkMachineRuntimeStore.ts', 'utf8');

    expect(timeline).toContain('if (get(networkMachineRuntime).machine) return;');
    // One registry of sources: live adapters and recorded scenarios read the same way.
    expect(store).toContain('const activeSources = new Map<string, NetworkTimelineSource>()');
    expect(store).toContain('source.readGraphFrame(selected.height)');
    expect(store).toContain('source.readActivity(selected.height, selected.height)');
  });
});
