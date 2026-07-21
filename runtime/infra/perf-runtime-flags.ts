import { readRuntimeEnv } from '../machine/platform';

/**
 * Runtime profiling is operational instrumentation, never consensus state.
 * Reading the flag at the observation boundary lets headless browser QA enable
 * one causal window without rebuilding the runtime bundle or profiling every
 * bootstrap frame.
 */
export const isRuntimePerfProfileEnabled = (...scopes: string[]): boolean =>
  scopes.some((scope) => readRuntimeEnv(scope) === '1') ||
  readRuntimeEnv('XLN_RUNTIME_PROCESS_PROFILE') === '1';

export const readRuntimePerfSlowMs = (scope: string, fallbackMs: number): number => {
  const configured = Number(readRuntimeEnv(scope) ?? fallbackMs);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallbackMs;
};
