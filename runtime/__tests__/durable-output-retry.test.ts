import { describe, expect, test } from 'bun:test';

import {
  buildDurableOutputRetryState,
  restoreDurableOutputRetryState,
  validateDurableOutputRetryState,
} from '../runtime/delivery/durable-output-retry';
import { buildRouteOutputKey } from '../runtime/routing/output-routing';
import type { RuntimeReplica, RoutedEntityInput } from '../runtime/types';

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
      infrastructure: {
        deferredNetworkMeta: new Map([[
          liveRouteKey,
          { attempts: 7, nextRetryAt: 9_000_000_000_000 },
        ]]),
      },
    } as RuntimeReplica;
    const retryState = buildDurableOutputRetryState(env, [output]);
    expect(retryState).toHaveLength(1);
    expect(retryState[0]!.outputHash.length).toBeLessThan(128);
    expect(validateDurableOutputRetryState(retryState, [output], 'TEST_OUTPUT_RETRY')).toEqual(retryState);

    const restored = {} as RuntimeReplica;
    restoreDurableOutputRetryState(restored, retryState, [output]);
    expect(restored.infrastructure?.deferredNetworkMeta?.get(liveRouteKey)).toEqual({
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

  test('rejects retired manual retry pauses instead of reviving a stuck outbox', () => {
    const output = {
      runtimeId: `0x${'77'.repeat(20)}`,
      entityId: `0x${'88'.repeat(32)}`,
      signerId: `0x${'99'.repeat(20)}`,
      entityTxs: [],
    } as RoutedEntityInput;
    const valid = buildDurableOutputRetryState({
      infrastructure: {
        deferredNetworkMeta: new Map([[
          buildRouteOutputKey(output),
          { attempts: 1, nextRetryAt: 42 },
        ]]),
      },
    } as RuntimeReplica, [output]);
    expect(() => validateDurableOutputRetryState([
      { ...valid[0]!, manual: true },
    ], [output], 'TEST_OUTPUT_RETRY')).toThrow('TEST_OUTPUT_RETRY:0:FIELDS');
  });
});
