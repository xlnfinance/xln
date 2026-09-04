import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../../runtime';
import { createFrameExecutionState } from '../../../../runtime/frame/intake/execution-state';
import { restoreUndurableRuntimeInput } from '../../../../runtime/frame/intake/recovery';
import type { RoutedEntityInput, RuntimeInput } from '../../../../runtime/types';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const hash = (byte: string): string => `0x${byte.repeat(32)}`;

const entityInput = (byte: string): RoutedEntityInput => ({
  from: address(byte),
  entityId: hash(byte),
  signerId: address(byte),
  entityTxs: [],
});

describe('Runtime undurable input recovery', () => {
  test('pre-drain discard restores each retained ingress item exactly once', async () => {
    const rejected = entityInput('11');
    const retained = entityInput('22');
    const arrivedDuringAttempt = entityInput('33');
    const frameInput: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [rejected, retained],
      queuedAt: 100,
    };
    const liveEnv = createEmptyEnv('runtime-input-recovery-pre-drain');
    liveEnv.runtimeMempool = {
      runtimeTxs: [],
      entityInputs: [arrivedDuringAttempt],
      queuedAt: 200,
    };
    const frame = createFrameExecutionState();
    frame.transaction = {
      liveEnv,
      frameMempool: frameInput,
      liveFrameEventBaseLength: 0,
      published: false,
    };

    await restoreUndurableRuntimeInput({
      frame,
      liveEnv,
      attemptedEnv: liveEnv,
      runtimeInput: frameInput,
      mempoolQueuedAt: 100,
      frameTimestampBeforeTick: 0,
      quietRuntimeLogs: true,
      discardMalformedRemoteInput: input => ({
        ...input,
        entityInputs: input.entityInputs.filter(candidate => candidate !== rejected),
      }),
      discardedError: error => error,
    }, new Error('malformed remote input'));

    expect(frame.inputDrained).toBe(false);
    expect(liveEnv.runtimeMempool?.entityInputs).toEqual([
      retained,
      arrivedDuringAttempt,
    ]);
    expect(liveEnv.runtimeMempool?.queuedAt).toBe(200);
  });
});
