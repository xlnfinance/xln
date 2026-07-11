import { describe, expect, test } from 'bun:test';

import {
  inferRuntimeLifecyclePhase,
  transitionRuntimeLifecycle,
} from '../runtime-lifecycle';
import { createEmptyEnv, resumeRuntimeLoop, startRuntimeLoop, stopRuntimeLoopAndWait } from '../runtime';
import type { Env } from '../types';

describe('runtime lifecycle', () => {
  test('uses one explicit phase as the lifecycle source of truth', () => {
    const state: NonNullable<Env['runtimeState']> = {
      lifecyclePhase: 'booting',
      loopActive: false,
      halted: false,
    };

    expect(transitionRuntimeLifecycle(state, 'running')).toBe('running');
    expect(state).toMatchObject({ lifecyclePhase: 'running', loopActive: true, halted: false });
    expect(transitionRuntimeLifecycle(state, 'quiescing')).toBe('quiescing');
    expect(state).toMatchObject({ lifecyclePhase: 'quiescing', loopActive: false, persistenceQuiescing: true });
    expect(transitionRuntimeLifecycle(state, 'stopped')).toBe('stopped');
    expect(inferRuntimeLifecyclePhase(state)).toBe('stopped');
    expect(transitionRuntimeLifecycle(state, 'quiescing')).toBe('quiescing');
    expect(transitionRuntimeLifecycle(state, 'stopped')).toBe('stopped');
  });

  test('halted is terminal and cannot self-resurrect', () => {
    const state: NonNullable<Env['runtimeState']> = { lifecyclePhase: 'halted', halted: true };
    expect(() => transitionRuntimeLifecycle(state, 'running')).toThrow(
      /RUNTIME_LIFECYCLE_INVALID_TRANSITION: halted->running/,
    );
  });

  test('requires explicit resume after a quiesced loop drains', async () => {
    const env = createEmptyEnv('runtime-explicit-resume');
    startRuntimeLoop(env);
    expect(await stopRuntimeLoopAndWait(env)).toBe(true);
    expect(env.runtimeState?.lifecyclePhase).toBe('quiescing');

    resumeRuntimeLoop(env);

    expect(env.runtimeState?.lifecyclePhase).toBe('running');
    env.runtimeState?.stopLoop?.();
  });
});
