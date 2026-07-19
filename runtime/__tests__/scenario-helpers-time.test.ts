import { describe, expect, test } from 'bun:test';
import { createEmptyEnv } from '../runtime';
import { processUntil } from '../scenarios/helpers';

describe('scenario helper time ownership', () => {
  test('processUntil does not fabricate time for a live runtime', async () => {
    const env = createEmptyEnv('scenario-helper-live-clock');
    env.scenarioMode = false;
    env.timestamp = 1_000;

    await expect(processUntil(env, () => false, 1, 'live-clock')).rejects.toThrow(
      'processUntil: live-clock not satisfied after 1 rounds',
    );

    expect(env.timestamp).toBe(1_000);
  });
});
