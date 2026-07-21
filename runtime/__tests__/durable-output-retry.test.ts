import { describe, expect, test } from 'bun:test';

import {
  buildDurableOutputRetryState,
  restoreDurableOutputRetryState,
  validateDurableOutputRetryState,
} from '../machine/durable-output-retry';
import { buildRouteOutputKey } from '../machine/output-routing';
import type { Env, RoutedEntityInput } from '../types';

describe('durable output retry', () => {
  test('bounds a large live route key and restores retry metadata by exact output', () => {
    const output = {
      runtimeId: `0x${'11'.repeat(20)}`,
      entityId: `0x${'22'.repeat(32)}`,
      signerId: `0x${'33'.repeat(20)}`,
      entityTxs: [{ type: 'large_transport_payload', data: 'x'.repeat(12_000) }],
    } as unknown as RoutedEntityInput;
    const liveRouteKey = buildRouteOutputKey(output);
    expect(liveRouteKey.length).toBeGreaterThan(8_192);

    const env = {
      runtimeState: {
        deferredNetworkMeta: new Map([[
          liveRouteKey,
          { attempts: 7, nextRetryAt: 9_000_000_000_000 },
        ]]),
      },
    } as Env;
    const retryState = buildDurableOutputRetryState(env, [output]);
    expect(retryState).toHaveLength(1);
    expect(retryState[0]!.outputHash.length).toBeLessThan(128);
    expect(validateDurableOutputRetryState(retryState, [output], 'TEST_OUTPUT_RETRY')).toEqual(retryState);

    const restored = {} as Env;
    restoreDurableOutputRetryState(restored, retryState, [output]);
    expect(restored.runtimeState?.deferredNetworkMeta?.get(liveRouteKey)).toEqual({
      attempts: 7,
      nextRetryAt: 9_000_000_000_000,
    });
  });

  test('rejects unbounded live route keys instead of accepting another format', () => {
    const output = {
      runtimeId: `0x${'44'.repeat(20)}`,
      entityId: `0x${'55'.repeat(32)}`,
      signerId: `0x${'66'.repeat(20)}`,
      entityTxs: [],
    } as RoutedEntityInput;
    const invalidState = [{
      outputHash: buildRouteOutputKey(output),
      attempts: 2,
      retryAt: 3_000,
    }];
    expect(() => validateDurableOutputRetryState(invalidState, [output], 'TEST_OUTPUT_RETRY'))
      .toThrow('TEST_OUTPUT_RETRY:0:OUTPUT_HASH');
  });

  test('preserves an explicit manual retry pause across restart', () => {
    const output = {
      runtimeId: `0x${'77'.repeat(20)}`,
      entityId: `0x${'88'.repeat(32)}`,
      signerId: `0x${'99'.repeat(20)}`,
      entityTxs: [],
    } as RoutedEntityInput;
    const liveRouteKey = buildRouteOutputKey(output);
    const env = {
      runtimeState: {
        deferredNetworkMeta: new Map([[
          liveRouteKey,
          { attempts: 1, nextRetryAt: 42, manual: true },
        ]]),
      },
    } as Env;

    const persisted = buildDurableOutputRetryState(env, [output]);
    const restored = {} as Env;
    restoreDurableOutputRetryState(restored, persisted, [output]);

    expect(persisted[0]?.manual).toBe(true);
    expect(restored.runtimeState?.deferredNetworkMeta?.get(liveRouteKey)).toEqual({
      attempts: 1,
      nextRetryAt: 42,
      manual: true,
    });
  });
});
