import type { Env, RoutedEntityInput } from '../types';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildRouteOutputKey } from './output-routing';

const OUTPUT_RETRY_DOMAIN = 'xln.durable-output-retry.v1';
const OUTPUT_HASH_PATTERN = /^xln\.durable-output-retry\.v1:0x[0-9a-f]{64}$/;

const hashOutput = (output: RoutedEntityInput): string =>
  `${OUTPUT_RETRY_DOMAIN}:${keccak256(toUtf8Bytes(buildRouteOutputKey(output))).toLowerCase()}`;

const indexOutputs = (
  outputs: readonly RoutedEntityInput[],
): Map<string, string> => new Map(outputs.map(output => [hashOutput(output), buildRouteOutputKey(output)]));

const requireSafeNonNegativeInteger = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
};

export type DurableOutputRetryState = {
  outputHash: string;
  attempts: number;
  retryAt: number;
  manual?: true;
};

export const validateDurableOutputRetryState = (
  value: unknown,
  outputs: readonly RoutedEntityInput[],
  code: string,
): DurableOutputRetryState[] => {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(code);
  const outputRoutes = indexOutputs(outputs);
  const seen = new Set<string>();
  const entries = value.map((raw, index): DurableOutputRetryState => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${code}:${index}`);
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'attempts,outputHash,retryAt' &&
      keys.join(',') !== 'attempts,manual,outputHash,retryAt') throw new Error(`${code}:${index}:FIELDS`);
    const outputHash = typeof record['outputHash'] === 'string' ? record['outputHash'] : '';
    if (!OUTPUT_HASH_PATTERN.test(outputHash) || seen.has(outputHash)) {
      throw new Error(`${code}:${index}:OUTPUT_HASH`);
    }
    if (!outputRoutes.has(outputHash)) throw new Error(`${code}:${index}:ORPHAN_OUTPUT`);
    seen.add(outputHash);
    const manual = record['manual'];
    if (manual !== undefined && manual !== true) throw new Error(`${code}:${index}:MANUAL`);
    return {
      outputHash,
      attempts: requireSafeNonNegativeInteger(record['attempts'], `${code}:${index}:ATTEMPTS`),
      retryAt: requireSafeNonNegativeInteger(record['retryAt'], `${code}:${index}:RETRY_AT`),
      ...(manual === true ? { manual: true } : {}),
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.outputHash >= entries[index]!.outputHash) throw new Error(`${code}:ORDER`);
  }
  return entries;
};

export const buildDurableOutputRetryState = (
  env: Env,
  outputs: readonly RoutedEntityInput[],
): DurableOutputRetryState[] => outputs.flatMap(output => {
  const liveRouteKey = buildRouteOutputKey(output);
  const meta = env.runtimeState?.deferredNetworkMeta?.get(liveRouteKey);
  return meta ? [{
    outputHash: hashOutput(output),
    attempts: meta.attempts,
    retryAt: meta.nextRetryAt,
    ...(meta.manual ? { manual: true as const } : {}),
  }] : [];
}).sort((left, right) => left.outputHash.localeCompare(right.outputHash));

export const restoreDurableOutputRetryState = (
  env: Env,
  entries: readonly DurableOutputRetryState[],
  outputs: readonly RoutedEntityInput[],
): void => {
  if (!env.runtimeState) env.runtimeState = {};
  if (entries.length === 0) {
    delete env.runtimeState.deferredNetworkMeta;
    return;
  }
  const outputRoutes = indexOutputs(outputs);
  const restored = new Map<string, { attempts: number; nextRetryAt: number; manual?: true }>();
  for (const entry of entries) {
    const liveRouteKey = outputRoutes.get(entry.outputHash);
    if (!liveRouteKey) throw new Error(`RUNTIME_OUTPUT_RETRY_STATE_ORPHAN:${entry.outputHash}`);
    restored.set(liveRouteKey, {
      attempts: entry.attempts,
      nextRetryAt: entry.retryAt,
      ...(entry.manual ? { manual: true as const } : {}),
    });
  }
  env.runtimeState.deferredNetworkMeta = restored;
};
