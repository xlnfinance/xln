import type { Env, RoutedEntityInput } from '../types';
import { buildRouteOutputKey } from './output-routing';

export type RuntimeOutputRetryFenceEntry = {
  routeKey: string;
  attempts: number;
  nextRetryAt: number;
};

const requireSafeNonNegativeInteger = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
};

export const validateRuntimeOutputRetryFence = (
  value: unknown,
  code: string,
): RuntimeOutputRetryFenceEntry[] => {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(code);
  const seen = new Set<string>();
  const entries = value.map((raw, index): RuntimeOutputRetryFenceEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${code}:${index}`);
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'attempts,nextRetryAt,routeKey') throw new Error(`${code}:${index}:FIELDS`);
    const routeKey = typeof record['routeKey'] === 'string' ? record['routeKey'] : '';
    if (!routeKey || routeKey.length > 8_192 || seen.has(routeKey)) throw new Error(`${code}:${index}:ROUTE_KEY`);
    seen.add(routeKey);
    return {
      routeKey,
      attempts: requireSafeNonNegativeInteger(record['attempts'], `${code}:${index}:ATTEMPTS`),
      nextRetryAt: requireSafeNonNegativeInteger(record['nextRetryAt'], `${code}:${index}:NEXT_RETRY_AT`),
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.routeKey >= entries[index]!.routeKey) throw new Error(`${code}:ORDER`);
  }
  return entries;
};

export const buildRuntimeOutputRetryFence = (
  env: Env,
  outputs: readonly RoutedEntityInput[],
): RuntimeOutputRetryFenceEntry[] => outputs.flatMap(output => {
  const routeKey = buildRouteOutputKey(output);
  const meta = env.runtimeState?.deferredNetworkMeta?.get(routeKey);
  return meta ? [{ routeKey, attempts: meta.attempts, nextRetryAt: meta.nextRetryAt }] : [];
}).sort((left, right) => left.routeKey.localeCompare(right.routeKey));

export const assertRuntimeOutputRetryFenceMatchesOutputs = (
  entries: readonly RuntimeOutputRetryFenceEntry[],
  outputs: readonly RoutedEntityInput[],
  code: string,
): void => {
  const outputKeys = new Set(outputs.map(buildRouteOutputKey));
  for (const entry of entries) {
    if (!outputKeys.has(entry.routeKey)) throw new Error(`${code}:ORPHAN:${entry.routeKey}`);
  }
};

export const applyRuntimeOutputRetryFence = (
  env: Env,
  entries: readonly RuntimeOutputRetryFenceEntry[],
): void => {
  if (!env.runtimeState) env.runtimeState = {};
  if (entries.length === 0) {
    delete env.runtimeState.deferredNetworkMeta;
    return;
  }
  env.runtimeState.deferredNetworkMeta = new Map(entries.map(entry => [
    entry.routeKey,
    { attempts: entry.attempts, nextRetryAt: entry.nextRetryAt },
  ]));
};
