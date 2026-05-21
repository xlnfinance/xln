import type { Env } from './types';
import { runtimeIsBrowser } from './runtime-platform';

export type RuntimeCleanLogDeps = {
  ensureRuntimeState: (env: Env) => NonNullable<Env['runtimeState']>;
};

const getCleanLogBuffer = (env: Env, deps: RuntimeCleanLogDeps): string[] => {
  const state = deps.ensureRuntimeState(env);
  if (!state.cleanLogs) state.cleanLogs = [];
  return state.cleanLogs;
};

export const getRuntimeCleanLogs = (env: Env, deps: RuntimeCleanLogDeps): string =>
  getCleanLogBuffer(env, deps).join('\n');

export const clearRuntimeCleanLogs = (env: Env, deps: RuntimeCleanLogDeps): void => {
  const buffer = getCleanLogBuffer(env, deps);
  buffer.length = 0;
};

export const copyRuntimeCleanLogs = async (env: Env, deps: RuntimeCleanLogDeps): Promise<string> => {
  const text = getRuntimeCleanLogs(env, deps);
  if (runtimeIsBrowser && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      console.log(`✅ Copied ${getCleanLogBuffer(env, deps).length} log entries to clipboard`);
    } catch {
      // Clipboard can fail when devtools has focus; callers still receive text.
    }
  }
  return text;
};
