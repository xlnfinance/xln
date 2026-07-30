import { describe, expect, test } from 'bun:test';

import {
  assertRuntimeCommandReady,
  inferRuntimeLifecyclePhase,
  transitionRuntimeLifecycle,
} from '../runtime/lifecycle';
import {
  createEmptyEnv,
  resumeRuntimeAfterPersistenceQuiesce,
  resumeRuntimeLoop,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
  waitForRuntimeProcessingIdle,
} from '../runtime';
import type { RuntimeReplica } from '../runtime/types';

describe('runtime lifecycle', () => {
  test('uses one explicit phase as the lifecycle source of truth', () => {
    const state: NonNullable<RuntimeReplica['infrastructure']> = {
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
    const state: NonNullable<RuntimeReplica['infrastructure']> = { lifecyclePhase: 'halted', halted: true };
    expect(() => transitionRuntimeLifecycle(state, 'running')).toThrow(
      /RUNTIME_LIFECYCLE_INVALID_TRANSITION: halted->running/,
    );
  });

  test('admits commands only while running without a persistence fence', () => {
    const env = createEmptyEnv('runtime-command-readiness');

    for (const phase of ['booting', 'quiescing', 'stopped', 'halted'] as const) {
      env.infrastructure = { lifecyclePhase: phase };
      expect(() => assertRuntimeCommandReady(env)).toThrow(
        `RUNTIME_COMMAND_NOT_READY:phase=${phase}`,
      );
    }

    env.infrastructure = { lifecyclePhase: 'running', loopActive: true };
    expect(() => assertRuntimeCommandReady(env)).not.toThrow();

    env.infrastructure.persistencePaused = true;
    expect(() => assertRuntimeCommandReady(env)).toThrow(
      'RUNTIME_COMMAND_NOT_READY:persistence-fenced',
    );
  });

  test('requires explicit resume after a quiesced loop drains', async () => {
    const env = createEmptyEnv('runtime-explicit-resume');
    startRuntimeLoop(env);
    expect(await stopRuntimeLoopAndWait(env)).toBe(true);
    expect(env.infrastructure?.lifecyclePhase).toBe('quiescing');

    resumeRuntimeLoop(env);

    expect(env.infrastructure?.lifecyclePhase).toBe('running');
    env.infrastructure?.stopLoop?.();
  });

  test('durable resume clears the persistence fence before restarting the loop', async () => {
    const env = createEmptyEnv('runtime-durable-resume');
    env.infrastructure ??= {};
    env.infrastructure.lifecyclePhase = 'quiescing';
    env.infrastructure.persistenceQuiescing = true;
    env.infrastructure.persistencePaused = true;

    resumeRuntimeAfterPersistenceQuiesce(env);

    expect(env.infrastructure.persistencePaused).toBe(false);
    expect(env.infrastructure.persistenceQuiescing).toBe(false);
    expect(env.infrastructure.lifecyclePhase).toBe('running');
    env.infrastructure.stopLoop?.();
  });

  test('durable resume fails loudly if a running loop still has a persistence fence', () => {
    const env = createEmptyEnv('runtime-invalid-durable-resume');
    env.infrastructure ??= {};
    env.infrastructure.lifecyclePhase = 'running';
    env.infrastructure.loopActive = true;
    env.infrastructure.persistencePaused = true;

    expect(() => resumeRuntimeAfterPersistenceQuiesce(env)).toThrow(
      'RUNTIME_DURABLE_RESUME_RUNNING_WITH_PERSISTENCE_FENCE',
    );
  });

  test('propagates a rejected runtime loop instead of treating shutdown as drained', async () => {
    const env = createEmptyEnv('runtime-loop-rejection');
    env.infrastructure = {
      lifecyclePhase: 'running',
      loopActive: true,
      loopPromise: Promise.reject(new Error('LOOP_REJECTED_DURING_SHUTDOWN')),
    };

    await expect(stopRuntimeLoopAndWait(env, 20)).rejects.toThrow('LOOP_REJECTED_DURING_SHUTDOWN');
  });

  test('propagates a rejected processing task instead of reporting idle', async () => {
    const env = createEmptyEnv('runtime-processing-rejection');
    env.infrastructure = {
      processingPromise: Promise.reject(new Error('PROCESSING_REJECTED_DURING_SHUTDOWN')),
    };

    await expect(waitForRuntimeProcessingIdle(env, 20)).rejects.toThrow(
      'PROCESSING_REJECTED_DURING_SHUTDOWN',
    );
  });

});
