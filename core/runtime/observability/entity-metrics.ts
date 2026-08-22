import { normalizeEntityId } from '../../storage/keys';
import type { FrameLogEntry } from '../../types/logging';
import type { RuntimeEntityMetricStats, RuntimeReplica } from '../types';

const EMPTY_ENTITY_METRICS: RuntimeEntityMetricStats = Object.freeze({
  acceptedPayments: 0,
  completedPayments: 0,
  matchedSwaps: 0,
  updatedAtRuntimeHeight: 0,
});

const requireEventEntityId = (entry: FrameLogEntry): string => {
  const value = entry.data?.['entityId'];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`RUNTIME_ENTITY_METRIC_EVENT_ENTITY_MISSING:${entry.message}`);
  }
  return normalizeEntityId(value);
};

const checkedAdd = (current: number, increment: number, metric: string): number => {
  const next = current + increment;
  if (!Number.isSafeInteger(increment) || increment < 0 || !Number.isSafeInteger(next)) {
    throw new Error(`RUNTIME_ENTITY_METRIC_OVERFLOW:${metric}:${current}:${increment}`);
  }
  return next;
};

export const readRuntimeEntityMetricStats = (
  env: RuntimeReplica,
  entityId: string,
): RuntimeEntityMetricStats =>
  env.infrastructure?.entityMetricStats?.get(normalizeEntityId(entityId)) ?? EMPTY_ENTITY_METRICS;

/**
 * Apply counters only after the frame WAL commit. Counting ingress, proposals,
 * or matcher previews would let rejected work masquerade as throughput.
 */
export const recordCommittedRuntimeEntityMetrics = (
  env: RuntimeReplica,
  runtimeHeight: number,
  events: readonly FrameLogEntry[],
): void => {
  if (!Number.isSafeInteger(runtimeHeight) || runtimeHeight < 0) {
    throw new Error(`RUNTIME_ENTITY_METRIC_HEIGHT_INVALID:${runtimeHeight}`);
  }
  const increments = new Map<string, { acceptedPayments: number; completedPayments: number; matchedSwaps: number }>();
  for (const event of events) {
    if (event.category !== 'system') continue;
    if (event.message !== 'HtlcForwardAccepted' && event.message !== 'HtlcReceived' && event.message !== 'SwapMatched') continue;
    const entityId = requireEventEntityId(event);
    const current = increments.get(entityId) ?? { acceptedPayments: 0, completedPayments: 0, matchedSwaps: 0 };
    if (event.message === 'HtlcForwardAccepted') {
      current.acceptedPayments = checkedAdd(current.acceptedPayments, 1, 'acceptedPayments.frame');
    } else if (event.message === 'HtlcReceived') {
      current.completedPayments = checkedAdd(current.completedPayments, 1, 'completedPayments.frame');
    } else {
      const count = event.data?.['count'];
      if (!Number.isSafeInteger(count) || Number(count) <= 0) {
        throw new Error(`RUNTIME_ENTITY_METRIC_SWAP_COUNT_INVALID:${String(count)}`);
      }
      current.matchedSwaps = checkedAdd(current.matchedSwaps, Number(count), 'matchedSwaps.frame');
    }
    increments.set(entityId, current);
  }
  if (increments.size === 0) return;
  const infrastructure = env.infrastructure ?? (env.infrastructure = {});
  const stats = infrastructure.entityMetricStats ?? (infrastructure.entityMetricStats = new Map());
  for (const [entityId, increment] of increments) {
    const current = stats.get(entityId) ?? EMPTY_ENTITY_METRICS;
    stats.set(entityId, {
      acceptedPayments: checkedAdd(
        current.acceptedPayments,
        increment.acceptedPayments,
        'acceptedPayments.total',
      ),
      completedPayments: checkedAdd(
        current.completedPayments,
        increment.completedPayments,
        'completedPayments.total',
      ),
      matchedSwaps: checkedAdd(current.matchedSwaps, increment.matchedSwaps, 'matchedSwaps.total'),
      updatedAtRuntimeHeight: runtimeHeight,
    });
  }
};
