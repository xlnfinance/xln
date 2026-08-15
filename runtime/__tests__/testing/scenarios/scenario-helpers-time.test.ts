import { describe, expect, test } from 'bun:test';
import { createEmptyEnv } from '../../../runtime';
import { converge, processUntil } from '../../../scenarios/harness/helpers';

describe('scenario helper time ownership', () => {
  test('processUntil does not fabricate time for a live runtime', async () => {
    const env = createEmptyEnv('scenario-helper-live-clock');
    env.scenarioMode = false;
    env.state.timestamp = 1_000;

    await expect(processUntil(env, () => false, 1, 'live-clock')).rejects.toThrow(
      'processUntil: live-clock not satisfied after 1 rounds',
    );

    expect(env.state.timestamp).toBe(1_000);
  });

  test('convergence does not advance the clock after the final durable frame', async () => {
    const env = createEmptyEnv('scenario-helper-durable-clock');
    env.scenarioMode = true;
    env.state.timestamp = 1_000;

    await converge(env, 1);

    expect(env.state.timestamp).toBe(1_000);
  });
});
