import { describe, expect, test } from 'bun:test';
import type { EnvSnapshot, RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';

import { createRuntimeScenarioSource } from '../../../frontend/packages/browser/src/runtime-scenario-source';

const frames = [1, 2].map(height => ({
  state: { height, eReplicas: new Map() },
  meta: { title: `Frame ${height}` },
} as unknown as EnvSnapshot));

const runtimeFixture = (onStop: () => void): XLNModule => {
  const environment = {
    runtimeId: 'scenario-fixture',
    state: { height: 0, timestamp: 1, jReplicas: new Map() },
    runtimeConfig: { storage: { enabled: false } },
    infrastructure: { persistencePaused: true, loopActive: true, stopLoop: onStop },
  } as unknown as RuntimeReplica;
  const run = async (target: RuntimeReplica): Promise<RuntimeReplica> => target;
  return {
    RUNTIME_SCHEMA_VERSION: 1,
    createEmptyEnv: () => environment,
    scenarios: { disputeLifecycle: run, ahb: run, settle: run, swap: run },
    recordRuntimeScenario: async env => ({ env, frames }),
  } as unknown as XLNModule;
};

describe('shared Runtime scenario source', () => {
  test('runs injected runtime.js exports, advances playback, and tears down infrastructure', async () => {
    let timer: (() => void) | null = null;
    let stopped = 0;
    const source = createRuntimeScenarioSource({
      loadRuntime: async () => runtimeFixture(() => { stopped += 1; }),
      now: () => 10,
      setTimer: callback => { timer = callback; return 1; },
      clearTimer: () => { timer = null; },
    });
    await source.start('ahb', 0);
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', frameCount: 2, currentFrame: 0 });
    source.play();
    if (!timer) throw new Error('SCENARIO_TEST_TIMER_MISSING');
    timer();
    expect(source.getSnapshot().currentFrame).toBe(1);
    source.restart();
    expect(source.getSnapshot().currentFrame).toBe(0);
    source.stop();
    expect(source.getSnapshot().status).toBe('idle');
    expect(stopped).toBeGreaterThanOrEqual(1);
  });

  test('reconstructs an exact wallet frame and rejects malformed route input loudly', async () => {
    const dependencies = {
      loadRuntime: async () => runtimeFixture(() => {}), now: () => 0,
      setTimer: () => 1, clearTimer: () => {},
    };
    const preview = createRuntimeScenarioSource(dependencies);
    await preview.startFromPreviewSearch('?locktest=1&scenarioPreview=1&scenario=settle&frame=1');
    expect(preview.getSnapshot()).toMatchObject({ status: 'ready', currentFrame: 1, option: { id: 'settle' } });

    const invalid = createRuntimeScenarioSource(dependencies);
    await invalid.startFromRouteRequest('missing', '-1');
    expect(invalid.getSnapshot()).toMatchObject({ status: 'error', error: 'RUNTIME_SCENARIO_UNKNOWN:missing' });
  });

  test('internalizes bundle failures as explicit state and validates playback speed', async () => {
    const source = createRuntimeScenarioSource({
      loadRuntime: async () => { throw new Error('RUNTIME_BUNDLE_UNAVAILABLE'); },
      now: () => 0, setTimer: () => 1, clearTimer: () => {},
    });
    await source.start();
    expect(source.getSnapshot()).toMatchObject({
      status: 'error', error: 'RUNTIME_BUNDLE_UNAVAILABLE', option: { id: 'ahb' },
    });
    expect(() => source.setPlaybackMs(123)).toThrow('SCENARIO_PLAYBACK_INVALID:123');
  });
});
