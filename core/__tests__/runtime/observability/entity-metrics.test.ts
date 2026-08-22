import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import {
  readRuntimeEntityMetricStats,
  recordCommittedRuntimeEntityMetrics,
} from '../../../runtime/observability/entity-metrics';
import type { FrameLogEntry } from '../../../types/logging';

const ENTITY = `0x${'ab'.repeat(32)}`;
const event = (message: string, data: Record<string, unknown>): FrameLogEntry => ({
  id: 1,
  timestamp: 1,
  level: 'info',
  category: 'system',
  message,
  data,
});

describe('post-WAL Entity metrics', () => {
  test('counts exact committed payment and swap events', () => {
    const env = createEmptyEnv('entity-metrics');
    recordCommittedRuntimeEntityMetrics(env, 7, [
      event('HtlcForwardAccepted', { entityId: ENTITY, hashlock: `0x${'12'.repeat(32)}` }),
      event('HtlcReceived', { entityId: ENTITY }),
      event('SwapMatched', { entityId: ENTITY, count: 3 }),
    ]);
    expect(readRuntimeEntityMetricStats(env, ENTITY)).toEqual({
      acceptedPayments: 1,
      completedPayments: 1,
      matchedSwaps: 3,
      updatedAtRuntimeHeight: 7,
    });
  });

  test('ignores debug logs and fails closed on malformed metric events', () => {
    const env = createEmptyEnv('entity-metrics-invalid');
    recordCommittedRuntimeEntityMetrics(env, 1, [event('orderbook.debug', { entityId: ENTITY })]);
    expect(readRuntimeEntityMetricStats(env, ENTITY).completedPayments).toBe(0);
    expect(() => recordCommittedRuntimeEntityMetrics(env, 2, [
      event('SwapMatched', { entityId: ENTITY, count: 0 }),
    ])).toThrow('RUNTIME_ENTITY_METRIC_SWAP_COUNT_INVALID:0');
  });
});
