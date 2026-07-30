import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import { notifyRuntimeSyncAfterCommit } from '../storage/runtime-storage';

describe('post-commit Runtime sync notification', () => {
  test('reports a broken channel without changing the durable frame', () => {
    const env = createEmptyEnv('runtime-sync-notification-failure');
    env.state.height = 17;
    const closeCalls: number[] = [];

    const error = notifyRuntimeSyncAfterCommit(env, {
      enabled: true,
      createChannel: () => ({
        postMessage: () => {
          throw new Error('CHANNEL_BROKEN');
        },
        close: () => {
          closeCalls.push(env.state.height);
        },
      }),
    });

    expect(error?.message).toBe('RUNTIME_SYNC_NOTIFICATION_FAILED:height=17');
    expect(env.state.height).toBe(17);
    expect(closeCalls).toEqual([17]);
    expect(env.runtimeState?.runtimeSyncChannel).toBeNull();
    expect(env.runtimeState?.runtimeSyncNotificationFailure).toEqual({
      height: 17,
      message: 'RUNTIME_SYNC_NOTIFICATION_FAILED:height=17',
    });
  });

  test('clears the previous failure after a successful notification', () => {
    const env = createEmptyEnv('runtime-sync-notification-recovery');
    env.state.height = 18;
    env.runtimeState!.runtimeSyncNotificationFailure = {
      height: 17,
      message: 'previous failure',
    };
    const messages: unknown[] = [];

    const error = notifyRuntimeSyncAfterCommit(env, {
      enabled: true,
      createChannel: () => ({
        postMessage: message => messages.push(message),
        close: () => {},
      }),
    });

    expect(error).toBeNull();
    expect(messages).toEqual([{ runtimeId: env.runtimeId, height: 18 }]);
    expect(env.runtimeState?.runtimeSyncNotificationFailure).toBeUndefined();
  });
});
