import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../runtime';
import { recordRuntimeScenario } from '../../scenarios/browser-api';

describe('browser scenario Runtime ownership', () => {
  test('retains the supplied Runtime replica', async () => {
    const env = createEmptyEnv('browser-scenario-owner');
    const recording = await recordRuntimeScenario(env, async target => target);

    expect(recording.env).toBe(env);
    expect(recording.frames).toEqual([]);
  });

  test('rejects a runner that replaces the trace-owned Runtime', async () => {
    const env = createEmptyEnv('browser-scenario-owner');
    const replacement = createEmptyEnv('browser-scenario-replacement');

    await expect(recordRuntimeScenario(env, async () => replacement)).rejects.toThrow(
      'RUNTIME_SCENARIO_REPLICA_REPLACED',
    );
  });
});
